import './style.css';
import { inspectTikTokInput, turboPatchTikTok } from './tiktokPatch.js';

const $ = (id) => document.getElementById(id);
const base = import.meta.env.BASE_URL;

let selectedFile = null;
let selectedPreset = 'turbo';
let sourceMeta = { duration: 0, width: 0, height: 0 };
let outputUrl = null;
let resultBlob = null;
let resultMime = 'video/mp4';
let cancelled = false;
let engine = null;
let engineLoaded = false;
let coreScriptPromise = null;
let lastLog = '';

const els = {
  file: $('videoFile'), fileInfo: $('fileInfo'), start: $('startBtn'), cancel: $('cancelBtn'),
  status: $('statusCard'), statusText: $('statusText'), statusPct: $('statusPct'), detail: $('statusDetail'),
  bar: $('progressBar'), result: $('resultCard'), resultVideo: $('resultVideo'), resultInfo: $('resultInfo'),
  download: $('downloadBtn'), share: $('shareTikTokBtn'), framing: $('framing'), sharpness: $('sharpness')
};

if ('serviceWorker' in navigator) {
  window.addEventListener('load', async () => {
    try { const reg = await navigator.serviceWorker.register(`${base}sw.js?v=6`); reg.update().catch(() => {}); } catch {}
  });
}

document.querySelectorAll('.preset').forEach((btn) => btn.addEventListener('click', () => choosePreset(btn.dataset.preset)));
function choosePreset(name) {
  selectedPreset = name;
  document.querySelectorAll('.preset').forEach((x) => x.classList.toggle('active', x.dataset.preset === name));
  els.start.textContent = name === 'studio60' ? 'ابدأ Studio 60' : 'ابدأ TikTok Method';
}

els.file.addEventListener('change', async () => {
  selectedFile = els.file.files?.[0] || null;
  clearResult();
  if (!selectedFile) { els.fileInfo.classList.add('hidden'); els.start.disabled = true; return; }
  sourceMeta = await readVideoMeta(selectedFile);
  els.fileInfo.innerHTML = `<strong>${escapeHtml(selectedFile.name)}</strong><br>${formatBytes(selectedFile.size)} • ${sourceMeta.width || '?'}×${sourceMeta.height || '?'} • ${formatDuration(sourceMeta.duration)}`;
  els.fileInfo.classList.remove('hidden');
  els.start.disabled = false;
});

els.start.addEventListener('click', async () => {
  if (!selectedFile) return;
  cancelled = false;
  if (selectedPreset === 'studio60') await processStudio();
  else await processTurbo(selectedPreset === 'safe' ? 5 : 10);
});
els.cancel.addEventListener('click', () => { cancelled = true; setStatus('إلغاء المعالجة…', 0, 'سيتم الإلغاء عند أقرب نقطة ممكنة.'); });
els.share?.addEventListener('click', shareToTikTok);

