import './style.css';
import { FFmpeg } from '@ffmpeg/ffmpeg';
import { fetchFile } from '@ffmpeg/util';

const $ = (id) => document.getElementById(id);
const base = import.meta.env.BASE_URL;

let ffmpeg = null;
let engineLoaded = false;
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
  download: $('downloadBtn'), framing: $('framing'), sharpness: $('sharpness')
};

if ('serviceWorker' in navigator) {
  window.addEventListener('load', async () => {
    try {
      const reg = await navigator.serviceWorker.register(`${base}sw.js`);
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
  els.fileInfo.innerHTML = `
    <strong>${escapeHtml(selectedFile.name)}</strong><br>
    ${formatBytes(selectedFile.size)} • ${sourceMeta.width || '?'}×${sourceMeta.height || '?'} • ${formatDuration(sourceMeta.duration)}
  `;
  els.fileInfo.classList.remove('hidden');
  els.start.disabled = false;
});

els.start.addEventListener('click', () => processVideo(false));
els.cancel.addEventListener('click', resetEngine);

function resetEngine() {
  cancelled = true;
  try { ffmpeg?.terminate(); } catch {}
  ffmpeg = null;
  engineLoaded = false;
  els.cancel.classList.add('hidden');
  els.start.disabled = false;
  setStatus('تم إلغاء المعالجة', 0, 'يمكنك البدء من جديد.');
}

async function processVideo(autoFallback = false) {
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
  lastLog = '';

  try {
    currentStage = 'engine';
    await ensureEngine();
    if (cancelled) return;

    currentStage = 'input';
    setStatus('إدخال الفيديو إلى المحرك', 4, 'الفيديو لا يُرفع إلى سيرفر.');
    const ext = (selectedFile.name.split('.').pop() || 'mp4').replace(/[^a-z0-9]/gi, '').toLowerCase() || 'mp4';
    const input = `input.${ext}`;
    const output = 'framex-output.mp4';
    await safeDelete(input);
    await safeDelete(output);
    await ffmpeg.writeFile(input, await fetchFile(selectedFile));

    const cfg = makeConfig();
    currentStage = 'encode';
    setStatus(cfg.title, 8, cfg.note);

    let code = await runEncode(input, output, cfg, true);
    if (code !== 0 && cfg.allowNoAudioFallback) {
      await safeDelete(output);
      setStatus('إعادة المحاولة بوضع توافق أعلى', 10, 'نجرب إخراج الفيديو بدون إعادة ترميز الصوت.');
      code = await runEncode(input, output, cfg, false);
    }

    if (cancelled) return;
    if (code !== 0) throw new Error(`FFmpeg exit code ${code}`);

    currentStage = 'result';
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
    const originalPreset = selectedPreset;

    if (!autoFallback && selectedPreset !== 'compat720' && currentStage === 'encode') {
      setStatus('نجرب وضع توافق الجوال تلقائيًا', 2, 'خفّضنا الدقة والفلاتر حتى لا تستهلك ذاكرة عالية.');
      try { ffmpeg?.terminate(); } catch {}
      ffmpeg = null;
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

async function runEncode(input, output, cfg, withAudio) {
  const args = [
    '-i', input,
    '-map', '0:v:0'
  ];
  if (withAudio) args.push('-map', '0:a?');
  args.push(
    '-vf', cfg.filter,
    '-c:v', 'libx264',
    '-preset', 'ultrafast',
    '-tune', 'fastdecode',
    '-crf', cfg.crf,
    '-threads', '1',
    '-pix_fmt', 'yuv420p'
  );
  if (withAudio) args.push('-c:a', 'aac', '-b:a', cfg.audioBitrate);
  else args.push('-an');
  args.push('-movflags', '+faststart', '-y', output);
  return ffmpeg.exec(args);
}

async function ensureEngine() {
  if (engineLoaded && ffmpeg) return;
  if (typeof WebAssembly === 'undefined') throw new Error('WebAssembly unavailable');

  setStatus('تحميل محرك الفيديو لأول مرة', 1, 'قد يستغرق قليلًا. بعد التحميل تتم المعالجة داخل جهازك.');
  ffmpeg = new FFmpeg();

  ffmpeg.on('progress', ({ progress }) => {
    if (!Number.isFinite(progress)) return;
    const pct = Math.min(96, Math.max(8, Math.round(progress * 88 + 8)));
    els.statusPct.textContent = `${pct}%`;
    els.bar.style.width = `${pct}%`;
  });

  ffmpeg.on('log', ({ message }) => {
    if (!message) return;
    lastLog = message.slice(-240);
    if (/frame=|time=|speed=/.test(message)) {
      els.detail.textContent = 'المعالجة جارية على معالج الجوال…';
    }
  });

  const loadPromise = ffmpeg.load({
    coreURL: `${base}ffmpeg/ffmpeg-core.js?v=2`,
    wasmURL: `${base}ffmpeg/ffmpeg-core.wasm?v=2`
  });
  const timeout = new Promise((_, reject) => setTimeout(() => reject(new Error('ENGINE_LOAD_TIMEOUT')), 60000));
  await Promise.race([loadPromise, timeout]);
  engineLoaded = true;
}

function makeConfig() {
  const framing = els.framing.value;
  const sharpness = els.sharpness.value;

  if (selectedPreset === 'compat720') {
    return configFor(720, 1280, 30, framing, 'off', {
      title: 'وضع توافق الجوال • 720p / 30FPS',
      note: 'أخف إعداد للتأكد أن محرك الفيديو يعمل على جهازك.',
      crf: '25', audioBitrate: '96k', label: '720×1280 • 30FPS Mobile', allowNoAudioFallback: true
    });
  }

  if (selectedPreset === 'smooth720') {
    return configFor(720, 1280, 60, framing, sharpness, {
      title: 'تحسين 720p • 60FPS', note: '60FPS خفيف بدون Motion AI لتقليل استهلاك الذاكرة.',
      crf: '23', audioBitrate: '128k', label: '720×1280 • 60FPS', allowNoAudioFallback: true
    });
  }

  if (selectedPreset === 'enhance1080') {
    return configFor(1080, 1920, 30, framing, sharpness, {
      title: 'تحسين الفيديو إلى 1080p', note: 'تحسين الدقة والتفاصيل بدون رفع الفريمات إلى 60.',
      crf: '21', audioBitrate: '128k', label: '1080×1920 • Enhance', allowNoAudioFallback: true
    });
  }

  if (selectedPreset === 'experimental4k') {
    return configFor(2160, 3840, 60, framing, 'off', {
      title: 'تجربة 4K • 60FPS', note: 'ضغط شديد على ذاكرة الجوال؛ للمقاطع القصيرة جدًا فقط.',
      crf: '25', audioBitrate: '128k', label: '2160×3840 • 60FPS Experimental', allowNoAudioFallback: true
    });
  }

  return configFor(1080, 1920, 60, framing, sharpness, {
    title: 'تحسين 1080p • 60FPS', note: 'نسخة أخف من السابق: بدون minterpolate الثقيل على الجوال.',
    crf: '22', audioBitrate: '128k', label: '1080×1920 • 60FPS', allowNoAudioFallback: true
  });
}

function configFor(w, h, fps, framing, sharpness, meta) {
  const scaler = framing === 'fill'
    ? `scale=${w}:${h}:force_original_aspect_ratio=increase:flags=bilinear,crop=${w}:${h}`
    : `scale=${w}:${h}:force_original_aspect_ratio=decrease:flags=bilinear,pad=${w}:${h}:(ow-iw)/2:(oh-ih)/2:black`;

  let extra = '';
  if (sharpness === 'normal') extra = ',unsharp=3:3:0.25:3:3:0';
  if (sharpness === 'strong') extra = ',unsharp=3:3:0.45:3:3:0';

  return {
    ...meta,
    filter: `${scaler},fps=${fps}${extra},format=yuv420p`
  };
}

function validateSelection() {
  const mb = selectedFile.size / 1024 / 1024;
  if (mb > 200) return 'للتجربة المجانية على الجوال استخدم ملفًا أقل من 200MB.';
  if (selectedPreset === 'compat720' && sourceMeta.duration > 20) {
    return 'أول اختبار: استخدم مقطعًا مدته 20 ثانية أو أقل. الأفضل 3–8 ثوانٍ.';
  }
  if (selectedPreset === 'smooth720' && sourceMeta.duration > 15) {
    return 'تجربة 720p/60 مخصصة حاليًا لمقطع 15 ثانية أو أقل.';
  }
  if ((selectedPreset === 'smooth1080' || selectedPreset === 'enhance1080') && sourceMeta.duration > 10) {
    return 'تجربة 1080p على الجوال: استخدم مقطعًا 10 ثوانٍ أو أقل أولًا.';
  }
  if (selectedPreset === 'experimental4k') {
    if (sourceMeta.duration > 3) return 'اختبار 4K/60 المحلي مخصص لمقطع 3 ثوانٍ أو أقل.';
    if (mb > 40) return 'في تجربة 4K استخدم ملفًا أقل من 40MB.';
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
    video.onerror = () => {
      URL.revokeObjectURL(url);
      resolve({ duration: 0, width: 0, height: 0 });
    };
    video.src = url;
  });
}

function humanError(err) {
  const msg = String(err?.message || err || '');
  const technical = (lastLog || msg).replace(/\s+/g, ' ').slice(0, 160);
  if (/memory|out of bounds|abort|allocate/i.test(`${msg} ${lastLog}`)) {
    return `ذاكرة المتصفح لم تكفِ. أغلق التبويبات الأخرى وجرّب مقطع 3–5 ثوانٍ بوضع توافق الجوال. رمز: ${technical || 'MEMORY'}`;
  }
  if (/ENGINE_LOAD_TIMEOUT/i.test(msg)) {
    return 'تعذر تحميل محرك الفيديو خلال دقيقة. حدّث الصفحة وتأكد من اتصال الإنترنت ثم جرّب مجددًا. رمز: ENGINE_LOAD_TIMEOUT';
  }
  if (/WebAssembly unavailable/i.test(msg)) {
    return 'المتصفح الحالي لا يوفر WebAssembly المطلوب. افتح الرابط في Chrome المحدث.';
  }
  return `فشل في مرحلة ${currentStage}. جرّب مقطع MP4 قصير بوضع توافق الجوال. رمز الخطأ: ${technical || msg || 'UNKNOWN'}`;
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
