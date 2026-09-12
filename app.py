from __future__ import annotations

import hmac
import json
import os
import queue
import re
import secrets
import shutil
import subprocess
import threading
import time
import uuid
from pathlib import Path
from typing import Any

from fastapi import FastAPI, File, Form, HTTPException, Request, UploadFile
from fastapi.responses import FileResponse, JSONResponse
from fastapi.staticfiles import StaticFiles

BASE_DIR = Path(__file__).resolve().parent
STATIC_DIR = BASE_DIR / "static"
STORAGE_ROOT = Path(os.getenv("FRAMEX_STORAGE", "/workspace/framex" if Path("/workspace").exists() else BASE_DIR / "storage"))
UPLOAD_DIR = STORAGE_ROOT / "uploads"
OUTPUT_DIR = STORAGE_ROOT / "outputs"
JOB_FILE = STORAGE_ROOT / "jobs.json"
UPLOAD_DIR.mkdir(parents=True, exist_ok=True)
OUTPUT_DIR.mkdir(parents=True, exist_ok=True)

MAX_UPLOAD_BYTES = int(os.getenv("MAX_UPLOAD_BYTES", str(3 * 1024 * 1024 * 1024)))
OUTPUT_TTL_HOURS = int(os.getenv("OUTPUT_TTL_HOURS", "24"))
DELETE_INPUT_AFTER_DONE = os.getenv("DELETE_INPUT_AFTER_DONE", "1") == "1"
PREFER_NVENC = os.getenv("PREFER_NVENC", "1") == "1"
X264_PRESET = os.getenv("X264_PRESET", "medium")
X264_CRF = os.getenv("X264_CRF", "18")
ALLOWED_EXTS = {".mp4", ".mov", ".m4v", ".webm", ".mkv"}
CHUNK_BYTES = int(os.getenv("UPLOAD_CHUNK_BYTES", str(8 * 1024 * 1024)))
APP_PIN = os.getenv("APP_PIN", "").strip()
SESSION_TTL = int(os.getenv("SESSION_TTL_SECONDS", str(7 * 24 * 3600)))
COOKIE_SECURE = os.getenv("COOKIE_SECURE", "1") == "1"

app = FastAPI(title="FrameX Cloud Mobile", version="0.2.0")
lock = threading.RLock()
jobs: dict[str, dict[str, Any]] = {}
job_queue: queue.Queue[str] = queue.Queue()
worker_started = False
upload_sessions: dict[str, dict[str, Any]] = {}
auth_sessions: dict[str, int] = {}


def session_ok(token: str | None) -> bool:
    if not APP_PIN:
        return True
    if not token:
        return False
    exp = auth_sessions.get(token, 0)
    if exp < int(time.time()):
        auth_sessions.pop(token, None)
        return False
    return True


@app.middleware("http")
async def auth_middleware(request: Request, call_next):
    path = request.url.path
    if APP_PIN and path.startswith("/api/") and not path.startswith("/api/auth/") and path != "/api/health":
        if not session_ok(request.cookies.get("framex_session")):
            return JSONResponse({"detail": "يلزم تسجيل الدخول"}, status_code=401)
    return await call_next(request)


@app.get("/api/auth/status")
def auth_status(request: Request) -> dict[str, Any]:
    return {"required": bool(APP_PIN), "authenticated": session_ok(request.cookies.get("framex_session"))}


@app.post("/api/auth/login")
async def auth_login(request: Request):
    data = await request.json()
    pin = str(data.get("pin", ""))
    if not APP_PIN or hmac.compare_digest(pin, APP_PIN):
        token = secrets.token_urlsafe(32)
        auth_sessions[token] = int(time.time()) + SESSION_TTL
        res = JSONResponse({"ok": True})
        res.set_cookie("framex_session", token, max_age=SESSION_TTL, httponly=True, secure=COOKIE_SECURE, samesite="lax")
        return res
    raise HTTPException(401, "الرمز غير صحيح")


@app.post("/api/auth/logout")
def auth_logout(request: Request):
    tok = request.cookies.get("framex_session")
    if tok:
        auth_sessions.pop(tok, None)
    res = JSONResponse({"ok": True})
    res.delete_cookie("framex_session")
    return res


def save_jobs() -> None:
    JOB_FILE.parent.mkdir(parents=True, exist_ok=True)
    tmp = JOB_FILE.with_suffix(".tmp")
    tmp.write_text(json.dumps(jobs, ensure_ascii=False, indent=2), encoding="utf-8")
    tmp.replace(JOB_FILE)


