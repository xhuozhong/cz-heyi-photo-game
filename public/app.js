import { prepareAvatar, createComposition, encodePhoto, AvatarError } from './template-compositor.js';
const $ = id => document.getElementById(id);
const sceneInfo = {
  terrace: { name: '天台晚霞', kicker: 'SCENE 01 / ROOFTOP AT SUNSET', caption: '晚霞，和一次恰好的相遇。' },
  cafe: { name: '咖啡偶遇', kicker: 'SCENE 02 / A COFFEE ENCOUNTER', caption: '一杯咖啡的时间，留住一个瞬间。' },
  street: { name: '城市漫步', kicker: 'SCENE 03 / A WALK IN THE CITY', caption: '在城市转角，遇见特别的同路人。' },
};
const names = { cz: 'CZ', heyi: '何一' };
const state = { character: 'cz', scene: 'terrace', subject: 'auto', gender: 'male', body: 'standard', outfit: 'black', photo: null, photoLoading: false, busy: false, adjusting: false, ready: true, result: null, album: [], sound: false, manual: null, composition: null };
const wait = ms => new Promise(resolve => setTimeout(resolve, ms));
let toastTimer, elapsedTimer, dbPromise, photoReadToken = 0, adjustToken = 0, adjustTimer, cropImage;
function feedback(message, info = false) { $('feedback').textContent = message; $('feedback').classList.toggle('info', info); $('feedback').hidden = !message; }
function toast(message) { clearTimeout(toastTimer); $('toast').textContent = message; $('toast').hidden = false; toastTimer = setTimeout(() => { $('toast').hidden = true; }, 3600); }
function refreshControls() {
  $('shootButton').disabled = state.busy || state.photoLoading || !state.photo;
  $('shootButton').querySelector('span').textContent = state.busy ? '正在制作这次偶遇' : state.photoLoading ? '正在读取头像' : !state.photo ? '上传头像，准备合影' : `和 ${names[state.character]} 拍张合影`;
  for (const button of document.querySelectorAll('[data-character], [data-scene], #uploadZone, #replacePhoto, #tryExample, #againButton, #photoInput, #subjectSelect, #genderSelect, #bodySelect, #outfitSelect')) button.disabled = state.busy;
  document.body.classList.toggle('busy', state.busy);
  document.body.classList.toggle('has-result', !!state.result && !state.busy);
  $('resultActions').hidden = !state.result || state.busy;
  $('adjustments').hidden = !state.result || state.busy;
  $('downloadButton').disabled = state.busy || state.adjusting;
  $('saveButton').disabled = state.busy || state.adjusting || state.album.some(photo => photo.id === state.result?.id);
  $('manualCropOpen').hidden = !state.photo || state.busy;
  $('subjectField').hidden = !state.photo;
  $('stageHeading').textContent = state.result ? `你和 ${names[state.result.character]} 的合影` : '偶遇取景框';
  $('captionKicker').textContent = sceneInfo[state.scene].kicker; $('captionTitle').textContent = sceneInfo[state.scene].caption;
}
function syncSelection() {
  for (const key of ['character', 'scene']) document.querySelectorAll(`[data-${key}]`).forEach(card => { const selected = card.dataset[key] === state[key]; card.classList.toggle('selected', selected); card.setAttribute('aria-pressed', String(selected)); });
  for (const key of ['subject', 'gender', 'body', 'outfit']) $(`${key}Select`).value = state[key];
  const garment = state.gender === 'male' ? 'T 恤' : '连衣裙';
  const colors = { black: '黑色', cream: '米白', red: '酒红' };
  [...$('outfitSelect').options].forEach(option => option.textContent = `${colors[option.value]} ${garment}`);
}
function setStage(url, alt, badge, upload = false) {
  $('photoStage').classList.toggle('upload-view', upload);
  if (url) { $('stageImage').src = url; $('stageImage').alt = alt; $('stageImage').hidden = false; $('emptyStage').hidden = true; }
  else {
    $('stageImage').hidden = true; $('stageImage').removeAttribute('src'); $('emptyStage').hidden = false;
    const portrait = $('emptyStage').querySelector('.portrait'); portrait.classList.toggle('cz-portrait', state.character === 'cz'); portrait.classList.toggle('heyi-portrait', state.character === 'heyi');
    portrait.querySelector('img').src = `assets/${state.character === 'cz' ? 'cz' : 'heyi'}-reference.jpg`;
    portrait.querySelector('img').alt = `${names[state.character]} 人物参考`;
    $('emptyStage').querySelector('.empty-copy span').textContent = `上传一张头像，和 ${names[state.character]} 留下纪念。`;
  }
  $('imageBadge').textContent = badge;
}
function showCurrentInput() {
  if (state.result) setStage(state.result.url, `你和 ${names[state.result.character]} 的模板合成合影`, state.result.manual ? '你的合影 · 手动圈选' : '你的合影 · 本地模板合成');
  else if (state.photo) setStage(state.photo.dataURL, '你上传的原头像，尚未合成', '你的头像 · 准备拍摄', true);
  else setStage(null, '', '人物参考 · 准备拍摄');
}
function clearResult() {
  clearTimeout(adjustTimer); ++adjustToken;
  if (state.result?.url) URL.revokeObjectURL(state.result.url);
  state.result = null; state.composition = null; state.adjusting = false;
  $('saveButton').disabled = false; $('saveButton').innerHTML = '<svg><use href="#heart"/></svg> 收藏合影';
}
function changeChoice(key, value) {
  if (state.busy) return;
  if (state[key] !== value) { clearResult(); state[key] = value; feedback(''); }
  syncSelection(); showCurrentInput(); refreshControls();
}
const readAsDataURL = file => new Promise((resolve, reject) => { const reader = new FileReader(); reader.onload = () => resolve(reader.result); reader.onerror = reject; reader.readAsDataURL(file); });
async function acceptPhoto(file) {
  if (!file || state.busy) return;
  feedback('');
  if (!['image/jpeg', 'image/png', 'image/webp'].includes(file.type)) { feedback('请换一张 JPG、PNG 或 WebP 图片。'); return; }
  if (file.size > 12 * 1024 * 1024) { feedback('头像有点大，请选择 12 MB 以内的图片。'); return; }
  const token = ++photoReadToken; state.photoLoading = true; refreshControls();
  try {
    const dataURL = await readAsDataURL(file), image = new Image(); image.src = dataURL; await image.decode();
    if (!image.naturalWidth || !image.naturalHeight || image.naturalWidth * image.naturalHeight > 60_000_000) throw new Error('size');
    if (token !== photoReadToken || state.busy) return;
    clearResult(); state.manual = null; state.photo = { dataURL, name: file.name, width: image.naturalWidth, height: image.naturalHeight };
    $('uploadZone').hidden = true; $('uploadedInfo').hidden = false; $('uploadThumb').src = dataURL; $('uploadName').textContent = file.name;
    state.subject = 'auto'; $('subjectSelect').value = 'auto'; $('photoTip').textContent = '保留原五官。正面头像和干净背景更适合模板。';
    showCurrentInput();
  } catch { if (token === photoReadToken) feedback('这张图片暂时打不开，或像素太大，请换一张清晰的头像。'); }
  finally { if (token === photoReadToken) { state.photoLoading = false; $('photoInput').value = ''; refreshControls(); } }
}
async function useExample() {
  if (state.busy) return;
  const token = photoReadToken;
  try { const response = await fetch('assets/sample-player.jpg'); if (!response.ok) throw new Error(); const blob = await response.blob(); if (state.busy || token !== photoReadToken) return; await acceptPhoto(new File([blob], '示例头像.jpg', { type: 'image/jpeg' })); feedback('已载入虚构人物示例。也可以换成你的头像。', true); }
  catch { feedback('示例头像暂时打不开，请上传自己的照片。'); }
}
function shutterSound() {
  if (!state.sound) return;
  try { const ctx = new (window.AudioContext || window.webkitAudioContext)(); ctx.resume(); const osc = ctx.createOscillator(), gain = ctx.createGain(); osc.type = 'square'; osc.frequency.setValueAtTime(240, ctx.currentTime); osc.frequency.exponentialRampToValueAtTime(60, ctx.currentTime + .09); gain.gain.setValueAtTime(.025, ctx.currentTime); gain.gain.exponentialRampToValueAtTime(.001, ctx.currentTime + .11); osc.connect(gain); gain.connect(ctx.destination); osc.start(); osc.stop(ctx.currentTime + .12); osc.onended = () => ctx.close(); } catch { /* Optional sound. */ }
}
async function countdown() {
  $('countdown').hidden = false;
  for (let number = 3; number > 0; number--) { $('countdown').textContent = String(number); $('countdown').classList.remove('tick'); void $('countdown').offsetWidth; $('countdown').classList.add('tick'); await wait(650); }
  $('countdown').hidden = true; $('flash').classList.add('fire'); shutterSound(); setTimeout(() => $('flash').classList.remove('fire'), 450);
}
function status(title, description) { $('loadingTitle').textContent = title; $('loadingDescription').textContent = description; }
function beginLoading() { const started = Date.now(); $('loadingOverlay').hidden = false; $('elapsedTime').textContent = '已等待 0 秒'; clearInterval(elapsedTimer); elapsedTimer = setInterval(() => { $('elapsedTime').textContent = `已等待 ${Math.floor((Date.now() - started) / 1000)} 秒`; }, 1000); }
function endLoading() { clearInterval(elapsedTimer); $('loadingOverlay').hidden = true; $('countdown').hidden = true; }
function adjustments() { return { scale: Number($('headScale').value) / 100, x: Number($('headX').value), y: Number($('headY').value), lighting: Number($('headLighting').value) }; }
function resetSliders() { $('headScale').value = 100; $('headX').value = 0; $('headY').value = 0; $('headLighting').value = -2; }
async function shoot() {
  if (state.busy || state.photoLoading || !state.photo) return;
  feedback(''); clearResult(); state.busy = true; refreshControls();
  const options = Object.fromEntries(['character', 'scene', 'gender', 'body', 'outfit'].map(k => [k, state[k]]));
  try {
    await countdown(); beginLoading();
    const avatar = await prepareAvatar(state.photo.dataURL, state.subject, state.manual, status);
    state.composition = await createComposition(avatar, options, status); resetSliders();
    const blob = await encodePhoto(state.composition.canvas);
    state.result = { id: crypto.randomUUID(), blob, url: URL.createObjectURL(blob), ...options, photoMethod: 'template', manual: avatar.manual, createdAt: Date.now() };
    feedback(avatar.manual ? '已用手动圈选合成。可以微调头像位置和明暗，使衔接更自然。' : '拍好了！可微调头像位置和明暗，再收藏或下载带走。', true); toast('咔嚓！这次偶遇已定格。');
  } catch (error) {
    feedback(error.message || '这次没拍成功，请重新试一张清晰的头像。');
    if (error instanceof AvatarError) $('manualCropOpen').hidden = false;
  } finally { state.busy = false; endLoading(); showCurrentInput(); refreshControls(); }
}
async function updateAdjustments() {
  if (!state.composition || !state.result || state.busy) return;
  state.adjusting = true; refreshControls();
  const token = ++adjustToken, result = state.result;
  let blob;
  try { blob = await encodePhoto(state.composition.render(adjustments())); }
  catch { if (token === adjustToken) { state.adjusting = false; refreshControls(); toast('微调图片暂时无法保存，请重试。'); } return; }
  if (token !== adjustToken || state.result !== result) return;
  URL.revokeObjectURL(result.url); result.blob = blob; result.url = URL.createObjectURL(blob);
  // Editing a saved photo creates a new album item, preserving the saved original.
  result.id = crypto.randomUUID(); result.createdAt = Date.now();
  state.adjusting = false; $('saveButton').disabled = false; $('saveButton').innerHTML = '<svg><use href="#heart"/></svg> 收藏合影'; showCurrentInput(); refreshControls();
}
function cropBox() {
  const height = Number($('cropSize').value) / 100;
  const width = Math.min(.9, height * state.photo.height / state.photo.width * .8);
  const x = Math.max(0, Math.min(1 - width, Number($('cropX').value) / 100 - width / 2));
  const y = Math.max(0, Math.min(1 - height, Number($('cropY').value) / 100 - height / 2));
  return { x, y, width, height };
}
function drawCrop() {
  if (!cropImage) return;
  const ctx = $('cropCanvas').getContext('2d'), w = 640, h = 480, scale = Math.min(w / cropImage.width, h / cropImage.height);
  const iw = cropImage.width * scale, ih = cropImage.height * scale, dx = (w - iw) / 2, dy = (h - ih) / 2, box = cropBox();
  ctx.fillStyle = '#172016'; ctx.fillRect(0, 0, w, h); ctx.drawImage(cropImage, dx, dy, iw, ih);
  const x = dx + box.x * iw, y = dy + box.y * ih, bw = box.width * iw, bh = box.height * ih;
  ctx.fillStyle = '#17201677'; ctx.fillRect(dx, dy, iw, Math.max(0, y - dy)); ctx.fillRect(dx, y + bh, iw, dy + ih - y - bh); ctx.fillRect(dx, y, x - dx, bh); ctx.fillRect(x + bw, y, dx + iw - x - bw, bh);
  ctx.strokeStyle = '#b8f36c'; ctx.lineWidth = 2; ctx.strokeRect(x, y, bw, bh); ctx.font = '15px Microsoft YaHei'; ctx.fillStyle = '#b8f36c'; ctx.fillText('脸部范围', x + 4, Math.max(20, y - 8));
}
async function openCrop() {
  if (!state.photo || state.busy) return;
  try { cropImage = new Image(); cropImage.src = state.photo.dataURL; await cropImage.decode(); $('cropX').value = 50; $('cropY').value = 40; $('cropSize').value = 30; drawCrop(); $('cropDialog').showModal(); }
  catch { feedback('头像暂时打不开，请重新上传。'); }
}

