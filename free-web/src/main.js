import './style.css';

const $ = (id) => document.getElementById(id);
const base = import.meta.env.BASE_URL;

let engine = null;
let engineLoaded = false;
let coreScriptPromise = null;
let selectedFile = null;
let selectedPreset = 'tiktokSmooth60';
let sourceMeta = { duration: 0, width: 0, height: 0 };
let outputUrl = null;
let resultBlob = null;
let resultExt = 'mp4';
let resultMime = 'video/mp4';
let cancelled = false;
let currentStage = 'idle';
let lastLog = '';
let wakeLock = null;

const els = {
  file: $('videoFile'), fileInfo: $('fileInfo'), start: $('startBtn'), cancel: $('cancelBtn'),
  status: $('statusCard'), statusText: $('statusText'), statusPct: $('statusPct'), detail: $('statusDetail'),
  bar: $('progressBar'), result: $('resultCard'), resultVideo: $('resultVideo'), resultInfo: $('resultInfo'),
  download: $('downloadBtn'), share: $('shareTikTokBtn'), framing: $('framing'), sharpness: $('sharpness')
};

if ('serviceWorker' in navigator) {
  window.addEventListener('load', async () => {
    try {
      const reg = await navigator.serviceWorker.register(`${base}sw.js?v=5`);
      reg.update().catch(() => {});
    } catch {}
  });
}

document.querySelectorAll('.preset').forEach((btn) => {
  btn.addEventListener('click', () => choosePreset(btn.dataset.preset));
});

function choosePreset(name) {
  selectedPreset = name;
  document.querySelectorAll('.preset').forEach((x) => x.classList.toggle('active', x.dataset.preset === name));
}

els.file.addEventListener('change', async () => {
  selectedFile = els.file.files?.[0] || null;
  clearResult();
  if (!selectedFile) {
    els.fileInfo.classList.add('hidden');
    els.start.disabled = true;
    return;
  }
  sourceMeta = await readVideoMeta(selectedFile);
  els.fileInfo.innerHTML = `<strong>${escapeHtml(selectedFile.name)}</strong><br>${formatBytes(selectedFile.size)} • ${sourceMeta.width || '?'}×${sourceMeta.height || '?'} • ${formatDuration(sourceMeta.duration)}`;
  els.fileInfo.classList.remove('hidden');
  els.start.disabled = false;
});

els.start.addEventListener('click', async () => {
  if (!selectedFile) return;
  if (selectedPreset === 'tiktokSmooth60') await processTikTokSmooth60();
  else await processFFmpegMotion();
});

els.cancel.addEventListener('click', () => {
  cancelled = true;
  setStatus('جاري إلغاء المعالجة…', 0, 'انتظر لحظة حتى يتوقف المحرك.');
});

els.share?.addEventListener('click', shareToTikTok);

