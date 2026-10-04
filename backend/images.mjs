import sharp from 'sharp';
import { readFile } from 'node:fs/promises';
import { ApiError, requireValue } from './errors.mjs';
import { atomicWrite } from './store.mjs';

export const MAX_PHOTO_BYTES = 12 * 1024 * 1024;
const MAX_PIXELS = 24_000_000;
export async function normalizePhoto(dataUrl) {
  requireValue(typeof dataUrl === 'string' && dataUrl.length <= Math.ceil(MAX_PHOTO_BYTES / 3) * 4 + 64, 413, 'PHOTO_TOO_LARGE', '照片最大为 12 MB');
  const match = /^data:image\/(jpeg|png|webp);base64,([A-Za-z0-9+/]+={0,2})$/.exec(dataUrl);
  requireValue(match && match[2].length % 4 === 0, 400, 'INVALID_PHOTO', '请上传 JPG、PNG 或 WEBP 图片');
  const bytes = Buffer.from(match[2], 'base64');
  requireValue(bytes.length > 0 && bytes.length <= MAX_PHOTO_BYTES && bytes.toString('base64') === match[2], 413, 'PHOTO_TOO_LARGE', '照片内容不正确或超过 12 MB');
  try {
    const image = sharp(bytes, { limitInputPixels: MAX_PIXELS, failOn: 'warning', animated: false });
    const info = await image.metadata();
    requireValue(info.format === match[1] && !(info.pages > 1) && info.width >= 64 && info.height >= 64, 400, 'INVALID_PHOTO', '请上传至少 64×64 的单张照片');
    return await image.rotate().resize({ width: 2048, height: 2048, fit: 'inside', withoutEnlargement: true }).flatten({ background: '#fff' }).jpeg({ quality: 94 }).toBuffer();
  } catch (error) { if (error instanceof ApiError) throw error; throw new ApiError(400, 'INVALID_PHOTO', '图片无法读取或尺寸过大'); }
}

export async function saveResult(sourcePath, targetPath) {
  const bytes = await readFile(sourcePath);
  requireValue(bytes.length > 0 && bytes.length <= 40 * 1024 * 1024, 500, 'INVALID_RESULT', '生成结果无法读取');
  const image = sharp(bytes, { limitInputPixels: MAX_PIXELS, failOn: 'warning' }).rotate().resize({ width: 2048, height: 2048, fit: 'inside', withoutEnlargement: true });
  const normalized = await image.jpeg({ quality: 94 }).toBuffer();
  const { width, height } = await sharp(normalized).metadata();
  const stamp = Buffer.from(`<svg width="${width}" height="${height}" xmlns="http://www.w3.org/2000/svg"><rect x="${Math.max(0, width - 262)}" y="${Math.max(0, height - 41)}" width="262" height="41" fill="#111" fill-opacity=".68"/><text x="${Math.max(6, width - 250)}" y="${Math.max(20, height - 14)}" font-family="sans-serif" font-size="16" fill="white">AI SYNTHETIC GROUP PHOTO</text></svg>`);
  await atomicWrite(targetPath, await sharp(normalized).composite([{ input: stamp }]).jpeg({ quality: 94 }).toBuffer());
}