function openDB() {
  if (!dbPromise) dbPromise = new Promise((resolve, reject) => {
    const request = indexedDB.open('encounter-studio', 1);
    request.onupgradeneeded = () => request.result.createObjectStore('photos', { keyPath: 'id' });
    request.onsuccess = () => resolve(request.result); request.onerror = () => reject(request.error);
  });
  return dbPromise;
}
async function albumOperation(mode, action) {
  const db = await openDB();
  return new Promise((resolve, reject) => {
    const transaction = db.transaction('photos', mode); const request = action(transaction.objectStore('photos'));
    let result; request.onsuccess = () => { result = request.result; }; transaction.oncomplete = () => resolve(result);
    transaction.onabort = () => reject(transaction.error); transaction.onerror = () => reject(transaction.error);
  });
}
async function loadAlbum() {
  try { state.album = await albumOperation('readonly', (store) => store.getAll()); }
  catch { state.album = []; }
  state.album.sort((a, b) => b.createdAt - a.createdAt); updateCollection();
}
function updateCollection() {
  $('albumCount').textContent = String(state.album.length);
  const earned = new Set(state.album.map((photo) => photo.scene));
  $('collectionProgress').textContent = `${earned.size} / 3 个地点`;
  document.querySelectorAll('[data-stamp]').forEach((stamp) => stamp.classList.toggle('earned', earned.has(stamp.dataset.stamp)));
  document.querySelectorAll('[data-scene]').forEach((card) => card.classList.toggle('earned', earned.has(card.dataset.scene)));
  document.querySelector('.collection').classList.toggle('complete', earned.size === 3);
  $('collectionNote').textContent = earned.size === 3 ? '✦ 今日合影达人！三个偶遇地点，都留下了你的足迹。' : '收藏一张合影，点亮一个偶遇地点。';
}
async function saveResult() {
  if (!state.result || state.busy || state.adjusting) return;
  const result = state.result;
  $('saveButton').disabled = true;
  try {
    if (state.album.length >= 12 && !state.album.some((photo) => photo.id === result.id)) { toast('相册已收满 12 张。先下载喜欢的合影，再腾出一个位置。'); if (state.result?.id === result.id) $('saveButton').disabled = false; return; }
    const { id, blob, character, scene, createdAt, photoMethod, gender, body, outfit, manual } = result;
    await albumOperation('readwrite', (store) => store.put({ id, blob, character, scene, createdAt, photoMethod, gender, body, outfit, manual }));
    await loadAlbum(); if (state.result?.id === id) $('saveButton').innerHTML = '<svg><use href="#check"/></svg> 已收藏'; toast(`已收藏，点亮「${sceneInfo[scene].name}」！`);
  } catch { toast('浏览器暂时无法保存合影，请直接下载。'); if (state.result?.id === result.id) $('saveButton').disabled = false; }
}
function downloadPhoto(photo) {
  if (!photo?.blob) return;
  const url = URL.createObjectURL(photo.blob), link = document.createElement('a');
  link.href = url; link.download = `偶遇-${names[photo.character]}-${sceneInfo[photo.scene].name}-${new Date(photo.createdAt).toLocaleDateString('sv-SE', { timeZone: 'Asia/Shanghai' })}.jpg`;
  document.body.appendChild(link); link.click(); link.remove(); setTimeout(() => URL.revokeObjectURL(url), 3000);
}
let albumObjectURLs = [];
function clearAlbumURLs() { for (const url of albumObjectURLs) URL.revokeObjectURL(url); albumObjectURLs = []; }
async function renderAlbum() {
  await loadAlbum(); clearAlbumURLs(); $('albumGrid').replaceChildren();
  if (!state.album.length) { const empty = document.createElement('div'); empty.className = 'album-empty'; empty.textContent = '你的第一张偶遇合影，还在等你按下快门。'; $('albumGrid').appendChild(empty); return; }
  for (const photo of state.album) {
    const card = document.createElement('article'); card.className = 'album-item';
    const url = URL.createObjectURL(photo.blob); albumObjectURLs.push(url);
    const image = document.createElement('img'); image.src = url; image.alt = `与${names[photo.character]}的${sceneInfo[photo.scene].name} 合成合影`;
    const body = document.createElement('div'), title = document.createElement('p'), date = document.createElement('small');
    title.textContent = `${names[photo.character]} · ${sceneInfo[photo.scene].name}`;
    date.textContent = new Date(photo.createdAt).toLocaleString('zh-CN', { timeZone: 'Asia/Shanghai', month: 'long', day: 'numeric', hour: '2-digit', minute: '2-digit' });
    const download = document.createElement('button'); download.textContent = '下载'; download.onclick = () => downloadPhoto(photo);
    const remove = document.createElement('button'); remove.textContent = '移出相册';
    remove.onclick = async () => { try { await albumOperation('readwrite', (store) => store.delete(photo.id)); await renderAlbum(); toast('已移出浏览器相册。下载的照片仍在。'); } catch { toast('暂时无法移出，稍后再试。'); } };
    body.append(title, date, download, remove); card.append(image, body); $('albumGrid').appendChild(card);
  }
}
document.querySelectorAll('[data-character]').forEach(button => button.addEventListener('click', () => changeChoice('character', button.dataset.character)));
document.querySelectorAll('[data-scene]').forEach(button => button.addEventListener('click', () => changeChoice('scene', button.dataset.scene)));
for (const key of ['subject', 'gender', 'body', 'outfit']) $(`${key}Select`).addEventListener('change', event => { if (key === 'subject') state.manual = null; changeChoice(key, event.target.value); });
$('uploadZone').addEventListener('click', () => $('photoInput').click()); $('replacePhoto').addEventListener('click', () => $('photoInput').click());
$('photoInput').addEventListener('change', () => acceptPhoto($('photoInput').files[0]));
for (const event of ['dragenter', 'dragover']) $('uploadZone').addEventListener(event, e => { e.preventDefault(); if (!state.busy) $('uploadZone').classList.add('dragover'); });
for (const event of ['dragleave', 'drop']) $('uploadZone').addEventListener(event, e => { e.preventDefault(); $('uploadZone').classList.remove('dragover'); });
$('uploadZone').addEventListener('drop', e => acceptPhoto(e.dataTransfer.files[0]));
$('tryExample').addEventListener('click', useExample); $('shootButton').addEventListener('click', shoot);
$('soundButton').addEventListener('click', () => { state.sound = !state.sound; $('soundButton').setAttribute('aria-pressed', String(state.sound)); $('soundButton').setAttribute('aria-label', state.sound ? '关闭快门声音' : '打开快门声音'); $('soundButton').querySelector('span').textContent = state.sound ? '声音开' : '声音关'; });
$('downloadButton').addEventListener('click', () => { if (!state.busy && !state.adjusting) downloadPhoto(state.result); }); $('saveButton').addEventListener('click', saveResult);
$('againButton').addEventListener('click', () => { if (!state.busy) { clearResult(); showCurrentInput(); refreshControls(); feedback('换个造型或地点，再留下一张纪念吧。', true); $('shootButton').focus(); } });
$('albumOpen').addEventListener('click', async () => { await renderAlbum(); $('albumDialog').showModal(); });
$('albumClose').addEventListener('click', () => $('albumDialog').close()); $('albumDialog').addEventListener('close', clearAlbumURLs);
$('albumDialog').addEventListener('click', e => { if (e.target === $('albumDialog')) { const rect = $('albumDialog').getBoundingClientRect(); if (e.clientX < rect.left || e.clientX > rect.right || e.clientY < rect.top || e.clientY > rect.bottom) $('albumDialog').close(); } });
for (const id of ['headScale', 'headX', 'headY', 'headLighting']) $(id).addEventListener('input', () => { ++adjustToken; state.adjusting = true; refreshControls(); clearTimeout(adjustTimer); adjustTimer = setTimeout(updateAdjustments, 130); });
$('resetAdjustments').addEventListener('click', () => { resetSliders(); updateAdjustments(); });
$('manualCropOpen').addEventListener('click', openCrop); $('cropClose').addEventListener('click', () => $('cropDialog').close());
for (const id of ['cropX', 'cropY', 'cropSize']) $(id).addEventListener('input', drawCrop);
$('cropConfirm').addEventListener('click', () => { state.manual = cropBox(); clearResult(); $('cropDialog').close(); showCurrentInput(); refreshControls(); feedback('头像已圈选。点击拍摄使用手动柔边合成。', true); $('shootButton').focus(); });
window.render_game_to_text = () => JSON.stringify({ mode: state.busy ? 'composing' : state.result ? 'result' : state.photo ? 'ready' : 'setup', character: state.character, scene: state.scene, gender: state.gender, body: state.body, outfit: state.outfit, photoLoaded: !!state.photo, photoMethod: state.result?.photoMethod || null, manualCrop: !!state.manual, resultId: state.result?.id || null, albumCount: state.album.length, unlockedScenes: [...new Set(state.album.map(photo => photo.scene))] });
syncSelection(); refreshControls(); loadAlbum();

