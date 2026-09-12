import './style.css';

const $ = (id) => document.getElementById(id);
const base = import.meta.env.BASE_URL;

let engine = null;
let engineLoaded = false;
let selectedFile = null;
let selectedPreset = 'compat720';
let sourceMeta = { duration: 0, width: 0, height: 0 };
let outputUrl = null;
let cancelled = false;
let currentStage = 'idle';
let lastLog = '';
let coreScriptPromise = null;

const els = {
  file: $('videoFile'), fileInfo: $('fileInfo'), start: $('startBtn'), cancel: $('cancelBtn'),
  status: $('statusCard'), statusText: $('statusText'), statusPct: $('statusPct'), detail: $('statusDetail'),
  bar: $('progressBar'), result: $('resultCard'), resultVideo: $('resultVideo'), resultInfo: $('resultInfo'),
  download: $('downloadBtn'), framing: $('framing'), sharpness: $('sharpness')
};

if ('serviceWorker' in navigator) {
  window.addEventListener('load', async () => {
    try {
      const reg = await navigator.serviceWorker.register(`${base}sw.js?v=4`);
      reg.update().catch(() => {});
    } catch {}
  });
}

document.querySelectorAll('.preset').forEach((btn) => {
  btn.addEventListener('click', () => choosePreset(btn.dataset.preset));
});