async function processTikTokSmooth60() {
  const validation = validateStreaming();
  if (validation) { alert(validation); return; }
  if (!HTMLCanvasElement.prototype.captureStream || typeof MediaRecorder === 'undefined') {
    alert('المتصفح الحالي لا يدعم محرك الفيديو الطويل. افتح FrameX في Safari أو Chrome المحدث.');
    return;
  }

  cancelled = false;
  clearResult();
  setBusy(true);
  currentStage = 'stream-engine';
  await requestWakeLock();

  const srcUrl = URL.createObjectURL(selectedFile);
  const video = document.createElement('video');
  video.src = srcUrl;
  video.preload = 'auto';
  video.playsInline = true;
  video.setAttribute('playsinline', '');
  video.style.position = 'fixed';
  video.style.width = '1px';
  video.style.height = '1px';
  video.style.opacity = '0.001';
  video.style.pointerEvents = 'none';
  document.body.appendChild(video);

  let audioCtx = null;
  let prevFrame = null;
  let renderTail = Promise.resolve();
  let frameCallbackId = null;

  try {
    setStatus('تحضير TikTok Smooth 60', 1, 'يتم تجهيز محرك 60FPS الحقيقي داخل الجوال.');
    await waitEvent(video, 'loadedmetadata', 20000);

    const W = 1080, H = 1920, targetFps = 60;
    const canvas = document.createElement('canvas');
    canvas.width = W; canvas.height = H;
    const ctx = canvas.getContext('2d', { alpha: false, desynchronized: true });
    ctx.imageSmoothingEnabled = true;
    ctx.imageSmoothingQuality = 'high';

    const canvasStream = canvas.captureStream(targetFps);
    const tracks = [...canvasStream.getVideoTracks()];

    try {
      const AC = window.AudioContext || window.webkitAudioContext;
      if (AC) {
        audioCtx = new AC();
        await audioCtx.resume();
        const sourceNode = audioCtx.createMediaElementSource(video);
        const audioDest = audioCtx.createMediaStreamDestination();
        sourceNode.connect(audioDest);
        tracks.push(...audioDest.stream.getAudioTracks());
      }
    } catch (e) {
      console.warn('Audio capture fallback:', e);
    }

    const combined = new MediaStream(tracks);
    const mimeType = pickRecorderMime();
    if (!mimeType) throw new Error('MEDIARECORDER_CODEC_UNSUPPORTED');
    resultMime = mimeType.split(';')[0];
    resultExt = resultMime.includes('mp4') ? 'mp4' : 'webm';

    const recorder = new MediaRecorder(combined, {
      mimeType,
      videoBitsPerSecond: 12_000_000,
      audioBitsPerSecond: 192_000
    });
    const chunks = [];
    recorder.ondataavailable = (e) => { if (e.data && e.data.size) chunks.push(e.data); };
    const stopped = new Promise((resolve, reject) => {
      recorder.onstop = resolve;
      recorder.onerror = (e) => reject(e.error || new Error('MEDIARECORDER_ERROR'));
    });

    const drawSingle = (bitmap, alpha = 1) => {
      ctx.save();
      ctx.globalAlpha = alpha;
      ctx.filter = els.sharpness.value === 'off' ? 'contrast(1.02) saturate(1.03)' : 'contrast(1.035) saturate(1.045)';
      drawFramed(ctx, bitmap, W, H, els.framing.value);
      ctx.restore();
    };

    const drawBlend = (a, b, alpha) => {
      ctx.fillStyle = '#000';
      ctx.fillRect(0, 0, W, H);
      ctx.save();
      ctx.filter = els.sharpness.value === 'off' ? 'contrast(1.02) saturate(1.03)' : 'contrast(1.035) saturate(1.045)';
      ctx.globalAlpha = 1;
      drawFramed(ctx, a, W, H, els.framing.value);
      ctx.globalAlpha = alpha;
      drawFramed(ctx, b, W, H, els.framing.value);
      ctx.restore();
    };

    const onVideoFrame = async (_now, metadata = {}) => {
      if (cancelled || video.ended) return;
      let bitmap;
      try { bitmap = await createImageBitmap(video); } catch { return; }
      const mediaTime = Number(metadata.mediaTime ?? video.currentTime ?? 0);

      if (!prevFrame) {
        prevFrame = { bitmap, time: mediaTime };
        drawSingle(bitmap);
      } else {
        const previous = prevFrame;
        const current = { bitmap, time: mediaTime };
        prevFrame = current;
        renderTail = renderTail.then(async () => {
          const dt = Math.max(1 / 60, Math.min(0.15, current.time - previous.time || 1 / 30));
          const steps = Math.max(1, Math.min(6, Math.round(dt * 60)));
          const delay = (dt * 1000) / steps;
          for (let i = 0; i < steps && !cancelled; i++) {
            const alpha = i / steps;
            if (alpha <= 0.001) drawSingle(previous.bitmap);
            else drawBlend(previous.bitmap, current.bitmap, alpha);
            await sleep(delay);
          }
          try { previous.bitmap.close?.(); } catch {}
        });
      }

      const pct = Math.min(97, Math.max(2, (video.currentTime / Math.max(0.1, video.duration)) * 97));
      setStatus('TikTok Smooth 60 — توليد إطارات وسطية', pct, `جاري إنشاء إطارات حقيقية بين الإطارات الأصلية • ${formatDuration(video.currentTime)} / ${formatDuration(video.duration)}`);
      frameCallbackId = video.requestVideoFrameCallback(onVideoFrame);
    };

    recorder.start(1000);
    if (typeof video.requestVideoFrameCallback === 'function') {
      frameCallbackId = video.requestVideoFrameCallback(onVideoFrame);
    } else {
      recorder.stop();
      throw new Error('VIDEO_FRAME_CALLBACK_UNSUPPORTED');
    }

    const ended = waitEvent(video, 'ended', Math.max(60000, (video.duration + 30) * 1000));
    await video.play();
    await ended;
    await renderTail;
    if (prevFrame?.bitmap) {
      drawSingle(prevFrame.bitmap);
      await sleep(100);
      try { prevFrame.bitmap.close?.(); } catch {}
    }

    if (cancelled) throw new Error('USER_CANCELLED');
    recorder.stop();
    await stopped;
    combined.getTracks().forEach((t) => t.stop());

    resultBlob = new Blob(chunks, { type: resultMime });
    finishResult(resultBlob, `TikTok HQ • 1080×1920 • Smooth 60 • ${formatBytes(resultBlob.size)}`);
    setStatus('جاهز لتيك توك ✅', 100, resultExt === 'mp4' ? 'تم الإخراج MP4 بجودة عالية. اضغط مشاركة إلى TikTok.' : 'تم الإخراج WebM عالي الجودة. TikTok يدعم WebM، ويمكنك مشاركته من الزر أدناه.');
  } catch (err) {
    console.error(err);
    if (String(err?.message || err).includes('USER_CANCELLED')) setStatus('تم إلغاء المعالجة', 0, 'يمكنك البدء من جديد.');
    else setStatus('تعذرت معالجة Smooth 60', 0, streamingError(err));
  } finally {
    try { if (frameCallbackId && video.cancelVideoFrameCallback) video.cancelVideoFrameCallback(frameCallbackId); } catch {}
    try { prevFrame?.bitmap?.close?.(); } catch {}
    try { video.pause(); } catch {}
    try { video.remove(); } catch {}
    try { await audioCtx?.close?.(); } catch {}
    URL.revokeObjectURL(srcUrl);
    await releaseWakeLock();
    setBusy(false);
  }
}