// Feature-detected page tools use the same choices as the visible controls.
if (document.modelContext?.registerTool) {
  const lifecycle = new AbortController();
  const choices = { character: ['cz', 'heyi'], scene: ['terrace', 'cafe', 'street'], gender: ['male', 'female'], body: ['slim', 'standard', 'full'], outfit: ['black', 'cream', 'red'] };
  try {
    Promise.resolve(document.modelContext.registerTool({
      name: 'configure_photo_template', title: '设置合影模板', description: '选择合影伙伴、地点、身体版型和衣服颜色。保留已经上传的头像，清除旧预览；此操作不拍摄或保存照片。',
      inputSchema: { type: 'object', properties: Object.fromEntries(Object.entries(choices).map(([key, values]) => [key, { type: 'string', enum: values }])), additionalProperties: false },
      annotations: { readOnlyHint: false, untrustedContentHint: false },
      execute(input) {
        if (state.busy || state.photoLoading) throw new Error('照片正在处理中，请稍后再设置。');
        if (!input || typeof input !== 'object' || Array.isArray(input)) throw new Error('请提供合影选项。');
        for (const [key, value] of Object.entries(input)) if (!choices[key]?.includes(value)) throw new Error('合影选项无效。');
        for (const [key, value] of Object.entries(input)) changeChoice(key, value);
        return { character: state.character, scene: state.scene, gender: state.gender, body: state.body, outfit: state.outfit, photoLoaded: !!state.photo };
      }
    }, { signal: lifecycle.signal })).catch(() => {});
    window.addEventListener('pagehide', () => lifecycle.abort(), { once: true });
  } catch { /* Browsers without page tools continue with the visible UI. */ }
}
