const $ = (q) => document.querySelector(q);
const fileInput = $('#fileInput');
const pickBtn = $('#pickBtn');
const changeBtn = $('#changeBtn');
const preview = $('#preview');
const fileMeta = $('#fileMeta');
const startBtn = $('#startBtn');
const progressCard = $('#progressCard');
const resultCard = $('#resultCard');
const progressBar = $('#progressBar');
const progressPct = $('#progressPct');
const progressMsg = $('#progressMsg');
const progressTitle = $('#progressTitle');
const progressHint = $('#progressHint');
const downloadBtn = $('#downloadBtn');
const engineBadge = $('#engineBadge');
const loginGate = $('#loginGate');
const pinInput = $('#pinInput');
const loginBtn = $('#loginBtn');
const loginMsg = $('#loginMsg');

let selectedFile = null;
let quality = '4k';
let fps = 60;
let layout = 'fill';
let pollTimer = null;

const dims = { '1080': '1080 × 1920', '2k': '1440 × 2560', '4k': '2160 × 3840' };
const fmtBytes = (n = 0) => n < 1024 * 1024 ? `${(n / 1024).toFixed(1)} KB` : n < 1024 ** 3 ? `${(n / 1024 / 1024).toFixed(1)} MB` : `${(n / 1024 ** 3).toFixed(2)} GB`;

function updatePreset() {
  $('#presetText').textContent = `${dims[quality]} • ${fps} FPS • 9:16`;
}

async function authStatus() {
  try {
    const r = await fetch('/api/auth/status', { cache: 'no-store' });
    const x = await r.json();
    loginGate.hidden = !(x.required && !x.authenticated);
  } catch {
    loginGate.hidden = true;
  }
}

async function doLogin() {
  loginMsg.textContent = '';
  loginBtn.disabled = true;
  try {
    const r = await fetch('/api/auth/login', {
      method: 'POST', headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ pin: pinInput.value })
    });
    const x = await r.json();
    if (!r.ok) throw new Error(x.detail || 'تعذر تسجيل الدخول');
    loginGate.hidden = true;
    pinInput.value = '';
    health();
  } catch (e) {
    loginMsg.textContent = e.message;
  } finally {
    loginBtn.disabled = false;
  }
}
loginBtn.onclick = doLogin;
pinInput.addEventListener('keydown', e => { if (e.key === 'Enter') doLogin(); });
authStatus();

async function health() {
  try {
    const r = await fetch('/api/health', { cache: 'no-store' });
    const x = await r.json();
    if (!r.ok || !x.ok) throw new Error();
    engineBadge.textContent = x.gpu_encode ? 'GPU متصل' : 'Cloud متصل';
    engineBadge.classList.add('ok');
  } catch {
    engineBadge.textContent = 'غير متصل';
    engineBadge.classList.remove('ok');
  }
}
health();
setInterval(health, 30000);
if ('serviceWorker' in navigator) navigator.serviceWorker.register('/sw.js').catch(() => {});

function selectFile(file) {
  selectedFile = file || null;
  if (!selectedFile) return;
  if (preview.src) URL.revokeObjectURL(preview.src);
  preview.src = URL.createObjectURL(selectedFile);
  preview.hidden = false;
  pickBtn.hidden = true;
  changeBtn.hidden = false;
  fileMeta.hidden = false;
  fileMeta.textContent = `${selectedFile.name} • ${fmtBytes(selectedFile.size)}`;
  startBtn.disabled = false;
  resultCard.hidden = true;
}

pickBtn.onclick = () => fileInput.click();
changeBtn.onclick = () => fileInput.click();
fileInput.onchange = () => selectFile(fileInput.files?.[0]);

document.querySelectorAll('[data-quality]').forEach(b => b.onclick = () => {
  document.querySelectorAll('[data-quality]').forEach(x => x.classList.remove('active'));
  b.classList.add('active');
  quality = b.dataset.quality;
  updatePreset();
});

document.querySelectorAll('[data-fps]').forEach(b => b.onclick = () => {
  document.querySelectorAll('[data-fps]').forEach(x => x.classList.remove('active'));
  b.classList.add('active');
  fps = Number(b.dataset.fps);
  updatePreset();
});

document.querySelectorAll('[data-layout]').forEach(b => b.onclick = () => {
  document.querySelectorAll('[data-layout]').forEach(x => x.classList.remove('active'));
  b.classList.add('active');
  layout = b.dataset.layout;
});

function setProgress(pct, title, msg, hint = '') {
  const p = Math.max(0, Math.min(100, Math.round(pct)));
  progressBar.style.width = `${p}%`;
  progressPct.textContent = `${p}%`;
  if (title) progressTitle.textContent = title;
  if (msg) progressMsg.textContent = msg;
  if (hint) progressHint.textContent = hint;
}