def load_jobs() -> None:
    global jobs
    if JOB_FILE.exists():
        try:
            jobs = json.loads(JOB_FILE.read_text(encoding="utf-8"))
        except Exception:
            jobs = {}
    for j in jobs.values():
        if j.get("status") in {"queued", "processing"}:
            j["status"] = "failed"
            j["message"] = "توقفت المهمة بسبب إعادة تشغيل الخادم. ارفع الفيديو مرة أخرى."
    save_jobs()


def update_job(job_id: str, **changes: Any) -> None:
    with lock:
        if job_id in jobs:
            jobs[job_id].update(changes)
            save_jobs()


def run_cmd(args: list[str]) -> subprocess.CompletedProcess:
    return subprocess.run(args, capture_output=True, text=True, check=False)


def ffmpeg_available() -> bool:
    return shutil.which("ffmpeg") is not None and shutil.which("ffprobe") is not None


def probe_video(path: Path) -> dict[str, Any]:
    result = run_cmd([
        "ffprobe", "-v", "error", "-select_streams", "v:0",
        "-show_entries", "stream=width,height,r_frame_rate,avg_frame_rate,codec_name,pix_fmt:format=duration,size",
        "-of", "json", str(path),
    ])
    if result.returncode != 0:
        raise RuntimeError(result.stderr.strip() or "تعذر قراءة معلومات الفيديو")
    data = json.loads(result.stdout)
    streams = data.get("streams") or []
    if not streams:
        raise RuntimeError("الملف لا يحتوي على فيديو")
    stream, fmt = streams[0], data.get("format") or {}

    def frac(v: str | None) -> float:
        if not v or v == "0/0":
            return 0.0
        if "/" in v:
            a, b = v.split("/", 1)
            try:
                return float(a) / float(b)
            except (ValueError, ZeroDivisionError):
                return 0.0
        try:
            return float(v)
        except ValueError:
            return 0.0

    return {
        "width": int(stream.get("width") or 0),
        "height": int(stream.get("height") or 0),
        "fps": round(frac(stream.get("avg_frame_rate") or stream.get("r_frame_rate")), 3),
        "duration": round(float(fmt.get("duration") or 0), 3),
        "size": int(fmt.get("size") or path.stat().st_size),
        "codec": stream.get("codec_name") or "unknown",
        "pix_fmt": stream.get("pix_fmt") or "unknown",
    }


def choose_target(quality: str) -> tuple[int, int]:
    return {"1080": (1080, 1920), "2k": (1440, 2560), "4k": (2160, 3840)}[quality]


def build_filter(meta: dict[str, Any], quality: str, target_fps: int, enhance: bool, layout: str) -> str:
    tw, th = choose_target(quality)
    filters: list[str] = []
    if enhance:
        filters.extend(["hqdn3d=1.0:1.0:4.0:4.0", "eq=contrast=1.02:saturation=1.035:brightness=0.004"])

    src_fps = float(meta.get("fps") or 0)
    if target_fps > src_fps + 0.5:
        filters.append(f"minterpolate=fps={target_fps}:mi_mode=mci:mc_mode=aobmc:me_mode=bilat:vsbmc=1")
    else:
        filters.append(f"fps={target_fps}")

    if layout == "fit":
        filters.append(f"scale={tw}:{th}:force_original_aspect_ratio=decrease:flags=lanczos")
        filters.append(f"pad={tw}:{th}:(ow-iw)/2:(oh-ih)/2:black")
    else:
        filters.append(f"scale={tw}:{th}:force_original_aspect_ratio=increase:flags=lanczos")
        filters.append(f"crop={tw}:{th}")

    if enhance:
        filters.append("unsharp=5:5:0.28:5:5:0.0")
    filters.append("format=yuv420p")
    return ",".join(filters)


def has_encoder(name: str) -> bool:
    result = run_cmd(["ffmpeg", "-hide_banner", "-encoders"])
    return result.returncode == 0 and re.search(rf"\b{re.escape(name)}\b", result.stdout) is not None


_nvenc_cache: bool | None = None


def nvenc_usable() -> bool:
    global _nvenc_cache
    if _nvenc_cache is not None:
        return _nvenc_cache
    if not PREFER_NVENC or not has_encoder("h264_nvenc"):
        _nvenc_cache = False
        return False
    test = run_cmd([
        "ffmpeg", "-hide_banner", "-loglevel", "error",
        "-f", "lavfi", "-i", "color=size=64x64:rate=1",
        "-frames:v", "1", "-c:v", "h264_nvenc", "-f", "null", "-",
    ])
    _nvenc_cache = test.returncode == 0
    return _nvenc_cache


