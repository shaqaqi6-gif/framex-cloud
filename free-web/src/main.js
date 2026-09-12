import './style.css';
import { inspectTikTokInput, turboPatchTikTok } from './tiktokPatch.js';

const $ = (id) => document.getElementById(id);
const base = import.meta.env.BASE_URL;

let selectedFile = null;
let selectedPreset = 'turbo';
let sourceMeta = { duration: 0, width: 0, height: 0 };
let sourceInfo = null;
let outputUrl = null;
let resultBlob = null;
let cancelled = false;

const els = {
  file: $('videoFile'),
  fileInfo: $('fileInfo'),
  start: $('startBtn'),
  cancel: $('cancelBtn'),
  status: $('statusCard'),
  statusText: $('statusText'),
  statusPct: $('statusPct'),
  detail: $('statusDetail'),
  bar: $('progressBar'),
  result: $('resultCard'),
  resultVideo: $('resultVideo'),
  resultInfo: $('resultInfo'),
  download: $('downloadBtn'),
  share: $('shareTikTokBtn'),
  compatibility: $('compatibilityCard'),
  compatibilityText: $('compatibilityText')
};

if ('serviceWorker' in navigator) {
  window.addEventListener('load', async () => {
    try {
      const reg = await navigator.serviceWorker.register(`${base}sw.js?v=7`);
      reg.update().catch(() => {});
    } catch {}
  });
}

document.querySelectorAll('.preset').forEach((btn) => {
  btn.addEventListener('click', () => choosePreset(btn.dataset.preset));
});

function choosePreset(name) {
  selectedPreset = name === 'safe' ? 'safe' : 'turbo';
  document.querySelectorAll('.preset').forEach((x) => {
    x.classList.toggle('active', x.dataset.preset === selectedPreset);
  });
  els.start.textContent = selectedPreset === 'safe' ? 'ابدأ Turbo Safe' : 'ابدأ FrameX Turbo';
}

els.file.addEventListener('change', async () => {
  selectedFile = els.file.files?.[0] || null;
  sourceInfo = null;
  clearResult();
  hideCompatibility();

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
  setStatus('الملف جاهز للفحص', 0, 'FrameX سيفحص الـFPS والترميز قبل أي تعديل.');
});

els.start.addEventListener('click', processTurbo);
els.cancel.addEventListener('click', () => {
  cancelled = true;
  setStatus('تم طلب الإلغاء', 0, 'إذا كانت عملية تعديل الحاوية بدأت بالفعل فستنتهي أولًا ثم نتجاهل النتيجة.');
});
els.share?.addEventListener('click', shareToTikTok);

async function processTurbo() {
  if (!selectedFile) return;

  const fileMb = selectedFile.size / 1024 / 1024;
  if (fileMb > 300) {
    alert('نسخة الجوال الحالية تدعم حتى 300MB لضمان ثبات الذاكرة. سنرفع الحد بعد اختبارات الأجهزة.');
    return;
  }
  if (!/\.mp4$/i.test(selectedFile.name) && selectedFile.type !== 'video/mp4') {
    alert('FrameX Turbo التجاري يقبل MP4 فقط حاليًا. لا نحول الصيغ في وضع Turbo حتى نحافظ على الجودة الأصلية.');
    return;
  }

  cancelled = false;
  clearResult();
  setBusy(true);

  try {
    setStatus('قراءة الفيديو', 5, 'بدون رفع للسحابة وبدون إعادة ترميز.');
    await nextPaint();

    const bytes = new Uint8Array(await selectedFile.arrayBuffer());
    if (cancelled) return;

    setStatus('فحص التوافق', 22, 'نتأكد من H.264 وMP4 ومعدل الإطارات الحقيقي.');
    await nextPaint();

    sourceInfo = inspectTikTokInput(bytes);
    if (!sourceInfo.compatible) {
      showCompatibility(false, sourceInfo.reason || 'صيغة MP4 غير مدعومة في Turbo');
      throw new Error(sourceInfo.reason || 'MP4_NOT_COMPATIBLE');
    }

    const fps = Number(sourceInfo.fps || 0);
    if (fps < 50) {
      showCompatibility(false, `المصدر ${fps.toFixed(1)}FPS تقريبًا. Turbo لا يختلق 60FPS؛ هذا الفيديو يحتاج Studio 60 فعلي.`);
      setStatus('الفيديو يحتاج Studio 60', 0, `تم رفض Turbo بدل إعطائك نتيجة مضللة. المصدر ≈ ${fps.toFixed(1)}FPS.`);
      return;
    }

    showCompatibility(true, `متوافق • H.264/MP4 • المصدر ≈ ${fps.toFixed(2)}FPS • مناسب لـTurbo`);
    const multiplier = selectedPreset === 'safe' ? 5 : 10;

    setStatus('تجهيز TikTok Method', 55, selectedPreset === 'safe'
      ? 'Turbo Safe: تعديل أخف على بنية MP4.'
      : 'Turbo: الحفاظ على الصورة الأصلية مع تعديل بنية MP4.');
    await nextPaint();

    const { output, stats } = turboPatchTikTok(bytes, {
      multiplier,
      comment: selectedPreset === 'safe' ? 'FrameX-Turbo-Safe' : 'FrameX-Turbo'
    });
    if (cancelled) return;

    setStatus('التحقق من الملف الناتج', 90, 'تجهيز الملف للحفظ والمشاركة.');
    await nextPaint();

    resultBlob = new Blob([output], { type: 'video/mp4' });
    finishResult(resultBlob,
      `${selectedPreset === 'safe' ? 'Turbo Safe' : 'Turbo'} • المصدر ${stats.fps.toFixed(2)}FPS • ` +
      `${stats.originalFrames.toLocaleString()} → ${stats.declaredFrames.toLocaleString()} عينة معلنة • ` +
      `${formatBytes(resultBlob.size)}`
    );

    setStatus('جاهز ✅', 100, 'Turbo لا يغيّر البكسلات، لذلك المعاينة المحلية قد تبدو مطابقة للأصل. اختبر النتيجة بعد الرفع للمنصة.');
  } catch (err) {
    console.error(err);
    if (!cancelled) {
      const message = String(err?.message || err || 'UNKNOWN');
      setStatus('الملف غير متوافق مع Turbo', 0, `${message}. لم يتم إنشاء ملف مدفوع/مضلل للعميل.`);
    }
  } finally {
    setBusy(false);
  }
}