async function processTurbo(multiplier) {
  const mb = selectedFile.size / 1024 / 1024;
  if (mb > 260) { alert('Turbo يعمل بدون إعادة ترميز، لكن المتصفح يحتاج ذاكرة كافية. للتجربة استخدم ملفًا أقل من 260MB.'); return; }
  if (!/\.mp4$/i.test(selectedFile.name) && selectedFile.type !== 'video/mp4') { alert('Turbo TikTok Method يحتاج ملف MP4. إذا كان الفيديو بصيغة أخرى استخدم Studio.'); return; }

  clearResult(); setBusy(true);
  try {
    setStatus('قراءة ملف MP4', 5, 'Turbo لا يعيد ترميز الصورة ولا يغيّر البكسلات.');
    const bytes = new Uint8Array(await selectedFile.arrayBuffer());
    if (cancelled) return;
    const info = inspectTikTokInput(bytes);
    if (!info.compatible) throw new Error(info.reason || 'MP4_NOT_COMPATIBLE');

    if (info.fps < 50) {
      choosePreset('studio60');
      setStatus('المقطع ليس 60FPS فعليًا', 0, `المصدر حوالي ${info.fps.toFixed(1)}FPS. Turbo يحافظ على 60 الموجود أصلًا ولا يصنع حركة جديدة. اختر Studio 60 لتحويله فعليًا.`);
      return;
    }

    setStatus('تطبيق TikTok Method', 45, multiplier === 10 ? 'Turbo: تعديل حاوية MP4 بدون إعادة ترميز.' : 'Safe: تعديل أخف للـmetadata بدون إعادة ترميز.');
    await new Promise((r) => setTimeout(r, 40));
    const { output, stats } = turboPatchTikTok(bytes, { multiplier, comment: 'FrameX-TikTok-HQ' });
    if (cancelled) return;

    resultBlob = new Blob([output], { type: 'video/mp4' });
    finishResult(resultBlob, `TikTok Method • ${stats.fps.toFixed(0)}FPS أصلي • ${stats.originalFrames.toLocaleString()} → ${stats.declaredFrames.toLocaleString()} إطار معلن • +${formatBytes(Math.max(0, stats.sizeDelta))}`);
    setStatus('جاهز للرفع إلى TikTok ✅', 100, 'طبيعي ألا ترى فرقًا عند تشغيل الملف محليًا: Turbo لا يغيّر الصورة. الهدف هو طريقة قراءة TikTok للملف بعد الرفع.');
  } catch (err) {
    console.error(err);
    setStatus('Turbo غير متوافق مع هذا الملف', 0, `${String(err?.message || err)} — جرّب Studio 60.`);
  } finally { setBusy(false); }
}

async function processStudio() {
  const mb = selectedFile.size / 1024 / 1024;
  if (mb > 180) { alert('Studio يعيد ترميز الفيديو داخل ذاكرة الجوال. للتجربة استخدم ملفًا أقل من 180MB.'); return; }
  if (sourceMeta.duration > 30) { alert('Studio 60 على الجوال مخصص حاليًا حتى 30 ثانية. إذا كان فيديوك أصلًا 60FPS استخدم Turbo مهما كانت مدته.'); return; }

  clearResult(); setBusy(true); lastLog = '';
  try {
    setStatus('تحميل Studio Engine', 2, 'Studio يعيد ترميز الفيديو ويصنع 60FPS فعليًا عند الحاجة.');
    await ensureEngine();
    const ext = (selectedFile.name.split('.').pop() || 'mp4').replace(/[^a-z0-9]/gi, '').toLowerCase() || 'mp4';
    const input = `input.${ext}`, output = 'framex-studio.mp4';
    safeDelete(input); safeDelete(output);
    engine.FS.writeFile(input, new Uint8Array(await selectedFile.arrayBuffer()));
    if (cancelled) return;

    const actualFps = await guessFps(selectedFile);
    const filter = studioFilter(actualFps);
    setStatus('Studio 60 — معالجة الحركة', 10, actualFps < 50 ? `المصدر ≈ ${actualFps.toFixed(0)}FPS: يتم إنشاء إطارات حركة جديدة.` : 'المصدر 60FPS: نحافظ على الفريمات ونضبط إخراج TikTok HQ.');
    const args = ['-i', input, '-map', '0:v:0', '-map', '0:a?', '-vf', filter,
      '-c:v', 'libx264', '-preset', 'ultrafast', '-crf', '17', '-maxrate', '16M', '-bufsize', '32M',
      '-r', '60', '-g', '120', '-pix_fmt', 'yuv420p', '-threads', '1',
      '-c:a', 'aac', '-b:a', '192k', '-ar', '48000', '-movflags', '+faststart', '-y', output];
    try { engine.setTimeout?.(-1); } catch {}
    engine.exec(...args);
    const code = Number(engine.ret ?? 0); try { engine.reset?.(); } catch {}
    if (code !== 0) throw new Error(`FFmpeg exit code ${code}`);
    if (cancelled) return;

    const studioBytes = engine.FS.readFile(output);
    let finalBytes = studioBytes, methodNote = 'Studio 60';
    try {
      const info = inspectTikTokInput(studioBytes);
      if (info.compatible) {
        const patched = turboPatchTikTok(studioBytes, { multiplier: 10, comment: 'FrameX-Studio-TikTok-HQ' });
        finalBytes = patched.output;
        methodNote = 'Studio 60 + TikTok Method';
      }
    } catch (e) { console.warn('Post-patch skipped', e); }

    resultBlob = new Blob([finalBytes], { type: 'video/mp4' });
    finishResult(resultBlob, `${methodNote} • 1080×1920 • 60FPS • ${formatBytes(resultBlob.size)}`);
    setStatus('جاهز للرفع إلى TikTok ✅', 100, 'Studio أنشأ ملف 60FPS عالي الجودة، ثم طبّق TikTok Method عندما كان الملف متوافقًا.');
    safeDelete(input); safeDelete(output);
  } catch (err) {
    console.error(err);
    setStatus('تعذرت معالجة Studio على هذا الجهاز', 0, humanError(err));
  } finally { setBusy(false); }
}

