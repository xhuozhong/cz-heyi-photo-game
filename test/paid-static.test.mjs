import test from 'node:test';
import assert from 'node:assert/strict';
import http from 'node:http';
import { mkdtemp, mkdir, readFile, writeFile, rm, utimes } from 'node:fs/promises';
import { gunzipSync } from 'node:zlib';
import { randomBytes, randomUUID, createHash } from 'node:crypto';
import path from 'node:path';
import os from 'node:os';
import { fileURLToPath } from 'node:url';
import { createPaidServer } from '../backend/server.mjs';

const gameRoot = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
async function rawRequest(base, pathname, { method = 'GET', headers = {} } = {}) {
  return new Promise((resolve, reject) => {
    const request = http.request(`${base}${pathname}`, { method, headers }, response => {
      const parts = []; response.on('data', part => parts.push(part)); response.once('error', reject);
      response.once('end', () => resolve({ status: response.statusCode, headers: response.headers, bytes: Buffer.concat(parts) }));
    });
    request.once('error', reject); request.setTimeout(10_000, () => request.destroy(new Error('test HTTP timeout'))); request.end();
  });
}
async function fixture(t) {
  const rootDir = await mkdtemp(path.join(os.tmpdir(), 'photo-static-http-'));
  const dataDir = path.join(rootDir, 'private-data');
  const samples = {
    '/index.html': Buffer.from('<!doctype html><title>private-cache-test</title>'),
    '/paid-config.js': Buffer.from("export const paidConfig = { apiBase: '' };\n"),
    '/vendor/sample.wasm': Buffer.concat([Buffer.from([0, 97, 115, 109, 1, 0, 0, 0]), Buffer.alloc(8192, 7)]),
    '/vendor/sample.tflite': Buffer.from('test-tflite-payload'.repeat(1000)),
    '/vendor/sample.js': Buffer.from('export const transportTest = true;\n'.repeat(500)),
    '/vendor/sample.mjs': Buffer.from('export const moduleTransportTest = true;\n'.repeat(500)),
    '/assets/example.jpg': randomBytes(1024),
    '/assets/nested.html': Buffer.from('<!doctype html><title>HTML remains uncached</title>'),
  };
  for (const [filename, bytes] of Object.entries(samples)) {
    const destination = path.join(rootDir, 'public', filename); await mkdir(path.dirname(destination), { recursive: true }); await writeFile(destination, bytes);
  }
  // Deliberately private fixture content; no real env, wallet or provider data.
  await writeFile(path.join(rootDir, '.env'), 'fixture-private-environment-only');
  const app = await createPaidServer({ config: { rootDir, dataDir, enabled: false, firstFree: true, allowedOrigins: ['http://localhost'] },
    provider: { preflight: async () => { throw new Error('disabled transport tests must not call provider'); } }, autoProcess: false });
  await new Promise(resolve => app.server.listen(0, '127.0.0.1', resolve));
  t.after(async () => { await app.close(); await rm(rootDir, { recursive: true, force: true }); });
  return { app, rootDir, dataDir, samples, base: `http://127.0.0.1:${app.server.address().port}` };
}

test('public vendor gzip preserves exact WASM/model/JS bytes and Content-Type with correct compressed lengths', async t => {
  const f = await fixture(t);
  const types = { wasm: 'application/wasm', tflite: 'application/octet-stream', js: 'text/javascript; charset=utf-8', mjs: 'text/javascript; charset=utf-8' };
  for (const [extension, type] of Object.entries(types)) {
    const filename = `/vendor/sample.${extension}`;
    const responses = await Promise.all(Array.from({ length: 4 }, () => rawRequest(f.base, filename, { headers: { 'Accept-Encoding': 'br, gzip;q=0.5' } })));
    for (const response of responses) {
      assert.equal(response.status, 200); assert.equal(response.headers['content-encoding'], 'gzip');
      assert.equal(response.headers['content-type'], type); assert.equal(response.headers.vary, 'Accept-Encoding');
      assert.equal(response.headers['cache-control'], 'public, max-age=3600, no-transform');
      assert.equal(Number(response.headers['content-length']), response.bytes.length);
      assert.deepEqual(gunzipSync(response.bytes), f.samples[filename]);
      assert.ok(response.bytes.length < f.samples[filename].length);
    }
  }
});

test('HEAD negotiates the same gzip/identity Content-Length as GET and has no body', async t => {
  const f = await fixture(t);
  for (const filename of ['/vendor/sample.wasm', '/vendor/sample.tflite', '/vendor/sample.js', '/assets/example.jpg', '/paid-config.js']) {
    for (const encoding of ['gzip', 'identity']) {
      const options = { headers: { 'Accept-Encoding': encoding } };
      const get = await rawRequest(f.base, filename, options);
      const head = await rawRequest(f.base, filename, { ...options, method: 'HEAD' });
      assert.equal(head.status, 200); assert.equal(head.bytes.length, 0);
      assert.equal(head.headers['content-length'], get.headers['content-length']);
      assert.equal(head.headers['content-encoding'], get.headers['content-encoding']);
      assert.equal(head.headers['content-type'], get.headers['content-type']);
      assert.equal(head.headers['cache-control'], get.headers['cache-control']);
    }
  }
});