function showCompatibility(ok, text) {
  if (!els.compatibility || !els.compatibilityText) return;
  els.compatibility.classList.remove('hidden', 'compat-ok', 'compat-bad');
  els.compatibility.classList.add(ok ? 'compat-ok' : 'compat-bad');
  els.compatibilityText.textContent = text;
}

function hideCompatibility() {
  if (!els.compatibility) return;
  els.compatibility.classList.add('hidden');
}

function finishResult(blob, info) {
  if (outputUrl) URL.revokeObjectURL(outputUrl);
  outputUrl = URL.createObjectURL(blob);
  els.resultVideo.src = outputUrl;
  els.download.href = outputUrl;
  els.download.download = 'FrameX-60FPS.mp4';
  els.resultInfo.textContent = info;
  els.result.classList.remove('hidden');
  els.share?.classList.remove('hidden');
}

async function shareToTikTok() {
  if (!resultBlob) return;
  const file = new File([resultBlob], 'FrameX-60FPS.mp4', { type: 'video/mp4' });
  try {
    if (navigator.canShare?.({ files: [file] }) && navigator.share) {
      await navigator.share({ files: [file], title: 'FrameX 60', text: 'اختر TikTok من قائمة المشاركة' });
    } else {
      alert('المشاركة المباشرة غير مدعومة في هذا المتصفح. احفظ الفيديو ثم اختره من داخل TikTok.');
    }
  } catch (err) {
    if (err?.name !== 'AbortError') alert('تعذرت المشاركة المباشرة. احفظ الفيديو ثم ارفعه من داخل TikTok.');
  }
}

function clearResult() {
  if (outputUrl) URL.revokeObjectURL(outputUrl);
  outputUrl = null;
  resultBlob = null;
  els.result.classList.add('hidden');
  els.share?.classList.add('hidden');
  els.resultVideo.removeAttribute('src');
  els.resultVideo.load();
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

function nextPaint() {
  return new Promise((resolve) => requestAnimationFrame(() => setTimeout(resolve, 0)));
}

function readVideoMeta(file) {
  return new Promise((resolve) => {
    const video = document.createElement('video');
    const url = URL.createObjectURL(file);
    video.preload = 'metadata';
    video.onloadedmetadata = () => {
      const data = {
        duration: Number(video.duration) || 0,
        width: video.videoWidth || 0,
        height: video.videoHeight || 0
      };
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

function formatBytes(bytes) {
  if (!Number.isFinite(bytes)) return '';
  const units = ['B', 'KB', 'MB', 'GB'];
  let n = bytes, i = 0;
  while (n >= 1024 && i < units.length - 1) { n /= 1024; i += 1; }
  return `${n.toFixed(i > 1 ? 1 : 0)} ${units[i]}`;
}

function formatDuration(seconds) {
  if (!seconds) return '0:00';
  const m = Math.floor(seconds / 60);
  const s = Math.round(seconds % 60);
  return `${m}:${String(s).padStart(2, '0')}`;
}

function escapeHtml(s) {
  return String(s).replace(/[&<>'\"]/g, (c) => ({
    '&': '&amp;', '<': '&lt;', '>': '&gt;', "'": '&#39;', '"': '&quot;'
  }[c]));
}