async function processFFmpegMotion() {
  const validation = validateFFmpeg();
  if (validation) { alert(validation); return; }
  cancelled = false;
  clearResult();
  setBusy(true);
  lastLog = '';
  await requestWakeLock();

  try {
    currentStage = 'engine';
    await ensureEngine();
    currentStage = 'input';
    setStatus('إدخال الفيديو إلى Motion Engine', 4, 'هذا الوضع يحلل الحركة بين الإطارات؛ قد يكون أبطأ لكنه أنعم.');
    const ext = (selectedFile.name.split('.').pop() || 'mp4').replace(/[^a-z0-9]/gi, '').toLowerCase() || 'mp4';
    const input = `input.${ext}`;
    const output = 'framex-tiktok.mp4';
    safeDelete(input); safeDelete(output);
    engine.FS.writeFile(input, new Uint8Array(await selectedFile.arrayBuffer()));

    const cfg = motionConfig();
    currentStage = 'encode';
    setStatus(cfg.title, 8, 'تحليل اتجاه الحركة وإنشاء إطارات جديدة — هذا هو 60FPS الفعلي الأقوى.');
    let code = runMotionEncode(input, output, cfg.filter, true);
    if (code !== 0 && cfg.fallbackFilter) {
      safeDelete(output);
      setStatus('تشغيل Smooth 60 المتوافق', 10, 'Motion Compensation غير متاح؛ نستخدم Frame Interpolation بالمزج بدل تكرار الإطارات.');
      code = runMotionEncode(input, output, cfg.fallbackFilter, true);
    }
    if (code !== 0) throw new Error(`FFmpeg exit code ${code}`);

    const data = engine.FS.readFile(output);
    resultMime = 'video/mp4'; resultExt = 'mp4';
    resultBlob = new Blob([data], { type: resultMime });
    finishResult(resultBlob, `${cfg.label} • TikTok HQ • ${formatBytes(resultBlob.size)}`);
    setStatus('جاهز لتيك توك ✅', 100, 'MP4/H.264 • 60FPS • جودة تصدير مرتفعة.');
    safeDelete(input); safeDelete(output);
  } catch (err) {
    console.error(err);
    setStatus('تعذرت معالجة Motion 60', 0, humanError(err));
  } finally {
    await releaseWakeLock();
    setBusy(false);
  }
}

