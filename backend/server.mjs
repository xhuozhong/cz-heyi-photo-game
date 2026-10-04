import http from 'node:http';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { readFile, realpath, stat } from 'node:fs/promises';
import { gzip } from 'node:zlib';
import { promisify } from 'node:util';
import { PaidService } from './service.mjs';
import { ApiError, requireValue } from './errors.mjs';
import { createChainProvider } from './payment.mjs';
import { MAX_PHOTO_BYTES } from './images.mjs';

const ROOT_DIR = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const JSON_LIMIT = Math.ceil(MAX_PHOTO_BYTES / 3) * 4 + 16_384;
const MIME = { '.html': 'text/html; charset=utf-8', '.css': 'text/css; charset=utf-8', '.js': 'text/javascript; charset=utf-8', '.mjs': 'text/javascript; charset=utf-8', '.json': 'application/json; charset=utf-8', '.png': 'image/png', '.jpg': 'image/jpeg', '.jpeg': 'image/jpeg', '.webp': 'image/webp', '.svg': 'image/svg+xml', '.wasm': 'application/wasm', '.tflite': 'application/octet-stream', '.md': 'text/plain; charset=utf-8' };
const gzipBytes = promisify(gzip);
const STATIC_GZIP_CACHE_BYTES = 16 * 1024 * 1024;
const STATIC_GZIP_CACHE_ENTRIES = 128;

function acceptsGzip(header) {
  if (typeof header !== 'string') return false;
  const declarations = header.split(',').map(part => part.trim().split(';').map(value => value.trim()))
    .filter(([coding]) => coding.toLowerCase() === 'gzip');
  // A wildcard is not explicit support. An explicit zero/invalid quality is a
  // veto even when another duplicate declaration or wildcard says otherwise.
  if (!declarations.length) return false;
  return declarations.every(([, ...parameters]) => {
    const quality = parameters.filter(value => /^q\s*=/i.test(value));
    if (!quality.length) return true;
    return quality.length === 1 && /^q\s*=\s*(?:0(?:\.\d{0,3})?|1(?:\.0{0,3})?)$/i.test(quality[0])
      && Number(quality[0].split('=')[1].trim()) > 0;
  });
}

function staticGzipCache() {
  const entries = new Map(); const pending = new Map(); let bytes = 0;
  const version = info => `${info.mtimeMs}:${info.size}`;
  const remove = filename => { const entry = entries.get(filename); if (entry) { bytes -= entry.content.length; entries.delete(filename); } };
  return async (filename, info) => {
    const stamp = version(info); const cached = entries.get(filename);
    if (cached?.stamp === stamp) { entries.delete(filename); entries.set(filename, cached); return cached.content; }
    remove(filename);
    const key = `${filename}\0${stamp}`;
    if (pending.has(key)) return pending.get(key);
    const operation = (async () => {
      const content = await gzipBytes(await readFile(filename));
      // Do not retain a variant if the source changed during compression.
      const after = await stat(filename);
      if (version(after) === stamp && content.length <= STATIC_GZIP_CACHE_BYTES) {
        remove(filename);
        while (entries.size && (bytes + content.length > STATIC_GZIP_CACHE_BYTES || entries.size >= STATIC_GZIP_CACHE_ENTRIES)) remove(entries.keys().next().value);
        entries.set(filename, { stamp, content }); bytes += content.length;
      }
      return content;
    })().finally(() => pending.delete(key));
    pending.set(key, operation);
    return operation;
  };
}

export function loadConfig(env = process.env) {
  const port = Number(env.PORT || 4176);
  return {
    rootDir: ROOT_DIR, dataDir: path.resolve(env.PAID_DATA_DIR || path.join(ROOT_DIR, 'private-data')),
    enabled: env.PAID_ENABLED === 'true', firstFree: env.AI_FIRST_FREE !== 'false', port, host: env.HOST || '127.0.0.1', rpcUrl: env.BSC_RPC_URL,
    allowedOrigins: (env.FRONTEND_ORIGINS || `http://127.0.0.1:${port},http://localhost:${port}`).split(',').map(s => s.trim()).filter(Boolean),
    serviceDomain: env.SERVICE_DOMAIN || 'cz-heyi-photo-game', cliPath: env.LIBTV_CLI, model: env.LIBTV_MODEL,
    generationBudget: Number(env.LIBTV_GENERATION_BUDGET || 0), projectUuid: env.LIBTV_PROJECT_UUID, accountId: env.LIBTV_ACCOUNT_ID,
  };
}