test('gzip quality zero or absent explicit support always produces the original identity bytes', async t => {
  const f = await fixture(t);
  for (const encoding of [undefined, 'gzip;q=0', 'gzip;q=0.000, *;q=1', 'br, *;q=1', 'gzip;q=bogus', 'gzip;q=0, gzip;q=1']) {
    const response = await rawRequest(f.base, '/vendor/sample.wasm', { headers: encoding ? { 'Accept-Encoding': encoding } : {} });
    assert.equal(response.headers['content-encoding'], undefined); assert.equal(response.headers.vary, 'Accept-Encoding');
    assert.deepEqual(response.bytes, f.samples['/vendor/sample.wasm']); assert.equal(Number(response.headers['content-length']), response.bytes.length);
  }
});

test('API/private results/HTML/paid config/errors remain no-store and never enter public gzip handling', async t => {
  const f = await fixture(t); const id = randomUUID(); const token = randomBytes(32).toString('base64url');
  const privateResult = Buffer.from('private-result-fixture-only');
  await mkdir(path.join(f.dataDir, 'orders', id), { recursive: true }); await writeFile(path.join(f.dataDir, 'orders', id, 'result.jpg'), privateResult);
  await f.app.service.store.exclusive(async () => {
    f.app.service.store.state.orders[id] = { id, status: 'completed', tokenHash: createHash('sha256').update(token).digest('hex') };
    await f.app.service.store.save();
  });
  for (const pathname of ['/', '/index.html', '/assets/nested.html', '/paid-config.js', '/api/health', `/api/orders/${id}/result`, '/.env', '/private-data/orders.json', '/backend/server.mjs', '/vendor/missing.wasm']) {
    const headers = { 'Accept-Encoding': 'gzip', ...(pathname.endsWith('/result') ? { Authorization: `Bearer ${token}` } : {}) };
    const response = await rawRequest(f.base, pathname, { headers });
    assert.equal(response.headers['cache-control'], 'no-store', pathname); assert.equal(response.headers['content-encoding'], undefined, pathname);
    if (pathname.endsWith('/result')) { assert.equal(response.status, 200); assert.deepEqual(response.bytes, privateResult); }
    if (['/.env', '/private-data/orders.json', '/backend/server.mjs', '/vendor/missing.wasm'].includes(pathname)) {
      assert.equal(response.status, 404); assert.ok(!response.bytes.includes(privateResult)); assert.ok(!response.bytes.includes(Buffer.from('fixture-private-environment-only')));
    }
    if (pathname === '/paid-config.js') assert.match(response.bytes.toString('utf8'), /apiBase: '\/'/);
  }
  const image = await rawRequest(f.base, '/assets/example.jpg', { headers: { 'Accept-Encoding': 'gzip' } });
  assert.equal(image.headers['cache-control'], 'public, max-age=3600, no-transform'); assert.equal(image.headers['content-encoding'], undefined);
  assert.deepEqual(image.bytes, f.samples['/assets/example.jpg']);
  const unauthorized = await rawRequest(f.base, `/api/orders/${id}/result`, { headers: { 'Accept-Encoding': 'gzip' } });
  assert.equal(unauthorized.status, 404); assert.equal(unauthorized.headers['cache-control'], 'no-store'); assert.equal(unauthorized.headers['content-encoding'], undefined);
  const wrongMethod = await rawRequest(f.base, '/vendor/sample.wasm', { method: 'POST', headers: { 'Accept-Encoding': 'gzip' } });
  assert.equal(wrongMethod.status, 405); assert.equal(wrongMethod.headers['cache-control'], 'no-store'); assert.equal(wrongMethod.headers['content-encoding'], undefined);
});

test('gzip variants are invalidated when source mtime or size changes', async t => {
  const f = await fixture(t); const filename = path.join(f.rootDir, 'public', 'vendor', 'sample.js');
  const get = () => rawRequest(f.base, '/vendor/sample.js', { headers: { 'Accept-Encoding': 'gzip' } });
  const first = await get(); assert.deepEqual(gunzipSync(first.bytes), f.samples['/vendor/sample.js']);
  const sameSize = Buffer.alloc(f.samples['/vendor/sample.js'].length, 120);
  await writeFile(filename, sameSize); const modified = new Date(Date.now() + 2000); await utimes(filename, modified, modified);
  assert.deepEqual(gunzipSync((await get()).bytes), sameSize);
  const changedSize = Buffer.concat([sameSize, Buffer.from('more-source-bytes')]); await writeFile(filename, changedSize);
  const third = await get(); assert.deepEqual(gunzipSync(third.bytes), changedSize); assert.equal(Number(third.headers['content-length']), third.bytes.length);
});

test('the actual 11.76 MB MediaPipe WASM crosses the HTTP boundary gzipped and decodes byte-for-byte', async t => {
  const f = await fixture(t);
  const original = await readFile(path.join(gameRoot, 'public', 'vendor', 'mediapipe', 'wasm', 'vision_wasm_internal.wasm'));
  await writeFile(path.join(f.rootDir, 'public', 'vendor', 'sample.wasm'), original);
  const response = await rawRequest(f.base, '/vendor/sample.wasm', { headers: { 'Accept-Encoding': 'gzip' } });
  assert.equal(response.headers['content-encoding'], 'gzip'); assert.equal(response.headers['content-type'], 'application/wasm');
  assert.equal(Number(response.headers['content-length']), response.bytes.length); assert.deepEqual(gunzipSync(response.bytes), original);
  assert.ok(response.bytes.length < original.length / 2, 'large WASM transfer must materially shrink');
  t.diagnostic(`Original WASM ${original.length} bytes; gzip wire payload ${response.bytes.length} bytes`);
});