function motionConfig() {
  const is4k = selectedPreset === 'experimental4k';
  const outW = is4k ? 2160 : 1080;
  const outH = is4k ? 3840 : 1920;
  const prepW = 720, prepH = 1280;
  const framing = els.framing.value;
  const prep = framing === 'fill'
    ? `scale=${prepW}:${prepH}:force_original_aspect_ratio=increase:flags=lanczos,crop=${prepW}:${prepH}`
    : `scale=${prepW}:${prepH}:force_original_aspect_ratio=decrease:flags=lanczos,pad=${prepW}:${prepH}:(ow-iw)/2:(oh-ih)/2:black`;
  const sharpen = els.sharpness.value === 'off' ? '' : ',unsharp=3:3:0.35:3:3:0';
  const motion = `minterpolate=fps=60:mi_mode=mci:mc_mode=aobmc:me_mode=bidir:vsbmc=1`;
  const blend = `framerate=fps=60:interp_start=0:interp_end=255:scene=100`;
  const tail = `scale=${outW}:${outH}:flags=lanczos${sharpen},format=yuv420p`;
  return {
    title: is4k ? '4K Motion 60 تجريبي' : 'Motion 60 الحقيقي • 1080p',
    label: is4k ? '2160×3840 • Motion 60' : '1080×1920 • Motion 60',
    filter: `${prep},${motion},${tail}`,
    fallbackFilter: `${prep},${blend},${tail}`
  };
}

function runMotionEncode(input, output, filter, withAudio) {
  const args = ['-i', input, '-map', '0:v:0'];
  if (withAudio) args.push('-map', '0:a?');
  args.push(
    '-vf', filter,
    '-c:v', 'libx264', '-preset', 'ultrafast', '-crf', '17',
    '-maxrate', '16M', '-bufsize', '32M', '-g', '120',
    '-r', '60', '-pix_fmt', 'yuv420p', '-threads', '1'
  );
  if (withAudio) args.push('-c:a', 'aac', '-b:a', '192k', '-ar', '48000');
  else args.push('-an');
  args.push('-movflags', '+faststart', '-y', output);
  try { engine.setTimeout?.(-1); } catch {}
  engine.exec(...args);
  const ret = Number(engine.ret ?? 0);
  try { engine.reset?.(); } catch {}
  return ret;
}

async function ensureEngine() {
  if (engineLoaded && engine) return;
  if (typeof WebAssembly === 'undefined') throw new Error('WebAssembly unavailable');
  setStatus('تحميل Motion Engine', 1, 'يتم تحميل FFmpeg المباشر بدون Module Worker.');
  const coreURL = `${base}ffmpeg/ffmpeg-core.js?v=motion5`;
  const wasmURL = `${base}ffmpeg/ffmpeg-core.wasm?v=motion5`;
  currentStage = 'engine-script';
  await loadClassicScript(coreURL);
  if (typeof window.createFFmpegCore !== 'function') throw new Error('DIRECT_CORE_GLOBAL_MISSING');
  currentStage = 'engine-wasm';
  const config = btoa(JSON.stringify({ wasmURL }));
  engine = await Promise.race([
    Promise.resolve(window.createFFmpegCore({ mainScriptUrlOrBlob: `${coreURL}#${config}` })),
    new Promise((_, reject) => setTimeout(() => reject(new Error('DIRECT_ENGINE_LOAD_TIMEOUT')), 60000))
  ]);
  if (!engine?.FS || typeof engine.exec !== 'function') throw new Error('DIRECT_CORE_INVALID');
  engine.setLogger?.(({ message }) => { if (message) lastLog = String(message).slice(-240); });
  engine.setProgress?.(({ progress }) => {
    if (!Number.isFinite(progress)) return;
    const pct = Math.min(97, Math.max(8, Math.round(progress * 89 + 8)));
    setStatus(els.statusText.textContent, pct, 'Motion Interpolation قيد المعالجة…');
  });
  engineLoaded = true;
}

function loadClassicScript(src) {
  if (typeof window.createFFmpegCore === 'function') return Promise.resolve();
  if (coreScriptPromise) return coreScriptPromise;
  coreScriptPromise = new Promise((resolve, reject) => {
    const script = document.createElement('script');
    script.src = src;
    script.async = true;
    script.onload = resolve;
    script.onerror = () => reject(new Error('DIRECT_CORE_SCRIPT_FAILED'));
    document.head.appendChild(script);
  });
  return coreScriptPromise;
}