async function readJson(req) {
  requireValue(/^application\/json(?:\s*;|$)/i.test(req.headers['content-type'] || ''), 415, 'JSON_REQUIRED', '请求须使用 JSON 格式');
  if (req.headers['content-length']) requireValue(Number(req.headers['content-length']) <= JSON_LIMIT, 413, 'REQUEST_TOO_LARGE', '照片最大为 12 MB');
  const chunks = []; let length = 0;
  for await (const chunk of req) { length += chunk.length; requireValue(length <= JSON_LIMIT, 413, 'REQUEST_TOO_LARGE', '照片最大为 12 MB'); chunks.push(chunk); }
  try { const body = JSON.parse(Buffer.concat(chunks).toString('utf8')); requireValue(body && typeof body === 'object' && !Array.isArray(body), 400, 'INVALID_JSON', '请求格式不正确'); return body; }
  catch (error) { if (error instanceof ApiError) throw error; throw new ApiError(400, 'INVALID_JSON', '请求格式不正确'); }
}

class RateLimiter {
  constructor() { this.entries = new Map(); }
  check(key, max, durationMs) {
    const now = Date.now();
    let entry = this.entries.get(key);
    if (!entry || entry.until < now) { entry = { count: 0, until: now + durationMs }; this.entries.set(key, entry); }
    requireValue(++entry.count <= max, 429, 'RATE_LIMITED', '操作过于频繁，请稍后再试');
    if (this.entries.size > 10000) for (const [id, item] of this.entries) if (item.until < now) this.entries.delete(id);
  }
}

