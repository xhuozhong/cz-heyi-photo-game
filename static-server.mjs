import http from 'node:http';
import path from 'node:path';
import { stat, realpath } from 'node:fs/promises';
import { createReadStream } from 'node:fs';
import { fileURLToPath } from 'node:url';

const ROOT = path.dirname(fileURLToPath(import.meta.url));
const MIME = {
  '.html': 'text/html; charset=utf-8', '.js': 'text/javascript; charset=utf-8',
  '.mjs': 'text/javascript; charset=utf-8', '.wasm': 'application/wasm',
  '.tflite': 'application/octet-stream', '.css': 'text/css; charset=utf-8',
  '.json': 'application/json; charset=utf-8', '.jpg': 'image/jpeg',
  '.jpeg': 'image/jpeg', '.png': 'image/png', '.webp': 'image/webp',
  '.svg': 'image/svg+xml', '.ico': 'image/x-icon', '.txt': 'text/plain; charset=utf-8'
};
const CSP = "default-src 'self'; img-src 'self' data: blob:; script-src 'self' 'wasm-unsafe-eval'; style-src 'self'; connect-src 'self'; worker-src 'self' blob:; object-src 'none'; base-uri 'self'; frame-ancestors 'none'";

function isInside(base, target) {
  const normalizedBase = process.platform === 'win32' ? base.toLowerCase() : base;
  const normalizedTarget = process.platform === 'win32' ? target.toLowerCase() : target;
  return normalizedTarget.startsWith(normalizedBase + path.sep);
}

function fail(res, status, message, method) {
  const body = `${message}\n`;
  res.writeHead(status, { 'Content-Type': 'text/plain; charset=utf-8', 'Content-Length': Buffer.byteLength(body), 'X-Content-Type-Options': 'nosniff', 'Cache-Control': 'no-store' });
  res.end(method === 'HEAD' ? undefined : body);
}

// This server only reads files. It has no upload, generation, account or job API.
export async function createStaticServer({ publicDir = path.join(ROOT, 'public') } = {}) {
  const realPublicDir = await realpath(publicDir);
  return http.createServer(async (req, res) => {
    if (req.method !== 'GET' && req.method !== 'HEAD') { res.setHeader('Allow', 'GET, HEAD'); fail(res, 405, 'Method not allowed', req.method); return; }
    try {
      const rawPath = (req.url || '/').split('?')[0];
      let pathname;
      try { pathname = decodeURIComponent(rawPath); } catch { fail(res, 400, 'Invalid address', req.method); return; }
      if (!pathname.startsWith('/') || pathname.includes('\\') || pathname.includes('\0') || pathname.split('/').some(part => part === '..' || part === '.')) { fail(res, 403, 'Address not allowed', req.method); return; }
      if (pathname.startsWith('/api/')) { fail(res, 404, 'No API in local composition mode', req.method); return; }
      const requestedFile = path.resolve(realPublicDir, `.${pathname === '/' ? '/index.html' : pathname}`);
      if (!isInside(realPublicDir, requestedFile)) { fail(res, 403, 'Address not allowed', req.method); return; }
      const file = await realpath(requestedFile);
      if (!isInside(realPublicDir, file)) { fail(res, 403, 'Address not allowed', req.method); return; }
      const metadata = await stat(file);
      if (!metadata.isFile()) { fail(res, 404, 'File not found', req.method); return; }
      const type = MIME[path.extname(file).toLowerCase()] || 'application/octet-stream';
      res.writeHead(200, {
        'Content-Type': type, 'Content-Length': metadata.size,
        'X-Content-Type-Options': 'nosniff', 'Content-Security-Policy': CSP,
        'Cache-Control': /\.(?:wasm|tflite)$/.test(file) ? 'public, max-age=3600' : 'no-cache',
        'Referrer-Policy': 'no-referrer'
      });
      if (req.method === 'HEAD') { res.end(); return; }
      createReadStream(file).on('error', () => res.destroy()).pipe(res);
    } catch (error) {
      if (!res.headersSent) fail(res, error.code === 'ENOENT' || error.code === 'ENOTDIR' ? 404 : 500, error.code === 'ENOENT' || error.code === 'ENOTDIR' ? 'File not found' : 'Unable to read file', req.method);
      else res.destroy();
    }
  });
}

if (process.argv[1] && path.resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  const port = Number(process.env.PUBLIC_PORT || 4175);
  if (!Number.isInteger(port) || port < 1 || port > 65535) throw new Error('PUBLIC_PORT must be a valid port');
  const server = await createStaticServer();
  server.on('error', error => { console.error(error.message); process.exitCode = 1; });
  server.listen(port, '127.0.0.1', () => console.log(`Local photo game ready: http://127.0.0.1:${port}`));
}