function pickRecorderMime() {
  const types = [
    'video/mp4;codecs=avc1.42E01E,mp4a.40.2',
    'video/mp4;codecs=avc1.42E01E',
    'video/mp4',
    'video/webm;codecs=vp9,opus',
    'video/webm;codecs=vp8,opus',
    'video/webm'
  ];
  return types.find((t) => MediaRecorder.isTypeSupported(t)) || '';
}

function drawFramed(ctx, source, W, H, framing) {
  const sw = source.width || source.videoWidth || 1;
  const sh = source.height || source.videoHeight || 1;
  const scale = framing === 'fill' ? Math.max(W / sw, H / sh) : Math.min(W / sw, H / sh);
  const dw = sw * scale, dh = sh * scale;
  const dx = (W - dw) / 2, dy = (H - dh) / 2;
  if (framing === 'fit') {
    ctx.fillStyle = '#000';
    ctx.fillRect(0, 0, W, H);
  }
  ctx.drawImage(source, dx, dy, dw, dh);
}

function finishResult(blob, info) {
  if (outputUrl) URL.revokeObjectURL(outputUrl);
  outputUrl = URL.createObjectURL(blob);
  els.resultVideo.src = outputUrl;
  els.download.href = outputUrl;
  els.download.download = `FrameX-TikTok-HQ-60.${resultExt}`;
  els.resultInfo.textContent = info;
  els.result.classList.remove('hidden');
  if (els.share) els.share.classList.remove('hidden');
}

async function shareToTikTok() {
  if (!resultBlob) return;
  const file = new File([resultBlob], `FrameX-TikTok-HQ-60.${resultExt}`, { type: resultMime || resultBlob.type });
  try {
    if (navigator.canShare?.({ files: [file] }) && navigator.share) {
      await navigator.share({ files: [file], title: 'FrameX TikTok HQ', text: 'فيديو TikTok HQ — اختر TikTok من قائمة المشاركة' });
    } else {
      alert('متصفحك لا يدعم مشاركة ملف الفيديو مباشرة. اضغط «حفظ الفيديو» ثم افتح TikTok واختره من الاستديو.');
    }
  } catch (err) {
    if (err?.name !== 'AbortError') alert('تعذرت المشاركة المباشرة. احفظ الفيديو ثم افتحه من TikTok.');
  }
}

function validateStreaming() {
  const mb = selectedFile.size / 1024 / 1024;
  if (mb > 1200) return 'للتجربة من المتصفح استخدم فيديو أقل من 1.2GB.';
  if (sourceMeta.duration > 600) return 'النسخة التجريبية تدعم حتى 10 دقائق في وضع TikTok Smooth 60.';
  return '';
}

function validateFFmpeg() {
  const mb = selectedFile.size / 1024 / 1024;
  if (mb > 180) return 'Motion 60 يعمل داخل ذاكرة الجوال؛ استخدم ملفًا أقل من 180MB.';
  if (selectedPreset === 'experimental4k' && sourceMeta.duration > 5) return '4K Motion 60 التجريبي مخصص حاليًا لمقطع 5 ثوانٍ أو أقل.';
  if (selectedPreset !== 'experimental4k' && sourceMeta.duration > 30) return 'Motion 60 الأقوى مخصص حاليًا لأول 30 ثانية. للفيديو الأطول استخدم TikTok Smooth 60.';
  return '';
}

function setBusy(on) {
  els.start.disabled = on || !selectedFile;
  els.cancel.classList.toggle('hidden', !on);
}

function setStatus(text, pct, detail = '') {
  els.status.classList.remove('hidden');
  els.statusText.textContent = text;
  els.statusPct.textContent = `${Math.round(pct)}%`;
  els.bar.style.width = `${Math.max(0, Math.min(100, pct))}%`;
  els.detail.textContent = detail;
}

function clearResult() {
  if (outputUrl) URL.revokeObjectURL(outputUrl);
  outputUrl = null; resultBlob = null;
  els.result.classList.add('hidden');
  els.share?.classList.add('hidden');
  els.resultVideo.removeAttribute('src');
  els.resultVideo.load();
}