function choosePreset(name) {
  selectedPreset = name;
  document.querySelectorAll('.preset').forEach((x) => {
    x.classList.toggle('active', x.dataset.preset === name);
  });
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

els.start.addEventListener('click', () => processVideo(false));
els.cancel.addEventListener('click', () => {
  cancelled = true;
  engine = null;
  engineLoaded = false;
  els.cancel.classList.add('hidden');
  els.start.disabled = false;
  setStatus('تم إلغاء المعالجة', 0, 'يمكنك البدء من جديد.');
});

async function processVideo(autoFallback = false) {
  if (!selectedFile) return;
  const validation = validateSelection();
  if (validation) { alert(validation); return; }

  cancelled = false;
  clearResult();
  els.start.disabled = true;
  els.cancel.classList.remove('hidden');
  els.status.classList.remove('hidden');
  lastLog = '';

  try {
    currentStage = 'engine';
    await ensureEngine();
    if (cancelled) return;

    currentStage = 'input';
    setStatus('إدخال الفيديو إلى المحرك', 4, 'المعالجة تتم داخل الصفحة نفسها بدون Worker.');
    const ext = (selectedFile.name.split('.').pop() || 'mp4').replace(/[^a-z0-9]/gi, '').toLowerCase() || 'mp4';
    const input = `input.${ext}`;
    const output = 'framex-output.mp4';
    safeDelete(input);
    safeDelete(output);
    engine.FS.writeFile(input, new Uint8Array(await selectedFile.arrayBuffer()));

    const cfg = makeConfig();
    currentStage = 'encode';
    setStatus(cfg.title, 8, 'قد تتوقف حركة الصفحة مؤقتًا أثناء المعالجة لأننا شغّلنا المحرك مباشرة للتوافق مع جوالك.');

    let code = runEncode(input, output, cfg, true);
    if (code !== 0 && cfg.allowNoAudioFallback) {
      safeDelete(output);
      setStatus('إعادة المحاولة بوضع توافق أعلى', 10, 'نجرب إخراج الفيديو بدون الصوت لتجاوز أي ترميز غير مدعوم.');
      code = runEncode(input, output, cfg, false);
    }
    if (cancelled) return;
    if (code !== 0) throw new Error(`FFmpeg exit code ${code}`);

    currentStage = 'result';
    setStatus('تجهيز النتيجة', 98, 'ثوانٍ قليلة…');
    const data = engine.FS.readFile(output);
    const blob = new Blob([data], { type: 'video/mp4' });
    outputUrl = URL.createObjectURL(blob);
    els.resultVideo.src = outputUrl;
    els.download.href = outputUrl;
    els.download.download = `framex-${selectedPreset}.mp4`;
    els.resultInfo.textContent = `${cfg.label} • ${formatBytes(blob.size)}`;
    els.result.classList.remove('hidden');
    setStatus('اكتملت المعالجة ✅', 100, 'احفظ الفيديو في جهازك من الزر أدناه.');

    safeDelete(input);
    safeDelete(output);
  } catch (err) {
    console.error(err);
    const originalPreset = selectedPreset;
    if (!autoFallback && selectedPreset !== 'compat720' && currentStage === 'encode') {
      setStatus('نجرب وضع توافق الجوال تلقائيًا', 2, 'خفضنا الدقة إلى 720p/30FPS.');
      engine = null;
      engineLoaded = false;
      choosePreset('compat720');
      await processVideo(true);
      return;
    }
    choosePreset(originalPreset);
    setStatus('تعذرت المعالجة على هذا الجهاز', 0, humanError(err));
  } finally {
    els.cancel.classList.add('hidden');
    els.start.disabled = false;
  }
}

function runEncode(input, output, cfg, withAudio) {
  const args = ['-i', input, '-map', '0:v:0'];
  if (withAudio) args.push('-map', '0:a?');
  args.push('-vf', cfg.filter, '-c:v', 'libx264', '-preset', 'ultrafast', '-tune', 'fastdecode', '-crf', cfg.crf, '-threads', '1', '-pix_fmt', 'yuv420p');
  if (withAudio) args.push('-c:a', 'aac', '-b:a', cfg.audioBitrate);
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

  setStatus('تحميل محرك الفيديو المباشر', 1, 'هذه النسخة لا تستخدم Module Worker حتى تعمل داخل متصفح الجوال الحالي.');
  const coreURL = `${base}ffmpeg/ffmpeg-core.js?v=direct4`;
  const wasmURL = `${base}ffmpeg/ffmpeg-core.wasm?v=direct4`;

  currentStage = 'engine-script';
  await loadClassicScript(coreURL);
  if (typeof window.createFFmpegCore !== 'function') throw new Error('DIRECT_CORE_GLOBAL_MISSING');

  currentStage = 'engine-wasm';
  const config = btoa(JSON.stringify({ wasmURL }));
  const timeout = new Promise((_, reject) => setTimeout(() => reject(new Error('DIRECT_ENGINE_LOAD_TIMEOUT')), 60000));
  const create = window.createFFmpegCore({ mainScriptUrlOrBlob: `${coreURL}#${config}` });
  engine = await Promise.race([Promise.resolve(create), timeout]);

  if (!engine?.FS || typeof engine.exec !== 'function') throw new Error('DIRECT_CORE_INVALID');
  engine.setLogger?.(({ message }) => {
    if (!message) return;
    lastLog = String(message).slice(-240);
  });
  engine.setProgress?.(({ progress }) => {
    if (!Number.isFinite(progress)) return;
    const pct = Math.min(96, Math.max(8, Math.round(progress * 88 + 8)));
    els.statusPct.textContent = `${pct}%`;
    els.bar.style.width = `${pct}%`;
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
    script.onload = () => resolve();
    script.onerror = () => reject(new Error('DIRECT_CORE_SCRIPT_FAILED'));
    document.head.appendChild(script);
  });
  return coreScriptPromise;
}

function makeConfig() {
  const framing = els.framing.value;
  const sharpness = els.sharpness.value;
  if (selectedPreset === 'compat720') return configFor(720, 1280, 30, framing, 'off', { title: 'وضع توافق الجوال • 720p / 30FPS', crf: '25', audioBitrate: '96k', label: '720×1280 • 30FPS Mobile', allowNoAudioFallback: true });
  if (selectedPreset === 'smooth720') return configFor(720, 1280, 60, framing, sharpness, { title: 'تحسين 720p • 60FPS', crf: '23', audioBitrate: '128k', label: '720×1280 • 60FPS', allowNoAudioFallback: true });
  if (selectedPreset === 'enhance1080') return configFor(1080, 1920, 30, framing, sharpness, { title: 'تحسين الفيديو إلى 1080p', crf: '21', audioBitrate: '128k', label: '1080×1920 • Enhance', allowNoAudioFallback: true });
  if (selectedPreset === 'experimental4k') return configFor(2160, 3840, 60, framing, 'off', { title: 'تجربة 4K • 60FPS', crf: '25', audioBitrate: '128k', label: '2160×3840 • 60FPS Experimental', allowNoAudioFallback: true });
  return configFor(1080, 1920, 60, framing, sharpness, { title: 'تحسين 1080p • 60FPS', crf: '22', audioBitrate: '128k', label: '1080×1920 • 60FPS', allowNoAudioFallback: true });
}

function configFor(w, h, fps, framing, sharpness, meta) {
  const scaler = framing === 'fill'
    ? `scale=${w}:${h}:force_original_aspect_ratio=increase:flags=bilinear,crop=${w}:${h}`
    : `scale=${w}:${h}:force_original_aspect_ratio=decrease:flags=bilinear,pad=${w}:${h}:(ow-iw)/2:(oh-ih)/2:black`;
  let extra = '';
  if (sharpness === 'normal') extra = ',unsharp=3:3:0.25:3:3:0';
  if (sharpness === 'strong') extra = ',unsharp=3:3:0.45:3:3:0';
  return { ...meta, filter: `${scaler},fps=${fps}${extra},format=yuv420p` };
}

function validateSelection() {
  const mb = selectedFile.size / 1024 / 1024;
  if (mb > 120) return 'للمحرك المباشر على الجوال استخدم ملفًا أقل من 120MB.';
  if (selectedPreset === 'compat720' && sourceMeta.duration > 12) return 'أول اختبار: استخدم مقطعًا 3–8 ثوانٍ فقط.';
  if (selectedPreset === 'smooth720' && sourceMeta.duration > 10) return 'تجربة 720p/60: استخدم مقطعًا 10 ثوانٍ أو أقل.';
  if ((selectedPreset === 'smooth1080' || selectedPreset === 'enhance1080') && sourceMeta.duration > 8) return 'تجربة 1080p: استخدم مقطعًا 8 ثوانٍ أو أقل أولًا.';
  if (selectedPreset === 'experimental4k' && sourceMeta.duration > 2) return 'اختبار 4K/60 المحلي المباشر مخصص لمقطع ثانيتين أو أقل.';
  return '';
}

function setStatus(text, pct, detail = '') {
  els.status.classList.remove('hidden');
  els.statusText.textContent = text;
  els.statusPct.textContent = `${Math.round(pct)}%`;
  els.bar.style.width = `${Math.max(0, Math.min(100, pct))}%`;
  els.detail.textContent = detail;
}

function safeDelete(name) {
  try { engine?.FS?.unlink(name); } catch {}
}

function clearResult() {
  if (outputUrl) URL.revokeObjectURL(outputUrl);
  outputUrl = null;
  els.result.classList.add('hidden');
  els.resultVideo.removeAttribute('src');
  els.resultVideo.load();
}

function readVideoMeta(file) {
  return new Promise((resolve) => {
    const video = document.createElement('video');
    const url = URL.createObjectURL(file);
    video.preload = 'metadata';
    video.onloadedmetadata = () => {
      const data = { duration: Number(video.duration) || 0, width: video.videoWidth || 0, height: video.videoHeight || 0 };
      URL.revokeObjectURL(url);
      resolve(data);
    };
    video.onerror = () => { URL.revokeObjectURL(url); resolve({ duration: 0, width: 0, height: 0 }); };
    video.src = url;
  });
}

function humanError(err) {
  const msg = String(err?.message || err || '');
  const technical = (lastLog || msg).replace(/\s+/g, ' ').slice(0, 180);
  if (/DIRECT_CORE_SCRIPT_FAILED/i.test(msg)) return 'تعذر تحميل ملف المحرك الكلاسيكي من الاستضافة. رمز: DIRECT_CORE_SCRIPT_FAILED';
  if (/DIRECT_ENGINE_LOAD_TIMEOUT/i.test(msg)) return 'تعذر تهيئة WebAssembly خلال دقيقة. رمز: DIRECT_ENGINE_LOAD_TIMEOUT';
  if (/DIRECT_CORE_GLOBAL_MISSING|DIRECT_CORE_INVALID/i.test(msg)) return `تم تحميل الملف لكن المحرك لم يتهيأ بالشكل المطلوب. رمز: ${msg}`;
  if (/memory|out of bounds|abort|allocate/i.test(`${msg} ${lastLog}`)) return `ذاكرة المتصفح لم تكفِ. جرّب مقطع 2–3 ثوانٍ. رمز: ${technical || 'MEMORY'}`;
  return `فشل في مرحلة ${currentStage}. رمز الخطأ: ${technical || msg || 'UNKNOWN'}`;
}

function formatBytes(bytes) {
  if (!Number.isFinite(bytes)) return '';
  const units = ['B','KB','MB','GB']; let n = bytes, i = 0;
  while (n >= 1024 && i < units.length - 1) { n /= 1024; i++; }
  return `${n.toFixed(i > 1 ? 1 : 0)} ${units[i]}`;
}
function formatDuration(seconds) {
  if (!seconds) return 'مدة غير معروفة';
  const m = Math.floor(seconds / 60), s = Math.round(seconds % 60);
  return `${m}:${String(s).padStart(2, '0')}`;
}
function escapeHtml(s) {
  return String(s).replace(/[&<>'\"]/g, (c) => ({ '&':'&amp;', '<':'&lt;', '>':'&gt;', "'":'&#39;', '"':'&quot;' }[c]));
}