def encoder_args() -> list[str]:
    if nvenc_usable():
        return ["-c:v", "h264_nvenc", "-preset", "p5", "-tune", "hq", "-rc", "vbr", "-cq", "18", "-b:v", "0"]
    return ["-c:v", "libx264", "-preset", X264_PRESET, "-crf", X264_CRF]


def process_job(job_id: str) -> None:
    job = jobs[job_id]
    input_path = Path(job["input_path"])
    output_path = Path(job["output_path"])
    try:
        update_job(job_id, status="processing", progress=1, message="تحليل الفيديو…")
        meta = probe_video(input_path)
        update_job(job_id, input_meta=meta, message="بدء تحسين الفيديو…")
        vf = build_filter(meta, job["quality"], int(job["fps"]), bool(job["enhance"]), job["layout"])
        cmd = [
            "ffmpeg", "-y", "-hide_banner", "-nostats", "-i", str(input_path),
            "-map", "0:v:0", "-map", "0:a?", "-vf", vf,
            *encoder_args(),
            "-c:a", "aac", "-b:a", "192k", "-ar", "48000",
            "-movflags", "+faststart", "-metadata", "comment=FrameX Cloud Mobile",
            "-progress", "pipe:1", str(output_path),
        ]
        proc = subprocess.Popen(cmd, stdout=subprocess.PIPE, stderr=subprocess.PIPE, text=True, bufsize=1)
        duration = max(float(meta.get("duration") or 0), 0.001)
        if proc.stdout:
            for line in proc.stdout:
                line = line.strip()
                if line.startswith("out_time_us="):
                    try:
                        out_us = int(line.split("=", 1)[1])
                        pct = min(99, max(2, int((out_us / 1_000_000) / duration * 100)))
                        update_job(job_id, progress=pct, message=f"جاري التحسين… {pct}%")
                    except ValueError:
                        pass
        stderr = proc.stderr.read() if proc.stderr else ""
        code = proc.wait()
        if code != 0:
            raise RuntimeError(stderr[-2200:] or "فشلت المعالجة")
        out_meta = probe_video(output_path)
        update_job(
            job_id, status="done", progress=100, message="الفيديو جاهز ✅",
            output_meta=out_meta, output_size=output_path.stat().st_size,
            engine="NVENC" if nvenc_usable() else "x264",
            finished_at=int(time.time()),
        )
    except Exception as exc:
        output_path.unlink(missing_ok=True)
        update_job(job_id, status="failed", progress=0, message=f"فشل: {exc}", finished_at=int(time.time()))
    finally:
        if DELETE_INPUT_AFTER_DONE:
            input_path.unlink(missing_ok=True)


def queue_worker() -> None:
    while True:
        job_id = job_queue.get()
        try:
            if job_id in jobs:
                process_job(job_id)
        finally:
            job_queue.task_done()


def cleanup_loop() -> None:
    while True:
        cutoff = time.time() - OUTPUT_TTL_HOURS * 3600
        with lock:
            changed = False
            for jid, j in list(jobs.items()):
                if j.get("status") in {"done", "failed"} and int(j.get("finished_at") or j.get("created_at") or 0) < cutoff:
                    Path(j.get("output_path", "")).unlink(missing_ok=True)
                    Path(j.get("input_path", "")).unlink(missing_ok=True)
                    jobs.pop(jid, None)
                    changed = True
            if changed:
                save_jobs()
        time.sleep(1800)


def start_workers() -> None:
    global worker_started
    if worker_started:
        return
    threading.Thread(target=queue_worker, daemon=True).start()
    threading.Thread(target=cleanup_loop, daemon=True).start()
    worker_started = True


@app.on_event("startup")
def startup() -> None:
    load_jobs()
    start_workers()


@app.get("/api/health")
def health() -> dict[str, Any]:
    ff_ok = ffmpeg_available()
    return {
        "ok": ff_ok,
        "cloud": True,
        "gpu_encode": nvenc_usable() if ff_ok else False,
        "engine": "FFmpeg motion interpolation + Lanczos upscale",
        "ai_upscale": False,
        "ai_interpolation": False,
        "storage": str(STORAGE_ROOT),
        "output_ttl_hours": OUTPUT_TTL_HOURS,
    }