function safeDelete(name) { try { engine?.FS?.unlink(name); } catch {} }

function readVideoMeta(file) {
  return new Promise((resolve) => {
    const video = document.createElement('video');
    const url = URL.createObjectURL(file);
    video.preload = 'metadata';
    video.onloadedmetadata = () => {
      const data = { duration: Number(video.duration) || 0, width: video.videoWidth || 0, height: video.videoHeight || 0 };
      URL.revokeObjectURL(url); resolve(data);
    };
    video.onerror = () => { URL.revokeObjectURL(url); resolve({ duration: 0, width: 0, height: 0 }); };
    video.src = url;
  });
}

function waitEvent(target, name, timeoutMs) {
  return new Promise((resolve, reject) => {
    const timer = setTimeout(() => { cleanup(); reject(new Error(`${name.toUpperCase()}_TIMEOUT`)); }, timeoutMs);
    const ok = () => { cleanup(); resolve(); };
    const bad = () => { cleanup(); reject(new Error(`${name.toUpperCase()}_ERROR`)); };
    const cleanup = () => {
      clearTimeout(timer);
      target.removeEventListener(name, ok);
      target.removeEventListener('error', bad);
    };
    target.addEventListener(name, ok, { once: true });
    target.addEventListener('error', bad, { once: true });
  });
}

async function requestWakeLock() {
  try { if ('wakeLock' in navigator) wakeLock = await navigator.wakeLock.request('screen'); } catch {}
}
async function releaseWakeLock() { try { await wakeLock?.release?.(); } catch {} wakeLock = null; }
function sleep(ms) { return new Promise((r) => setTimeout(r, ms)); }

function streamingError(err) {
  const msg = String(err?.message || err || '');
  if (/VIDEO_FRAME_CALLBACK_UNSUPPORTED/i.test(msg)) return 'المتصفح لا يدعم قراءة إطارات الفيديو اللازمة للتنعيم الحقيقي. افتح الرابط في Chrome/Safari المحدث.';
  if (/MEDIARECORDER_CODEC_UNSUPPORTED/i.test(msg)) return 'لا يوجد ترميز فيديو مناسب في هذا المتصفح.';
  if (/memory|allocate|out of bounds/i.test(msg)) return 'ذاكرة الجوال لم تكفِ. أغلق التطبيقات الأخرى ثم أعد المحاولة.';
  return `رمز الخطأ: ${msg || 'STREAM_UNKNOWN'}`;
}

function humanError(err) {
  const msg = String(err?.message || err || '');
  const technical = (lastLog || msg).replace(/\s+/g, ' ').slice(0, 180);
  if (/DIRECT_CORE_SCRIPT_FAILED/i.test(msg)) return 'تعذر تحميل Motion Engine. رمز: DIRECT_CORE_SCRIPT_FAILED';
  if (/DIRECT_ENGINE_LOAD_TIMEOUT/i.test(msg)) return 'تعذر تهيئة Motion Engine خلال دقيقة.';
  if (/memory|out of bounds|abort|allocate/i.test(`${msg} ${lastLog}`)) return `ذاكرة المتصفح لم تكفِ لهذا الوضع. استخدم TikTok Smooth 60 الطويل. رمز: ${technical || 'MEMORY'}`;
  return `فشل في مرحلة ${currentStage}. رمز: ${technical || msg || 'UNKNOWN'}`;
}

function formatBytes(bytes) {
  if (!Number.isFinite(bytes)) return '';
  const units = ['B','KB','MB','GB']; let n = bytes, i = 0;
  while (n >= 1024 && i < units.length - 1) { n /= 1024; i++; }
  return `${n.toFixed(i > 1 ? 1 : 0)} ${units[i]}`;
}
function formatDuration(seconds) {
  if (!seconds) return '0:00';
  const m = Math.floor(seconds / 60), s = Math.round(seconds % 60);
  return `${m}:${String(s).padStart(2, '0')}`;
}
function escapeHtml(s) {
  return String(s).replace(/[&<>'\"]/g, (c) => ({ '&':'&amp;', '<':'&lt;', '>':'&gt;', "'":'&#39;', '"':'&quot;' }[c]));
}
