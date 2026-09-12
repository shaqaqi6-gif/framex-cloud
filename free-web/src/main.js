import './style.css';

const $ = (id) => document.getElementById(id);
const base = import.meta.env.BASE_URL;
const BUILD = __FRAMEX_BUILD__;
const ENGINE = __FRAMEX_ENGINE__;

/* Absolute URLs: the worker resolves relative paths against its own script,
   and the FFmpeg core resolves them against self.location — neither of which
   is the page. Pin them to the document base once and pass them around. */
const absolute = (path) => new URL(path, document.baseURI).href;
/* The 32MB engine is versioned by the core package, not by the build, so a
   UI-only deploy does not force every phone to download it again. */
const CORE_URL = absolute(`${base}ffmpeg/ffmpeg-core.js?e=${ENGINE}`);
const WASM_URL = absolute(`${base}ffmpeg/ffmpeg-core.wasm?e=${ENGINE}`);
const WORKER_URL = absolute(`${base}ffmpeg-worker.js?b=${BUILD}`);

let engine = null;
let selectedFile = null;
let selectedPreset = 'compat720';
let sourceMeta = { duration: 0, width: 0, height: 0 };
let outputUrl = null;
let cancelled = false;
let currentStage = 'idle';
let lastLog = '';

const els = {
  file: $('videoFile'), fileInfo: $('fileInfo'), start: $('startBtn'), cancel: $('cancelBtn'),
  status: $('statusCard'), statusText: $('statusText'), statusPct: $('statusPct'), detail: $('statusDetail'),
  bar: $('progressBar'), result: $('resultCard'), resultVideo: $('resultVideo'), resultInfo: $('resultInfo'),
  download: $('downloadBtn'), framing: $('framing'), sharpness: $('sharpness'), build: $('buildTag')
};

if (els.build) els.build.textContent = `build ${BUILD}`;

