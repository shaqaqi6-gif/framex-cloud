import './style.css';
import { FFmpeg } from '@ffmpeg/ffmpeg';
import { fetchFile } from '@ffmpeg/util';

const $ = (id) => document.getElementById(id);
const base = import.meta.env.BASE_URL;

let ffmpeg = null;
let engineLoaded = false;
let selectedFile = null;
let selectedPreset = 'smooth1080';
let sourceMeta = { duration: 0, width: 0, height: 0 };
let outputUrl = null;
let cancelled = false;

const els = {
  file: $('videoFile'), fileInfo: $('fileInfo'), start: $('startBtn'), cancel: $('cancelBtn'),
  status: $('statusCard'), statusText: $('statusText'), statusPct: $('statusPct'), detail: $('statusDetail'),
  bar: $('progressBar'), result: $('resultCard'), resultVideo: $('resultVideo'), resultInfo: $('resultInfo'),
  download: $('downloadBtn'), framing: $('framing'), sharpness: $('sharpness')
};

if ('serviceWorker' in navigator) {
  window.addEventListener('load', () => navigator.serviceWorker.register(`${base}sw.js`).catch(() => {}));
}

document.querySelectorAll('.preset').forEach((btn) => {
  btn.addEventListener('click', () => {
    document.querySelectorAll('.preset').forEach((x) => x.classList.remove('active'));
    btn.classList.add('active');
    selectedPreset = btn.dataset.preset;
  });
});

els.file.addEventListener('change', async () => {
  selectedFile = els.file.files?.[0] || null;
  clearResult();
  if (!selectedFile) {
    els.fileInfo.classList.add('hidden');
    els.start.disabled = true;
    return;
  }
  sourceMeta = await readVideoMeta(selectedFile);
  els.fileInfo.innerHTML = `
    <strong>${escapeHtml(selectedFile.name)}</strong><br>
    ${formatBytes(selectedFile.size)} • ${sourceMeta.width}×${sourceMeta.height || '?'} • ${formatDuration(sourceMeta.duration)}
  `;
  els.fileInfo.classList.remove('hidden');
  els.start.disabled = false;
});

els.start.addEventListener('click', processVideo);
els.cancel.addEventListener('click', () => {
  cancelled = true;
  try { ffmpeg?.terminate(); } catch {}
  ffmpeg = null;
  engineLoaded = false;
  els.cancel.classList.add('hidden');
  els.start.disabled = false;
  setStatus('تم إلغاء المعالجة', 0, 'يمكنك البدء من جديد.');
});

async function processVideo() {
  if (!selectedFile) return;
  const validation = validateSelection();
  if (validation) {
    alert(validation);
    return;
  }

  cancelled = false;
  clearResult();
  els.start.disabled = true;
  els.cancel.classList.remove('hidden');
  els.status.classList.remove('hidden');

  try {
    await ensureEngine();
    if (cancelled) return;

    setStatus('إدخال الفيديو إلى محرك المعالجة', 4, 'الملف لا يُرفع إلى الإنترنت.');
    const ext = (selectedFile.name.split('.').pop() || 'mp4').replace(/[^a-z0-9]/gi, '').toLowerCase() || 'mp4';
    const input = `input.${ext}`;
    const output = 'framex-output.mp4';
    await safeDelete(input);
    await safeDelete(output);
    await ffmpeg.writeFile(input, await fetchFile(selectedFile));

    const cfg = makeConfig();
    setStatus(cfg.title, 8, cfg.note);
    const args = [
      '-i', input,
      '-map', '0:v:0', '-map', '0:a?',
      '-vf', cfg.filter,
      '-c:v', 'libx264', '-preset', 'ultrafast', '-crf', cfg.crf,
      '-pix_fmt', 'yuv420p',
      '-c:a', 'aac', '-b:a', '160k',
      '-movflags', '+faststart',
      '-y', output
    ];

    let code = await ffmpeg.exec(args);
    if (code !== 0 && cfg.fallbackFilter) {
      await safeDelete(output);
      setStatus('تشغيل وضع التوافق 60FPS', 10, 'المتصفح لم يدعم طريقة التوليد الأولى، نستخدم وضعًا أخف.');
      const fallbackArgs = [...args];
      const vfIndex = fallbackArgs.indexOf('-vf');
      fallbackArgs[vfIndex + 1] = cfg.fallbackFilter;
      code = await ffmpeg.exec(fallbackArgs);
    }
    if (cancelled) return;
    if (code !== 0) throw new Error(`FFmpeg exit code ${code}`);

    setStatus('تجهيز النتيجة', 98, 'ثوانٍ قليلة…');
    const data = await ffmpeg.readFile(output);
    const blob = new Blob([data.buffer], { type: 'video/mp4' });
    outputUrl = URL.createObjectURL(blob);
    els.resultVideo.src = outputUrl;
    els.download.href = outputUrl;
    els.download.download = `framex-${selectedPreset}.mp4`;
    els.resultInfo.textContent = `${cfg.label} • ${formatBytes(blob.size)}`;
    els.result.classList.remove('hidden');
    setStatus('اكتملت المعالجة ✅', 100, 'احفظ الفيديو في جهازك من الزر أدناه.');

    await safeDelete(input);
    await safeDelete(output);
  } catch (err) {
    console.error(err);
    setStatus('تعذرت المعالجة على هذا الجهاز', 0, humanError(err));
  } finally {
    els.cancel.classList.add('hidden');
    els.start.disabled = false;
  }
}