export async function createPaidServer({ config = loadConfig(), chain, provider, autoProcess = true } = {}) {
  config = { rootDir: ROOT_DIR, allowedOrigins: [], ...config };
  const resolvedPublic = path.resolve(config.rootDir, 'public');
  const resolvedData = path.resolve(config.dataDir);
  requireValue(resolvedData !== resolvedPublic && !resolvedData.startsWith(resolvedPublic + path.sep), 500, 'PRIVATE_STORAGE_CONFIG', 'PAID_DATA_DIR must be outside public');
  requireValue(Array.isArray(config.allowedOrigins) && config.allowedOrigins.length > 0 && config.allowedOrigins.every(origin => { try { const u = new URL(origin); return u.origin === origin && ['http:', 'https:'].includes(u.protocol); } catch { return false; } }), 500, 'ORIGIN_CONFIG', 'Configure explicit FRONTEND_ORIGINS');
  if (!provider) { const { createLibtvProvider } = await import('./libtv-provider.mjs'); provider = createLibtvProvider(config); }
  chain ??= createChainProvider(config.rpcUrl);
  const service = new PaidService(config, chain, provider);
  await service.open();
  // Warm in the background: opening the listener does not wait for serial CLI
  // preflight commands, and the first health snapshot remains fail-closed.
  service.refreshHealth();
  service.autoProcess = autoProcess;
  const limiter = new RateLimiter();
  const publicDir = path.join(config.rootDir, 'public');
  const compressedStatic = staticGzipCache();
  const server = http.createServer(async (req, res) => {
    res.setHeader('X-Content-Type-Options', 'nosniff');
    res.setHeader('Referrer-Policy', 'no-referrer');
    res.setHeader('Cache-Control', 'no-store');
    const json = (status, value) => { res.writeHead(status, { 'Content-Type': 'application/json; charset=utf-8' }); res.end(JSON.stringify(value)); };
    try {
      const url = new URL(req.url, 'http://localhost');
      if (!url.pathname.startsWith('/api/')) {
        requireValue(['GET', 'HEAD'].includes(req.method), 405, 'METHOD_NOT_ALLOWED', '不支持此请求');
        const pathname = decodeURIComponent(url.pathname);
        requireValue(!pathname.includes('\0'), 400, 'INVALID_PATH', '路径不正确');
        const filename = path.resolve(publicDir, `.${pathname === '/' ? '/index.html' : pathname}`);
        const root = await realpath(publicDir);
        let actual;
        try { actual = await realpath(filename); } catch { throw new ApiError(404, 'NOT_FOUND', '文件不存在'); }
        requireValue(actual.startsWith(root + path.sep), 404, 'NOT_FOUND', '文件不存在');
        const extension = path.extname(actual).toLowerCase();
        const type = MIME[extension];
        const info = await stat(actual);
        requireValue(type && info.isFile(), 404, 'NOT_FOUND', '文件不存在');
        const relative = path.relative(root, actual).split(path.sep).join('/');
        const cacheable = /^\/(vendor|assets)\//i.test(pathname) && /^(vendor|assets)\//i.test(relative)
          && extension !== '.html' && path.basename(actual).toLowerCase() !== 'paid-config.js';
        const compressible = cacheable && /^\/vendor\//i.test(pathname) && /^vendor\//i.test(relative)
          && ['.wasm', '.tflite', '.js', '.mjs'].includes(extension);
        const compressed = compressible && acceptsGzip(req.headers['accept-encoding']);
        let content = compressed ? await compressedStatic(actual, info)
          : req.method === 'HEAD' && pathname !== '/paid-config.js' ? undefined : await readFile(actual);
        // The backend deployment enables its own same-origin API without changing the Pages free edition.
        if (content && pathname === '/paid-config.js') content = Buffer.from(content.toString('utf8').replace("apiBase: ''", "apiBase: '/'"));
        res.setHeader('Content-Security-Policy', "default-src 'self'; script-src 'self' 'wasm-unsafe-eval'; style-src 'self' 'unsafe-inline'; img-src 'self' data: blob:; connect-src 'self'; worker-src 'self' blob:; object-src 'none'; base-uri 'self'; frame-ancestors 'none'");
        if (cacheable) res.setHeader('Cache-Control', 'public, max-age=3600, no-transform');
        if (compressible) res.setHeader('Vary', 'Accept-Encoding');
        if (compressed) res.setHeader('Content-Encoding', 'gzip');
        res.setHeader('Content-Length', content?.length ?? info.size);
        res.writeHead(200, { 'Content-Type': type });
        res.end(req.method === 'HEAD' ? undefined : content); return;
      }
      const origin = req.headers.origin;
      if (origin) {
        requireValue(config.allowedOrigins.includes(origin), 403, 'ORIGIN_REJECTED', '请求来源不受支持');
        res.setHeader('Access-Control-Allow-Origin', origin);
        res.setHeader('Vary', 'Origin');
      }
      if (req.method === 'OPTIONS') {
        requireValue(origin && config.allowedOrigins.includes(origin), 403, 'ORIGIN_REJECTED', '请求来源不受支持');
        res.writeHead(204, { 'Access-Control-Allow-Methods': 'GET, POST', 'Access-Control-Allow-Headers': 'Content-Type, Authorization', 'Access-Control-Max-Age': '600' }); res.end(); return;
      }
      requireValue(['GET', 'POST'].includes(req.method), 405, 'METHOD_NOT_ALLOWED', '不支持此请求');
      if (req.method === 'POST') requireValue(origin && config.allowedOrigins.includes(origin), 403, 'ORIGIN_REQUIRED', '请求需要有效来源');
      const ip = req.socket.remoteAddress || 'unknown'; // Never trust client-controlled X-Forwarded-For.
      limiter.check(`all:${ip}`, 240, 60_000);
      if (req.method === 'GET' && url.pathname === '/api/health') { json(200, service.ready()); return; }
      if (req.method === 'GET' && url.pathname === '/api/trial') { json(200, await service.trial(url.searchParams.get('address'))); return; }
      if (req.method === 'POST' && url.pathname === '/api/orders') { limiter.check(`new:${ip}`, 6, 60_000); json(201, await service.create(await readJson(req))); return; }
      const match = /^\/api\/orders\/([0-9a-f-]{36})(?:\/(authorize|payment|result|retry))?$/.exec(url.pathname);
      requireValue(match, 404, 'NOT_FOUND', '接口不存在');
      const bearer = /^Bearer ([A-Za-z0-9_-]{43})$/.exec(req.headers.authorization || '')?.[1];
      const [, id, action] = match;
      if (req.method === 'GET' && !action) { json(200, await service.get(id, bearer)); return; }
      if (req.method === 'GET' && action === 'result') {
        const bytes = await service.result(id, bearer);
        res.writeHead(200, { 'Content-Type': 'image/jpeg', 'Content-Disposition': 'inline; filename="ai-group-photo.jpg"' }); res.end(bytes); return;
      }
      if (req.method === 'POST' && ['authorize', 'payment', 'retry'].includes(action)) {
        limiter.check(`write:${ip}:${id}`, 60, 60_000);
        const body = await readJson(req);
        if (action === 'authorize') { json(200, await service.authorize(id, bearer, body.signature)); return; }
        if (action === 'payment') { json(202, await service.claim(id, bearer, body.txHash)); return; }
        json(202, await service.retry(id, bearer)); return;
      }
      throw new ApiError(405, 'METHOD_NOT_ALLOWED', '不支持此请求');
    } catch (error) {
      if (!res.headersSent) {
        res.setHeader('Cache-Control', 'no-store'); res.removeHeader('Content-Encoding'); res.removeHeader('Content-Length');
        json(error instanceof ApiError ? error.status : 503, { error: { code: error instanceof ApiError ? error.code : 'SERVICE_ERROR', message: error instanceof ApiError ? error.message : '服务暂时不可用，请稍后再试' } });
      }
      else res.destroy();
    }
  });
  server.requestTimeout = 30_000;
  server.headersTimeout = 15_000;
  let timer;
  if (autoProcess) { timer = setInterval(() => service.kick(), 3000); timer.unref(); service.kick(); }
  const close = async () => { clearInterval(timer); service.autoProcess = false; if (server.listening) await new Promise(resolve => server.close(resolve)); await service.close(); chain?.destroy?.(); };
  return { server, service, close };
}

if (process.argv[1] && path.resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  const config = loadConfig();
  const app = await createPaidServer({ config });
  app.server.listen(config.port, config.host, () => { console.log(`Photo game backend listening on ${config.host}:${config.port}; paid mode ${config.enabled ? 'enabled with readiness checks' : 'disabled'}`); });
  for (const signal of ['SIGINT', 'SIGTERM']) process.once(signal, () => { void app.close().then(() => process.exit(0)); });
}