function studioFilter(fps) {
  const W = 1080, H = 1920, framing = els.framing.value;
  const scale = framing === 'fill'
    ? `scale=${W}:${H}:force_original_aspect_ratio=increase:flags=lanczos,crop=${W}:${H}`
    : `scale=${W}:${H}:force_original_aspect_ratio=decrease:flags=lanczos,pad=${W}:${H}:(ow-iw)/2:(oh-ih)/2:black`;
  const sharp = els.sharpness.value === 'strong' ? ',unsharp=3:3:0.5:3:3:0' : els.sharpness.value === 'normal' ? ',unsharp=3:3:0.3:3:3:0' : '';
  if (fps >= 50) return `${scale}${sharp},fps=60,format=yuv420p`;
  return `${scale},minterpolate=fps=60:mi_mode=mci:mc_mode=aobmc:me_mode=bidir:vsbmc=1${sharp},format=yuv420p`;
}

async function ensureEngine() {
  if (engineLoaded && engine) return;
  if (typeof WebAssembly === 'undefined') throw new Error('WebAssembly unavailable');
  const coreURL = `${base}ffmpeg/ffmpeg-core.js?v=studio6`, wasmURL = `${base}ffmpeg/ffmpeg-core.wasm?v=studio6`;
  await loadClassicScript(coreURL);
  if (typeof window.createFFmpegCore !== 'function') throw new Error('DIRECT_CORE_GLOBAL_MISSING');
  const config = btoa(JSON.stringify({ wasmURL }));
  engine = await Promise.race([
    Promise.resolve(window.createFFmpegCore({ mainScriptUrlOrBlob: `${coreURL}#${config}` })),
    new Promise((_, reject) => setTimeout(() => reject(new Error('ENGINE_LOAD_TIMEOUT')), 60000))
  ]);
  if (!engine?.FS || typeof engine.exec !== 'function') throw new Error('DIRECT_CORE_INVALID');
  engine.setLogger?.(({ message }) => { if (message) lastLog = String(message).slice(-240); });
  engine.setProgress?.(({ progress }) => {
    if (!Number.isFinite(progress)) return;
    const pct = Math.min(97, Math.max(10, Math.round(progress * 87 + 10)));
    setStatus('Studio 60 — معالجة الحركة', pct, 'جاري إنشاء/تثبيت 60FPS على الجوال…');
  });
  engineLoaded = true;
}
function loadClassicScript(src) {
  if (typeof window.createFFmpegCore === 'function') return Promise.resolve();
  if (coreScriptPromise) return coreScriptPromise;
  coreScriptPromise = new Promise((resolve, reject) => {
    const script = document.createElement('script'); script.src = src; script.async = true;
    script.onload = resolve; script.onerror = () => reject(new Error('DIRECT_CORE_SCRIPT_FAILED')); document.head.appendChild(script);
  });
  return coreScriptPromise;
}

