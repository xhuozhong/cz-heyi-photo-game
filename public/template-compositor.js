// Local photo compositing. No photos or face coordinates are sent to a server.
import { loadSignature, drawTemplateSignature } from './signature-stamp.js';
const clamp = (v, min, max) => Math.max(min, Math.min(max, v));
const canvas = (w, h) => Object.assign(document.createElement('canvas'), { width: Math.round(w), height: Math.round(h) });
const pause = () => new Promise(resolve => requestAnimationFrame(resolve));
let visionPromise, manifestPromise;
const images = new Map();
async function loadImage(src) {
  if (/^(?:data:|blob:)/.test(src)) { const image = new Image(); image.src = src; await image.decode(); return image; }
  if (!images.has(src)) images.set(src, (async () => { const image = new Image(); image.src = src; await image.decode(); return image; })().catch(error => { images.delete(src); throw error; }));
  return images.get(src);
}
async function vision() {
  if (!visionPromise) visionPromise = (async () => {
    const { FilesetResolver, FaceDetector, ImageSegmenter } = await import('./vendor/mediapipe/vision_bundle.mjs');
    const files = await FilesetResolver.forVisionTasks('./vendor/mediapipe/wasm');
    const detector = await FaceDetector.createFromOptions(files, { baseOptions: { modelAssetPath: './vendor/mediapipe/blaze_face_short_range.tflite', delegate: 'CPU' }, runningMode: 'IMAGE', minDetectionConfidence: .35 });
    const segmenter = await ImageSegmenter.createFromOptions(files, { baseOptions: { modelAssetPath: './vendor/mediapipe/selfie_segmenter.tflite', delegate: 'CPU' }, runningMode: 'IMAGE', outputConfidenceMasks: true, outputCategoryMask: false });
    return { detector, segmenter };
  })().catch(error => { visionPromise = null; throw error; });
  return visionPromise;
}
function normalizedImage(image) {
  const scale = Math.min(1, 1280 / Math.max(image.naturalWidth, image.naturalHeight));
  const source = canvas(image.naturalWidth * scale, image.naturalHeight * scale);
  source.getContext('2d').drawImage(image, 0, 0, source.width, source.height);
  return source;
}
function selectFace(detections, subject, width) {
  if (!detections.length) return null;
  const sorted = [...detections].sort((a, b) => a.boundingBox.originX - b.boundingBox.originX);
  if (subject === 'left') return sorted[0];
  if (subject === 'right') return sorted.at(-1);
  if (subject === 'center') return sorted.reduce((best, item) => Math.abs(item.boundingBox.originX + item.boundingBox.width / 2 - width / 2) < Math.abs(best.boundingBox.originX + best.boundingBox.width / 2 - width / 2) ? item : best);
  return sorted.sort((a, b) => b.boundingBox.width * b.boundingBox.height - a.boundingBox.width * a.boundingBox.height)[0];
}
export class AvatarError extends Error {
  constructor(message, reason) { super(message); this.reason = reason; }
}
export async function prepareAvatar(dataURL, subject = 'auto', manual = null, status = () => {}) {
  const image = await loadImage(dataURL), source = normalizedImage(image);
  let box, mask, maskWidth, maskHeight, eyes;
  if (manual) {
    box = { originX: manual.x * source.width, originY: manual.y * source.height, width: manual.width * source.width, height: manual.height * source.height };
  } else {
    status('正在定位你的头像', '首次使用需要载入本地人脸定位工具。'); await pause();
    let models;
    try { models = await vision(); } catch { throw new AvatarError('头像定位工具暂时打不开，可以手动圈选头像后继续。', 'model'); }
    const detection = selectFace(models.detector.detect(source).detections, subject, source.width);
    if (!detection) throw new AvatarError('没有找到清晰的正面人脸。请换一张头像，或手动圈选。', 'face');
    box = detection.boundingBox;
    if (box.width < 40 || box.height < 40) throw new AvatarError('头像太小，换一张更清晰的近照会更自然。也可以手动圈选。', 'small');
    eyes = detection.keypoints?.slice(0, 2).map(p => ({ x: p.x * source.width, y: p.y * source.height }));
    status('正在抠出真实头像', '保留原照片中的五官，柔化头发和下巴边缘。'); await pause();
    models.segmenter.segment(source, result => {
      const m = result.confidenceMasks[0];
      mask = new Float32Array(m.getAsFloat32Array()); maskWidth = m.width; maskHeight = m.height;
      result.close();
    });
  }
  // Expand detection to include hair and ears; fade only the neck, keeping facial features intact.
  const crop = { x: Math.max(0, box.originX - box.width * .38), y: Math.max(0, box.originY - box.height * .58) };
  crop.width = Math.min(source.width - crop.x, box.originX + box.width * 1.38 - crop.x);
  crop.height = Math.min(source.height - crop.y, box.originY + box.height * 1.22 - crop.y);
  const head = canvas(crop.width, crop.height), context = head.getContext('2d', { willReadFrequently: true });
  context.drawImage(source, crop.x, crop.y, crop.width, crop.height, 0, 0, head.width, head.height);
  const pixels = context.getImageData(0, 0, head.width, head.height), d = pixels.data;
  for (let y = 0; y < head.height; y++) for (let x = 0; x < head.width; x++) {
    const sx = crop.x + x, sy = crop.y + y;
    let alpha;
    if (mask) {
      const index = Math.min(maskHeight - 1, Math.round(sy / source.height * maskHeight)) * maskWidth + Math.min(maskWidth - 1, Math.round(sx / source.width * maskWidth));
      alpha = clamp((mask[index] - .12) / .76, 0, 1);
    } else {
      const dx = (sx - box.originX - box.width * .5) / (box.width * .83), dy = (sy - box.originY - box.height * .23) / (box.height * .82);
      alpha = clamp((1 - Math.hypot(dx, dy)) * 13, 0, 1);
    }
    const neckFade = clamp((box.originY + box.height * 1.21 - sy) / (box.height * .19), 0, 1);
    const edge = Math.min(x, head.width - x - 1, y, head.height - y - 1);
    d[(y * head.width + x) * 4 + 3] *= alpha * neckFade * clamp(edge / 4, 0, 1);
  }
  context.putImageData(pixels, 0, 0);
  const face = { x: box.originX - crop.x, y: box.originY - crop.y, width: box.width, height: box.height };
  const skinSamples = [[], [], []];
  for (let y = Math.max(0, Math.floor(face.y + face.height * .45)); y < Math.min(head.height, face.y + face.height * .78); y += 2) for (let x = Math.max(0, Math.floor(face.x + face.width * .15)); x < Math.min(head.width, face.x + face.width * .85); x += 2) {
    const i = (y * head.width + x) * 4, r = d[i], g = d[i + 1], b = d[i + 2];
    if (d[i + 3] > 200 && r > g * 1.015 && r > b * 1.04 && r > 45 && g > 30) for (let c = 0; c < 3; c++) skinSamples[c].push(d[i + c]);
  }
  const skinRGB = skinSamples.map(values => values.length > 10 ? values.sort((a, b) => a - b)[Math.floor(values.length / 2)] : null);
  const angle = eyes?.length === 2 ? Math.atan2(eyes[1].y - eyes[0].y, eyes[1].x - eyes[0].x) : 0;
  return { head, box: face, angle: clamp(angle, -.18, .18), skinRGB: skinRGB[0] ? skinRGB : null, manual: !!manual };
}
async function manifest() {
  if (!manifestPromise) manifestPromise = fetch('./assets/templates/manifest.json?ver=generated-templates-20261004').then(r => { if (!r.ok) throw new Error('合影模板暂时打不开，请刷新后重试。'); return r.json(); }).catch(e => { manifestPromise = null; throw e; });
  return manifestPromise;
}
function cover(ctx, image, w, h) {
  const scale = Math.max(w / image.width, h / image.height), iw = image.width * scale, ih = image.height * scale;
  ctx.drawImage(image, (w - iw) / 2, (h - ih) / 2, iw, ih);
}
function tone(source, scene, brightness = 0) {
  const out = canvas(source.width, source.height), ctx = out.getContext('2d', { willReadFrequently: true });
  ctx.drawImage(source, 0, 0);
  const p = ctx.getImageData(0, 0, out.width, out.height);
  const warmth = scene === 'terrace' ? [7, 2, -5] : scene === 'cafe' ? [4, 2, -2] : [0, 1, 2];
  for (let i = 0; i < p.data.length; i += 4) {
    if (!p.data[i + 3]) continue;
    for (let c = 0; c < 3; c++) p.data[i + c] = clamp(p.data[i + c] * (1 + brightness / 100) + warmth[c], 0, 255);
  }
  ctx.putImageData(p, 0, 0); return out;
}
function matchBodySkin(source, skinMask, sourceRGB, avatarRGB) {
  if (!skinMask || !sourceRGB || !avatarRGB) return source;
  const out = canvas(source.width, source.height), ctx = out.getContext('2d', { willReadFrequently: true }); ctx.drawImage(source, 0, 0);
  const m = canvas(out.width, out.height), mc = m.getContext('2d', { willReadFrequently: true }); mc.drawImage(skinMask, 0, 0, out.width, out.height);
  const p = ctx.getImageData(0, 0, out.width, out.height), mask = mc.getImageData(0, 0, out.width, out.height).data;
  const change = avatarRGB.map((v, c) => clamp(v - sourceRGB[c], -38, 38));
  for (let i = 0; i < p.data.length; i += 4) {
    const alpha = mask[i + 3] / 255;
    for (let c = 0; c < 3; c++) p.data[i + c] = clamp(p.data[i + c] + change[c] * alpha * .85, 0, 255);
  }
  ctx.putImageData(p, 0, 0); return out;
}
function transform(face, centerX, targetY, height) {
  const scale = height / face.height;
  return { scale, x: centerX - (face.x + face.width / 2) * scale, y: targetY - face.y * scale };
}
function drawBody(ctx, image, t, face, widthFactor) {
  // A constant-width neck area joins the face. Torso width changes gradually below shoulders.
  const start = Math.max(0, face.y + face.height * 1.08), end = Math.min(image.height, start + 180), pivot = face.x + face.width / 2;
  ctx.save(); ctx.translate(t.x, t.y); ctx.scale(t.scale, t.scale);
  const top = Math.min(start, image.height);
  ctx.drawImage(image, 0, 0, image.width, top, 0, 0, image.width, top);
  for (let y = Math.floor(top); y < image.height; y += 2) {
    const height = Math.min(2, image.height - y), blend = clamp((y - start) / (end - start), 0, 1), width = 1 + (widthFactor - 1) * blend * blend * (3 - 2 * blend);
    ctx.drawImage(image, 0, y, image.width, height, pivot - pivot * width, y, image.width * width, height);
  }
  ctx.restore();
}
function drawHead(ctx, avatar, target, t, adjustments) {
  // Short-range detector boxes omit part of the hair: fit a little smaller than the skin-face target.
  const box = avatar.box, baseScale = Math.min(target.height / box.height, target.width / box.width) * t.scale * .90, scale = baseScale * adjustments.scale;
  const x = t.x + (target.x + target.width / 2) * t.scale + adjustments.x;
  const y = t.y + (target.y + target.height) * t.scale - box.height * scale + adjustments.y;
  ctx.save(); ctx.translate(x, y + box.height * scale / 2); ctx.rotate(-avatar.angle);
  ctx.drawImage(avatar.head, -(box.x + box.width / 2) * scale, -(box.y + box.height / 2) * scale, avatar.head.width * scale, avatar.head.height * scale); ctx.restore();
}
export async function createComposition(avatar, options, status = () => {}) {
  status('正在装配合影模板', '匹配场景光线、身体版型和衣服颜色。'); await pause();
  const data = await manifest(), bodyData = data.bodies[options.gender], characterData = data.characters[options.character];
  const [body, partner, scene, skinMask, signature] = await Promise.all([loadImage(bodyData.srcByOutfit?.[options.outfit] || bodyData.src), loadImage(characterData.src), loadImage(`assets/scenes/${options.scene}.jpg`), bodyData.skinMask ? loadImage(bodyData.skinMask) : null, loadSignature(options.character)]);
  const stage = canvas(1024, 768), base = canvas(1024, 768), ctx = base.getContext('2d');
  ctx.imageSmoothingEnabled = true; ctx.imageSmoothingQuality = 'high';
  ctx.save(); ctx.filter = 'blur(1.5px)'; cover(ctx, scene, 1024, 768); ctx.restore();
  const shade = ctx.createLinearGradient(0, 0, 0, 768); shade.addColorStop(0, '#161c1717'); shade.addColorStop(1, '#161c1738'); ctx.fillStyle = shade; ctx.fillRect(0, 0, 1024, 768);
  const partnerFace = characterData.face, face = bodyData.face;
  const t = transform(face, 715, 191, 159), pt = transform(partnerFace, 302, 181, 167);
  const partnerTone = tone(partner, options.scene, -2), bodyTone = tone(matchBodySkin(body, skinMask, bodyData.neckSkinRGB, avatar.skinRGB), options.scene, -2);
  ctx.save(); ctx.shadowColor = '#18161242'; ctx.shadowBlur = 13; ctx.shadowOffsetX = 9; ctx.shadowOffsetY = 3;
  ctx.drawImage(partnerTone, pt.x, pt.y, partner.width * pt.scale, partner.height * pt.scale); ctx.restore();
  const widthFactor = { slim: .90, standard: 1, full: 1.12 }[options.body] || 1;
  drawBody(ctx, bodyTone, t, face, widthFactor);
  const defaultAdjustments = { scale: 1, x: 0, y: 0, lighting: -2 };
  const render = (adjustments = defaultAdjustments) => {
    const out = stage.getContext('2d'); out.imageSmoothingEnabled = true; out.imageSmoothingQuality = 'high'; out.clearRect(0, 0, 1024, 768); out.drawImage(base, 0, 0);
    const head = tone(avatar.head, options.scene, adjustments.lighting);
    drawHead(out, { ...avatar, head }, face, t, adjustments);
    const vignette = out.createRadialGradient(510, 350, 180, 510, 350, 660); vignette.addColorStop(0, '#17211600'); vignette.addColorStop(1, '#17211628'); out.fillStyle = vignette; out.fillRect(0, 0, 1024, 768);
    // Each render starts from the clean base, so micro-adjustments never stack signatures.
    drawTemplateSignature(out, signature, options.character, stage.width, stage.height);
    // The mark is baked into the image, including downloads and browser albums.
    const label = '合成合影 · 币安照相馆'; out.font = '500 17px "Microsoft YaHei", sans-serif';
    const w = out.measureText(label).width + 26; out.fillStyle = '#152015b8'; out.fillRect(998 - w, 709, w, 34); out.fillStyle = '#fff'; out.textBaseline = 'middle'; out.fillText(label, 1011 - w, 727);
    return stage;
  };
  render(); return { canvas: stage, render, defaultAdjustments, options, manual: avatar.manual };
}
export const encodePhoto = canvas => new Promise((resolve, reject) => canvas.toBlob(blob => blob ? resolve(blob) : reject(new Error('当前浏览器无法保存图片。')), 'image/jpeg', .94));
