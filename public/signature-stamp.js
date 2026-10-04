// User-supplied decorative signatures. All compositing stays in this browser.
export const SIGNATURE_VERSION = 1;
const names = { cz: 'CZ', heyi: '何一' };
const signatureImages = new Map();
const clamp = (number, min, max) => Math.max(min, Math.min(max, number));

export async function loadSignature(character) {
  if (!Object.hasOwn(names, character)) throw new Error('合影人物无效，暂时无法添加纪念签名。');
  if (!signatureImages.has(character)) {
    signatureImages.set(character, (async () => {
      const image = new Image();
      image.src = new URL(`./assets/signatures/${character}.png`, import.meta.url).href;
      await image.decode();
      if (!image.naturalWidth || !image.naturalHeight) throw new Error();
      return image;
    })().catch(() => {
      signatureImages.delete(character);
      throw new Error(`${names[character]} 的纪念签名暂时打不开，请刷新后重试。`);
    }));
  }
  return signatureImages.get(character);
}

function fitImage(ctx, image, x, y, width, height) {
  const scale = Math.min(width / image.naturalWidth, height / image.naturalHeight);
  const w = image.naturalWidth * scale, h = image.naturalHeight * scale;
  ctx.drawImage(image, x + (width - w) / 2, y + (height - h) / 2, w, h);
}

// Template subjects have their faces in the upper half. Keep this plate above
// the existing lower-right synthesis mark, without changing its pixels.
export function drawTemplateSignature(ctx, signature, character, width, height) {
  const unit = width / 1024, plateWidth = 240 * unit, plateHeight = 108 * unit;
  const x = width - plateWidth - 26 * unit, y = height - plateHeight - 73 * unit;
  ctx.save();
  ctx.fillStyle = '#fffaf0f5'; ctx.beginPath();
  ctx.roundRect(x, y, plateWidth, plateHeight, 9 * unit); ctx.fill();
  ctx.strokeStyle = '#b7a66d66'; ctx.lineWidth = unit; ctx.stroke();
  fitImage(ctx, signature, x + 18 * unit, y + 9 * unit, plateWidth - 36 * unit, 60 * unit);
  ctx.fillStyle = '#665838'; ctx.textAlign = 'center'; ctx.textBaseline = 'middle';
  ctx.font = `${14 * unit}px "Microsoft YaHei", sans-serif`;
  ctx.fillText(`${names[character]} · 纪念签名`, x + plateWidth / 2, y + 88 * unit);
  ctx.restore();
}

const toJpeg = canvas => new Promise((resolve, reject) => canvas.toBlob(blob => blob ? resolve(blob) : reject(new Error('纪念签名暂时无法保存，请重试。')), 'image/jpeg', .94));

// AI compositions may put faces or watermarks anywhere. A new footer protects
// all source pixels; never apply this helper to an already stamped result.
export async function stampPhotoBlob(blob, character, method = 'ai') {
  const signature = await loadSignature(character), image = new Image();
  const url = URL.createObjectURL(blob);
  try {
    image.src = url; await image.decode();
    const width = image.naturalWidth, height = image.naturalHeight;
    if (!width || !height || width * height > 24_000_000) throw new Error('合影尺寸太大，暂时无法添加纪念签名。');
    const footer = method === 'ai' ? Math.round(clamp(width * .125, 72, 256)) : 0;
    const canvas = Object.assign(document.createElement('canvas'), { width, height: height + footer });
    const ctx = canvas.getContext('2d'); ctx.drawImage(image, 0, 0);
    if (method !== 'ai') drawTemplateSignature(ctx, signature, character, width, height);
    else {
      ctx.fillStyle = '#fffaf0'; ctx.fillRect(0, height, width, footer);
      const font = clamp(width * .018, 10, 26), margin = Math.max(12, width * .025);
      const sigWidth = Math.min(width * .28, footer * 2.25), sigHeight = footer * .56;
      const sigX = width - sigWidth - margin, sigY = height + footer * .08;
      fitImage(ctx, signature, sigX, sigY, sigWidth, sigHeight);
      ctx.textAlign = 'center'; ctx.textBaseline = 'middle'; ctx.fillStyle = '#665838';
      ctx.font = `${font}px "Microsoft YaHei", sans-serif`;
      ctx.fillText(`${names[character]} · 纪念签名`, sigX + sigWidth / 2, height + footer * .80, sigWidth);
      ctx.textAlign = 'left'; ctx.fillStyle = '#756e61';
      ctx.font = `${font}px "Microsoft YaHei", sans-serif`;
      const copy = width < 420 ? '创意合成合影' : '创意合成合影 · 签名仅作纪念装饰';
      ctx.fillText(copy, margin, height + footer * .52, Math.max(1, sigX - margin * 2));
    }
    return await toJpeg(canvas);
  } finally { URL.revokeObjectURL(url); }
}