async function shareToTikTok() {
  if (!resultBlob) return;
  const file = new File([resultBlob], 'FrameX-TikTok-60FPS.mp4', { type: resultMime });
  try {
    if (navigator.canShare?.({ files: [file] }) && navigator.share) {
      await navigator.share({ files: [file], title: 'FrameX TikTok 60FPS', text: 'اختر TikTok من قائمة المشاركة' });
    } else alert('احفظ الفيديو ثم افتح TikTok واختره من الاستديو.');
  } catch (err) { if (err?.name !== 'AbortError') alert('احفظ الفيديو ثم شاركه من تطبيق TikTok.'); }
}

function finishResult(blob, info) {
  if (outputUrl) URL.revokeObjectURL(outputUrl);
  outputUrl = URL.createObjectURL(blob);
  els.resultVideo.src = outputUrl; els.download.href = outputUrl; els.download.download = 'FrameX-TikTok-60FPS.mp4';
  els.resultInfo.textContent = info; els.result.classList.remove('hidden'); els.share?.classList.remove('hidden');
}
function clearResult() {
  if (outputUrl) URL.revokeObjectURL(outputUrl);
  outputUrl = null; resultBlob = null; els.result.classList.add('hidden'); els.share?.classList.add('hidden');
  els.resultVideo.removeAttribute('src'); els.resultVideo.load();
}
function setBusy(on) { els.start.disabled = on || !selectedFile; els.cancel.classList.toggle('hidden', !on); }
function setStatus(text, pct, detail='') {
  els.status.classList.remove('hidden'); els.statusText.textContent = text; els.statusPct.textContent = `${Math.round(pct)}%`;
  els.bar.style.width = `${Math.max(0, Math.min(100, pct))}%`; els.detail.textContent = detail;
}
function safeDelete(name) { try { engine?.FS?.unlink(name); } catch {} }

function readVideoMeta(file) {
  return new Promise((resolve) => {
    const v = document.createElement('video'), url = URL.createObjectURL(file); v.preload = 'metadata';
    v.onloadedmetadata = () => { const data = { duration:Number(v.duration)||0,width:v.videoWidth||0,height:v.videoHeight||0 }; URL.revokeObjectURL(url); resolve(data); };
    v.onerror = () => { URL.revokeObjectURL(url); resolve({duration:0,width:0,height:0}); }; v.src = url;
  });
}
async function guessFps(file) {
  try {
    const b = new Uint8Array(await file.arrayBuffer()); const info = inspectTikTokInput(b); if (info.compatible && info.fps) return info.fps;
  } catch {}
  return 30;
}
function humanError(err) {
  const msg = String(err?.message || err || ''); const technical = (lastLog || msg).replace(/\s+/g,' ').slice(0,180);
  if (/memory|out of bounds|abort|allocate/i.test(`${msg} ${lastLog}`)) return `ذاكرة الجوال لم تكفِ لـ Studio. إذا كان المصدر 60FPS استخدم Turbo. رمز: ${technical || 'MEMORY'}`;
  return `رمز الخطأ: ${technical || msg || 'UNKNOWN'}`;
}
function formatBytes(bytes) { if (!Number.isFinite(bytes)) return ''; const units=['B','KB','MB','GB']; let n=bytes,i=0; while(n>=1024&&i<units.length-1){n/=1024;i++} return `${n.toFixed(i>1?1:0)} ${units[i]}`; }
function formatDuration(seconds) { if (!seconds) return '0:00'; const m=Math.floor(seconds/60),s=Math.round(seconds%60); return `${m}:${String(s).padStart(2,'0')}`; }
function escapeHtml(s) { return String(s).replace(/[&<>'\"]/g,(c)=>({'&':'&amp;','<':'&lt;','>':'&gt;',"'":'&#39;','"':'&quot;'}[c])); }