registerServiceWorker();

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
  disposeEngine();
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
    const ext = (selectedFile.name.split('.').pop() || 'mp4').replace(/[^a-z0-9]/gi, '').toLowerCase() || 'mp4';
    const input = `input.${ext}`;
    const output = 'framex-output.mp4';
    setStatus('قراءة الفيديو', 4, engine.inWorker
      ? 'المعالجة تعمل في خيط منفصل، لذلك تبقى الصفحة قابلة للاستخدام.'
      : 'هذا الجهاز لا يدعم العامل المنفصل، لذلك تعمل المعالجة داخل الصفحة وقد تتجمد الحركة مؤقتًا.');
    const data = await selectedFile.arrayBuffer();
    if (cancelled) return;

    const cfg = makeConfig();
    currentStage = 'encode';
    setStatus(cfg.title, 8, 'جارٍ الترميز…');

    const result = await engine.run({
      input,
      output,
      data,
      args: encodeArgs(input, output, cfg, true),
      fallbackArgs: cfg.allowNoAudioFallback ? encodeArgs(input, output, cfg, false) : null
    });
    if (cancelled) return;

    currentStage = 'result';
    setStatus('تجهيز النتيجة', 98, 'ثوانٍ قليلة…');
    const blob = new Blob([result], { type: 'video/mp4' });
    outputUrl = URL.createObjectURL(blob);
    els.resultVideo.src = outputUrl;
    els.download.href = outputUrl;
    els.download.download = `framex-${selectedPreset}.mp4`;
    els.resultInfo.textContent = `${cfg.label} • ${formatBytes(blob.size)}`;
    els.result.classList.remove('hidden');
    setStatus('اكتملت المعالجة ✅', 100, 'احفظ الفيديو في جهازك من الزر أدناه.');
  } catch (err) {
    console.error(err);
    if (cancelled) return;
    const originalPreset = selectedPreset;
    if (!autoFallback && selectedPreset !== 'compat720' && currentStage === 'encode') {
      setStatus('نجرب وضع توافق الجوال تلقائيًا', 2, 'خفضنا الدقة إلى 720p/30FPS.');
      disposeEngine();
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

function encodeArgs(input, output, cfg, withAudio) {
  const args = ['-i', input, '-map', '0:v:0'];
  if (withAudio) args.push('-map', '0:a?');
  args.push('-vf', cfg.filter, '-c:v', 'libx264', '-preset', 'ultrafast', '-tune', 'fastdecode', '-crf', cfg.crf, '-threads', '1', '-pix_fmt', 'yuv420p');
  if (withAudio) args.push('-c:a', 'aac', '-b:a', cfg.audioBitrate);
  else args.push('-an');
  args.push('-movflags', '+faststart', '-y', output);
  return args;
}

/* ---------------------------------------------------------------- engine */

async function ensureEngine() {
  if (engine) return;
  if (typeof WebAssembly === 'undefined') throw tagged('WEBASSEMBLY_UNAVAILABLE');

  setStatus('تحميل محرك الفيديو', 1, 'التحميل الأول يجلب نحو 32 ميجابايت ويُحفظ للمرات القادمة.');
  try {
    engine = await createWorkerEngine();
    return;
  } catch (err) {
    console.warn('worker engine unavailable, falling back to the page itself', err);
  }
  if (cancelled) return;
  setStatus('تحميل المحرك داخل الصفحة', 1, 'تعذر تشغيل خيط منفصل على هذا المتصفح، لذلك نشغّل المحرك مباشرة.');
  engine = await createDirectEngine();
}

function disposeEngine() {
  try { engine?.dispose(); } catch { /* nothing to clean up */ }
  engine = null;
}

function onEngineProgress(progress) {
  if (!Number.isFinite(progress)) return;
  const pct = Math.min(96, Math.max(8, Math.round(progress * 88 + 8)));
  els.statusPct.textContent = `${pct}%`;
  els.bar.style.width = `${pct}%`;
}

/* Classic (non-module) worker. Module workers are what broke mobile browsers
   with "Importing a module script failed", so this path never uses one. */
function createWorkerEngine() {
  if (typeof Worker === 'undefined') return Promise.reject(tagged('WORKER_UNSUPPORTED'));

  let worker;
  try {
    worker = new Worker(WORKER_URL);
  } catch (err) {
    return Promise.reject(tagged('WORKER_SPAWN_FAILED', err));
  }

  let pending = null;
  const settle = (fn) => { const p = pending; pending = null; if (p) fn(p); };

  worker.onerror = (event) => {
    event.preventDefault?.();
    settle((p) => p.reject(tagged('WORKER_SCRIPT_FAILED', new Error(event.message || 'worker error'))));
  };
  worker.onmessage = ({ data: msg }) => {
    if (msg.type === 'log') { lastLog = msg.message; return; }
    if (msg.type === 'progress') { onEngineProgress(msg.progress); return; }
    if (msg.type === 'retry') {
      setStatus('إعادة المحاولة بوضع توافق أعلى', 10, 'نجرب إخراج الفيديو بدون الصوت لتجاوز أي ترميز غير مدعوم.');
      return;
    }
    if (msg.type === 'error') {
      lastLog = msg.log || lastLog;
      settle((p) => p.reject(tagged(msg.code, new Error(msg.message))));
      return;
    }
    settle((p) => p.resolve(msg.type === 'done' ? msg.data : undefined));
  };

  const send = (message, transfer) => new Promise((resolve, reject) => {
    if (pending) { reject(tagged('ENGINE_BUSY')); return; }
    pending = { resolve, reject };
    worker.postMessage(message, transfer || []);
  });

  const timeout = new Promise((_, reject) => {
    setTimeout(() => reject(tagged('ENGINE_LOAD_TIMEOUT')), 180000);
  });

  return Promise.race([
    send({ type: 'load', coreURL: CORE_URL, wasmURL: WASM_URL }),
    timeout
  ]).then(() => ({
    inWorker: true,
    run: ({ input, output, data, args, fallbackArgs }) =>
      send({ type: 'run', input, output, data, args, fallbackArgs }, [data]),
    dispose: () => worker.terminate()
  })).catch((err) => {
    worker.terminate();
    throw err;
  });
}

/* Fallback: same core, loaded straight into the page with a classic <script>.
   The page freezes while ffmpeg runs, but it is better than not running. */
async function createDirectEngine() {
  await loadClassicScript(CORE_URL);
  if (typeof window.createFFmpegCore !== 'function') throw tagged('CORE_GLOBAL_MISSING');

  const config = btoa(JSON.stringify({ wasmURL: WASM_URL }));
  const timeout = new Promise((_, reject) => {
    setTimeout(() => reject(tagged('ENGINE_LOAD_TIMEOUT')), 180000);
  });
  const core = await Promise.race([
    Promise.resolve(window.createFFmpegCore({ mainScriptUrlOrBlob: `${CORE_URL}#${config}` })),
    timeout
  ]);
  if (!core?.FS || typeof core.exec !== 'function') throw tagged('CORE_INVALID');

  core.setLogger?.(({ message }) => { if (message) lastLog = String(message).slice(-240); });
  core.setProgress?.(({ progress }) => onEngineProgress(progress));

  const unlink = (name) => { try { core.FS.unlink(name); } catch { /* not there */ } };
  const exec = (args) => {
    try { core.setTimeout?.(-1); } catch { /* older cores */ }
    let code;
    try { code = core.exec(...args); } catch (err) { throw tagged('FFMPEG_CRASHED', err); }
    try { core.reset?.(); } catch { /* ignore */ }
    return Number(code);
  };

  return {
    inWorker: false,
    async run({ input, output, data, args, fallbackArgs }) {
      unlink(input);
      unlink(output);
      try { core.FS.writeFile(input, new Uint8Array(data)); }
      catch (err) { throw tagged('INPUT_WRITE_FAILED', err); }

      let code = exec(args);
      if (code !== 0 && fallbackArgs) {
        unlink(output);
        setStatus('إعادة المحاولة بوضع توافق أعلى', 10, 'نجرب إخراج الفيديو بدون الصوت لتجاوز أي ترميز غير مدعوم.');
        code = exec(fallbackArgs);
      }
      if (code !== 0) { unlink(input); unlink(output); throw tagged(`FFMPEG_EXIT_${code}`); }

      let out;
      try { out = core.FS.readFile(output); } catch (err) { throw tagged('OUTPUT_MISSING', err); }
      unlink(input);
      unlink(output);
      return out.buffer.slice(out.byteOffset, out.byteOffset + out.byteLength);
    },
    dispose() { /* the core cannot be unloaded from the page; it is reused */ }
  };
}

function loadClassicScript(src) {
  if (typeof window.createFFmpegCore === 'function') return Promise.resolve();
  return new Promise((resolve, reject) => {
    const script = document.createElement('script');
    script.src = src;
    script.async = true;
    script.onload = () => resolve();
    script.onerror = () => reject(tagged('CORE_SCRIPT_FAILED'));
    document.head.appendChild(script);
  });
}

function tagged(code, cause) {
  const err = new Error(cause?.message ? `${code}: ${cause.message}` : code);
  err.code = code;
  return err;
}

/* --------------------------------------------------------------- presets */

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
  if (mb > 120) return 'استخدم ملفًا أقل من 120MB.';
  if (selectedPreset === 'compat720' && sourceMeta.duration > 12) return 'أول اختبار: استخدم مقطعًا 3–8 ثوانٍ فقط.';
  if (selectedPreset === 'smooth720' && sourceMeta.duration > 10) return 'تجربة 720p/60: استخدم مقطعًا 10 ثوانٍ أو أقل.';
  if ((selectedPreset === 'smooth1080' || selectedPreset === 'enhance1080') && sourceMeta.duration > 8) return 'تجربة 1080p: استخدم مقطعًا 8 ثوانٍ أو أقل أولًا.';
  if (selectedPreset === 'experimental4k' && sourceMeta.duration > 2) return 'اختبار 4K/60 مخصص لمقطع ثانيتين أو أقل.';
  return '';
}

/* ----------------------------------------------------------------- shell */

function registerServiceWorker() {
  if (!('serviceWorker' in navigator)) return;
  window.addEventListener('load', async () => {
    try {
      const reg = await navigator.serviceWorker.register(`${base}sw.js?b=${BUILD}&e=${ENGINE}`, { updateViaCache: 'none' });
      reg.update().catch(() => {});
    } catch { /* the app works without it */ }
  });
  /* A new worker took over after a deploy — reload once so the page, its
     assets and the cached engine all come from the same build. */
  let reloading = false;
  navigator.serviceWorker.addEventListener('controllerchange', () => {
    if (reloading) return;
    reloading = true;
    window.location.reload();
  });
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
  const code = err?.code || '';
  const msg = String(err?.message || err || '');
  const technical = (lastLog || msg).replace(/\s+/g, ' ').slice(0, 180);
  if (code === 'WEBASSEMBLY_UNAVAILABLE') return 'هذا المتصفح لا يدعم WebAssembly. جرّب Chrome أو Safari محدّثًا.';
  if (code === 'CORE_SCRIPT_FAILED' || code === 'WORKER_SCRIPT_FAILED') return `تعذر تحميل ملف المحرك من الاستضافة — تحقق من الشبكة ثم أعد التحميل. رمز: ${code}`;
  if (code === 'ENGINE_LOAD_TIMEOUT') return 'تحميل المحرك تجاوز 3 دقائق. الملف 32 ميجابايت — جرّب شبكة أسرع ثم أعد المحاولة. رمز: ENGINE_LOAD_TIMEOUT';
  if (code === 'CORE_GLOBAL_MISSING' || code === 'CORE_INVALID') return `تم تحميل الملف لكن المحرك لم يتهيأ. رمز: ${code}`;
  if (code === 'OUTPUT_MISSING') return 'انتهى الترميز بدون إنتاج ملف. جرّب وضع توافق الجوال بمقطع أقصر. رمز: OUTPUT_MISSING';
  if (/memory|out of bounds|abort|allocate/i.test(`${msg} ${lastLog}`)) return `ذاكرة المتصفح لم تكفِ. جرّب مقطع 2–3 ثوانٍ. رمز: ${technical || 'MEMORY'}`;
  return `فشل في مرحلة ${currentStage}. رمز الخطأ: ${code || technical || msg || 'UNKNOWN'}`;
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
  return String(s).replace(/[&<>'"]/g, (c) => ({ '&':'&amp;', '<':'&lt;', '>':'&gt;', "'":'&#39;', '"':'&quot;' }[c]));
}