async function ensureEngine() {
  if (engineLoaded && ffmpeg) return;
  setStatus('تحميل محرك الفيديو لأول مرة', 1, 'قد يستغرق ذلك قليلًا حسب سرعة الإنترنت. بعد التحميل تتم المعالجة داخل جهازك.');
  ffmpeg = new FFmpeg();
  ffmpeg.on('progress', ({ progress }) => {
    if (!Number.isFinite(progress)) return;
    const pct = Math.min(96, Math.max(8, Math.round(progress * 88 + 8)));
    els.statusPct.textContent = `${pct}%`;
    els.bar.style.width = `${pct}%`;
  });
  ffmpeg.on('log', ({ message }) => {
    if (message && /frame=|time=|speed=/.test(message)) els.detail.textContent = 'المعالجة جارية على معالج الجوال…';
  });
  await ffmpeg.load({
    coreURL: `${base}ffmpeg/ffmpeg-core.js`,
    wasmURL: `${base}ffmpeg/ffmpeg-core.wasm`
  });
  engineLoaded = true;
}

function makeConfig() {
  const framing = els.framing.value;
  const sharp = els.sharpness.value;
  const output = selectedPreset === 'experimental4k' ? [2160, 3840] : [1080, 1920];
  const [w, h] = output;
  const frameFilter = framing === 'fill'
    ? `scale=${w}:${h}:force_original_aspect_ratio=increase:flags=lanczos,crop=${w}:${h}`
    : `scale=${w}:${h}:force_original_aspect_ratio=decrease:flags=lanczos,pad=${w}:${h}:(ow-iw)/2:(oh-ih)/2:black`;
  const sharpen = sharp === 'off' ? '' : sharp === 'strong' ? ',unsharp=5:5:0.8:5:5:0' : ',unsharp=5:5:0.45:5:5:0';
  const enhance = `hqdn3d=1.1:1.1:5:5,eq=contrast=1.025:saturation=1.04${sharpen}`;

  if (selectedPreset === 'enhance1080') {
    return {
      title: 'تحسين الفيديو إلى 1080p', note: 'تحسين الحجم والحدة والألوان بدون توليد إطارات إضافية.',
      filter: `${frameFilter},${enhance},format=yuv420p`, fallbackFilter: null, crf: '20', label: '1080p Enhance'
    };
  }

  // Blend interpolation is intentionally used in the free browser version: it is much lighter than motion-compensated AI/RIFE.
  const interpolate = 'minterpolate=fps=60:mi_mode=blend';
  const fallback = 'fps=60';
  const normalSource = Math.max(sourceMeta.width, sourceMeta.height) <= 1920;
  const mainFilter = normalSource
    ? `${interpolate},${frameFilter},${enhance},format=yuv420p`
    : `${frameFilter},${interpolate},${enhance},format=yuv420p`;
  const fallbackFilter = normalSource
    ? `${fallback},${frameFilter},${enhance},format=yuv420p`
    : `${frameFilter},${fallback},${enhance},format=yuv420p`;

  if (selectedPreset === 'experimental4k') {
    return {
      title: 'تجربة 4K • 60FPS', note: 'هذا وضع ضغط عالٍ على الجوال؛ لا تغلق الصفحة أثناء المعالجة.',
      filter: mainFilter, fallbackFilter, crf: '22', label: '4K 2160×3840 • 60FPS Experimental'
    };
  }
  return {
    title: 'تحسين 1080p • 60FPS', note: 'توليد 60FPS خفيف داخل المتصفح مع تحسين التفاصيل.',
    filter: mainFilter, fallbackFilter, crf: '20', label: '1080×1920 • 60FPS'
  };
}

function validateSelection() {
  const mb = selectedFile.size / 1024 / 1024;
  if (mb > 300) return 'للنسخة المجانية على الجوال جرّب ملفًا أقل من 300MB.';
  if (selectedPreset === 'experimental4k') {
    if (sourceMeta.duration > 6) return 'وضع 4K/60 المجاني مخصص حاليًا لمقطع مدته 6 ثوانٍ أو أقل حتى لا تنهار ذاكرة الجوال.';
    if (mb > 80) return 'في تجربة 4K استخدم ملفًا أقل من 80MB.';
  }
  if (selectedPreset === 'smooth1080' && sourceMeta.duration > 60) {
    return 'لأول تجربة 1080p/60 استخدم مقطعًا مدته دقيقة أو أقل. الأفضل 5–15 ثانية.';
  }
  return '';
}

function setStatus(text, pct, detail = '') {
  els.status.classList.remove('hidden');
  els.statusText.textContent = text;
  els.statusPct.textContent = `${Math.round(pct)}%`;
  els.bar.style.width = `${Math.max(0, Math.min(100, pct))}%`;
  els.detail.textContent = detail;
}

async function safeDelete(name) {
  try { await ffmpeg?.deleteFile(name); } catch {}
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
  if (/memory|out of bounds|abort/i.test(msg)) return 'ذاكرة الجوال لم تكفِ لهذه المعالجة. جرّب مقطعًا أقصر أو وضع 1080p.';
  return 'جرّب أولًا مقطعًا قصيرًا بوضع 1080p • 60FPS. بعض صيغ الفيديو أو الأجهزة قد لا يدعمها WebAssembly بالكامل.';
}

function formatBytes(bytes) {
  if (!Number.isFinite(bytes)) return '';
  const units = ['B', 'KB', 'MB', 'GB'];
  let n = bytes, i = 0;
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