@app.post("/api/uploads/init")
async def init_upload(request: Request) -> dict[str, Any]:
    data = await request.json()
    filename = str(data.get("filename") or "video.mp4")
    total_size = int(data.get("size") or 0)
    suffix = Path(filename).suffix.lower()
    if suffix not in ALLOWED_EXTS:
        raise HTTPException(400, "صيغة الفيديو غير مدعومة")
    if total_size <= 0 or total_size > MAX_UPLOAD_BYTES:
        raise HTTPException(413, "حجم الفيديو غير مسموح")
    upload_id = uuid.uuid4().hex[:16]
    path = UPLOAD_DIR / f"upload_{upload_id}{suffix}.part"
    upload_sessions[upload_id] = {
        "id": upload_id, "filename": filename, "size": total_size, "suffix": suffix,
        "path": str(path), "received": 0, "next_index": 0, "created_at": int(time.time()),
    }
    path.unlink(missing_ok=True)
    return {"upload_id": upload_id, "chunk_size": CHUNK_BYTES}


@app.post("/api/uploads/{upload_id}/chunk")
async def upload_chunk(upload_id: str, index: int = Form(...), chunk: UploadFile = File(...)) -> dict[str, Any]:
    sess = upload_sessions.get(upload_id)
    if not sess:
        raise HTTPException(404, "جلسة الرفع غير موجودة")
    if index != int(sess["next_index"]):
        raise HTTPException(409, "ترتيب أجزاء الفيديو غير صحيح")
    data = await chunk.read(CHUNK_BYTES + 1024)
    await chunk.close()
    if len(data) > CHUNK_BYTES:
        raise HTTPException(413, "جزء الرفع أكبر من المسموح")
    path = Path(sess["path"])
    with path.open("ab") as f:
        f.write(data)
    sess["received"] += len(data)
    sess["next_index"] += 1
    if sess["received"] > sess["size"]:
        path.unlink(missing_ok=True)
        upload_sessions.pop(upload_id, None)
        raise HTTPException(400, "حجم الرفع غير صحيح")
    return {"received": sess["received"], "size": sess["size"], "next_index": sess["next_index"]}


@app.post("/api/uploads/{upload_id}/finish")
async def finish_upload(
    upload_id: str,
    quality: str = Form("4k"),
    fps: int = Form(60),
    enhance: bool = Form(True),
    layout: str = Form("fill"),
) -> dict[str, Any]:
    if not ffmpeg_available():
        raise HTTPException(503, "محرك الفيديو غير جاهز على الخادم")
    if quality not in {"1080", "2k", "4k"}:
        raise HTTPException(400, "الجودة غير مدعومة")
    if fps not in {30, 60}:
        raise HTTPException(400, "معدل الإطارات يجب أن يكون 30 أو 60")
    if layout not in {"fill", "fit"}:
        raise HTTPException(400, "طريقة العرض غير مدعومة")
    sess = upload_sessions.get(upload_id)
    if not sess:
        raise HTTPException(404, "جلسة الرفع غير موجودة")
    if int(sess["received"]) != int(sess["size"]):
        raise HTTPException(409, "رفع الفيديو لم يكتمل")

    jid = uuid.uuid4().hex[:12]
    input_path = UPLOAD_DIR / f"{jid}{sess['suffix']}"
    Path(sess["path"]).replace(input_path)
    upload_sessions.pop(upload_id, None)
    output_path = OUTPUT_DIR / f"FrameX_{jid}_{quality}_{fps}fps.mp4"
    try:
        meta = probe_video(input_path)
    except Exception as exc:
        input_path.unlink(missing_ok=True)
        raise HTTPException(400, f"تعذر قراءة الفيديو: {exc}") from exc

    with lock:
        jobs[jid] = {
            "id": jid, "status": "queued", "progress": 0,
            "message": "الفيديو في قائمة المعالجة…", "created_at": int(time.time()),
            "quality": quality, "fps": fps, "enhance": enhance, "layout": layout,
            "input_name": sess["filename"], "input_meta": meta,
            "input_path": str(input_path), "output_path": str(output_path),
        }
        save_jobs()
    job_queue.put(jid)
    return {k: v for k, v in jobs[jid].items() if k not in {"input_path", "output_path"}}


@app.get("/api/jobs/{job_id}")
def get_job(job_id: str) -> dict[str, Any]:
    j = jobs.get(job_id)
    if not j:
        raise HTTPException(404, "المهمة غير موجودة")
    return {k: v for k, v in j.items() if k not in {"input_path", "output_path"}}


@app.get("/api/jobs/{job_id}/download")
def download(job_id: str):
    j = jobs.get(job_id)
    if not j:
        raise HTTPException(404, "المهمة غير موجودة")
    if j.get("status") != "done":
        raise HTTPException(409, "المعالجة لم تكتمل")
    path = Path(j["output_path"])
    if not path.exists():
        raise HTTPException(404, "انتهت مدة حفظ الفيديو. أعد المعالجة.")
    return FileResponse(path, media_type="video/mp4", filename=path.name)


app.mount("/", StaticFiles(directory=STATIC_DIR, html=True), name="static")