async function initUpload() {
  const r = await fetch('/api/uploads/init', {
    method: 'POST', headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ filename: selectedFile.name, size: selectedFile.size })
  });
  const x = await r.json();
  if (r.status === 401) { loginGate.hidden = false; throw new Error('سجل الدخول ثم أعد المحاولة'); }
  if (!r.ok) throw new Error(x.detail || 'تعذر بدء رفع الفيديو');
  return x;
}

function sendChunk(uploadId, index, blob) {
  return new Promise((resolve, reject) => {
    const fd = new FormData();
    fd.append('index', String(index));
    fd.append('chunk', blob, `chunk-${index}.bin`);
    const xhr = new XMLHttpRequest();
    xhr.open('POST', `/api/uploads/${uploadId}/chunk`);
    xhr.responseType = 'json';
    xhr.onerror = () => reject(new Error('انقطع الاتصال أثناء رفع الفيديو'));
    xhr.onload = () => {
      const body = xhr.response || {};
      if (xhr.status < 200 || xhr.status >= 300) return reject(new Error(body.detail || 'فشل رفع جزء من الفيديو'));
      resolve(body);
    };
    xhr.send(fd);
  });
}

async function uploadInChunks() {
  const init = await initUpload();
  const chunkSize = init.chunk_size;
  const total = selectedFile.size;
  let offset = 0, index = 0;
  while (offset < total) {
    const end = Math.min(total, offset + chunkSize);
    const blob = selectedFile.slice(offset, end);
    await sendChunk(init.upload_id, index, blob);
    offset = end; index++;
    const pct = (offset / total) * 100;
    setProgress(pct, 'رفع الفيديو', `جاري الرفع… ${Math.round(pct)}%`, 'الرفع مقسّم إلى أجزاء صغيرة حتى يعمل بثبات من الجوال.');
  }
  return init.upload_id;
}

async function finishUpload(uploadId) {
  const fd = new FormData();
  fd.append('quality', quality);
  fd.append('fps', String(fps));
  fd.append('enhance', String($('#enhanceToggle').checked));
  fd.append('layout', layout);
  const r = await fetch(`/api/uploads/${uploadId}/finish`, { method: 'POST', body: fd });
  const x = await r.json();
  if (!r.ok) throw new Error(x.detail || 'تعذر بدء المعالجة');
  return x;
}

startBtn.onclick = async () => {
  if (!selectedFile) return;
  startBtn.disabled = true;
  resultCard.hidden = true;
  progressCard.hidden = false;
  setProgress(0, 'رفع الفيديو', 'تجهيز الرفع…');
  try {
    const uploadId = await uploadInChunks();
    const job = await finishUpload(uploadId);
    setProgress(1, 'المعالجة السحابية', 'تم رفع الفيديو. بدء التحسين…', 'يمكنك ترك الصفحة مفتوحة حتى تظهر النتيجة.');
    poll(job.id);
  } catch (e) {
    fail(e.message);
  }
};

async function poll(id) {
  clearTimeout(pollTimer);
  try {
    const r = await fetch(`/api/jobs/${id}`, { cache: 'no-store' });
    const x = await r.json();
    if (r.status === 401) { loginGate.hidden = false; throw new Error('انتهت جلسة الدخول'); }
    if (!r.ok) throw new Error(x.detail || 'تعذر قراءة حالة المعالجة');
    const pct = x.progress || 0;
    setProgress(pct, 'المعالجة السحابية', x.message || 'جاري التحسين…', 'يتم تجهيز الفيديو للنشر العمودي.');
    if (x.status === 'done') {
      progressCard.hidden = true;
      resultCard.hidden = false;
      startBtn.disabled = false;
      const om = x.output_meta || {};
      $('#resultMeta').textContent = `${om.width || ''} × ${om.height || ''} • ${om.fps || fps} FPS • ${fmtBytes(x.output_size || 0)}`;
      downloadBtn.href = `/api/jobs/${id}/download`;
      downloadBtn.setAttribute('download', `FrameX_${quality}_${fps}fps.mp4`);
      resultCard.scrollIntoView({ behavior: 'smooth', block: 'center' });
      return;
    }
    if (x.status === 'failed') throw new Error(x.message || 'فشلت المعالجة');
    pollTimer = setTimeout(() => poll(id), 1500);
  } catch (e) {
    fail(e.message);
  }
}

function fail(msg) {
  progressCard.hidden = false;
  progressTitle.textContent = 'تعذر إكمال العملية';
  progressMsg.textContent = msg;
  progressPct.textContent = '!';
  progressBar.style.width = '0%';
  progressHint.textContent = 'حاول مرة أخرى أو استخدم فيديو أقصر للتجربة.';
  startBtn.disabled = false;
}

$('#againBtn').onclick = () => {
  resultCard.hidden = true;
  progressCard.hidden = true;
  if (preview.src) URL.revokeObjectURL(preview.src);
  preview.hidden = true;
  preview.src = '';
  pickBtn.hidden = false;
  changeBtn.hidden = true;
  fileMeta.hidden = true;
  selectedFile = null;
  fileInput.value = '';
  startBtn.disabled = true;
  window.scrollTo({ top: 0, behavior: 'smooth' });
};
