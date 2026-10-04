import test from 'node:test';
import { protectionConfig, fakeTurnstileFetch, createWithProof, authorizeWithProof, trialWithProof, proofBody, challengeToken, deviceFor } from './helpers/paid-protection-fixture.mjs';
import assert from 'node:assert/strict';
import { mkdtemp, rm } from 'node:fs/promises';
import { setImmediate as tick } from 'node:timers/promises';
import os from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { Wallet } from 'ethers';
import sharp from 'sharp';
import { PaidService } from '../backend/service.mjs';
import { createPaidServer } from '../backend/server.mjs';

const rootDir = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const deferred = () => { let resolve; const promise = new Promise(done => { resolve = done; }); return { promise, resolve }; };
const chain = () => ({
  chainId: 56n,
  async getNetwork() { return { chainId: this.chainId }; },
  async getBlock() { return { number: 100, hash: `0x${'1'.repeat(64)}`, timestamp: Math.floor(Date.now() / 1000) }; },
});
function standalone(provider, network = chain(), config = {}) {
  return new PaidService({ dataDir: path.join(os.tmpdir(), 'health-no-store-needed'), enabled: true, firstFree: true, ...config }, network, provider);
}
async function fixture(t, provider) {
  const dataDir = await mkdtemp(path.join(os.tmpdir(), 'photo-health-test-'));
  const app = await createPaidServer({ config: { ...protectionConfig, rootDir, dataDir, enabled: true, firstFree: true, allowedOrigins: ['http://127.0.0.1:48123'] }, chain: chain(), provider, autoProcess: false, turnstileFetch: fakeTurnstileFetch });
  t.after(async () => { await app.close(); await rm(dataDir, { recursive: true, force: true }); });
  return app;
}

test('HTTP health remains immediate and fail-closed while startup preflight is blocked; concurrent reads share one check', async t => {
  const gate = deferred(); let checks = 0;
  const dataDir = await mkdtemp(path.join(os.tmpdir(), 'photo-health-http-'));
  const app = await createPaidServer({ config: { ...protectionConfig, rootDir, dataDir, enabled: true, firstFree: true, allowedOrigins: ['http://localhost'] },
    chain: chain(), provider: { preflight: async () => { checks++; return gate.promise; } }, autoProcess: false, turnstileFetch: fakeTurnstileFetch });
  t.after(async () => { gate.resolve({ ready: true }); await app.close(); await rm(dataDir, { recursive: true, force: true }); });
  await new Promise(resolve => app.server.listen(0, '127.0.0.1', resolve));
  const base = `http://127.0.0.1:${app.server.address().port}`;
  const started = performance.now();
  const responses = await Promise.all(Array.from({ length: 20 }, async () => {
    const response = await fetch(`${base}/api/health`, { signal: AbortSignal.timeout(1000) });
    assert.equal(response.status, 200); assert.equal(response.headers.get('cache-control'), 'no-store');
    return response.json();
  }));
  assert.ok(performance.now() - started < 1000, 'health must not await the blocked preflight');
  for (const response of responses) {
    assert.equal(response.ready, false); assert.equal(response.checking, true);
    assert.equal(response.reason, '正在核验 AI 服务，请稍后重试');
    assert.equal(response.priceBnb, '0.001'); assert.equal(response.priceWei, '1000000000000000'); assert.equal(response.firstFree, true);
  }
  assert.equal(checks, 1);
  gate.resolve({ ready: true }); await app.service.healthFlight;
  assert.equal((await (await fetch(`${base}/api/health`)).json()).ready, true);
});

test('cached success refreshes once after 20 seconds, expires at 60 seconds, and failure immediately removes old readiness', async () => {
  const gate = deferred(); let checks = 0;
  const service = standalone({ preflight: async () => ++checks === 1 ? { ready: true } : gate.promise });
  try {
    assert.equal((await service.ready(true)).ready, true);
    for (let index = 0; index < 20; index++) assert.equal(service.ready().ready, true);
    assert.equal(checks, 1);
    service.healthCache.at = Date.now() - 20_001;
    for (let index = 0; index < 30; index++) {
      const snapshot = service.ready(); assert.equal(snapshot.ready, true); assert.equal(snapshot.refreshing, true);
    }
    await tick(); assert.equal(checks, 2);
    service.healthCache.at = Date.now() - 60_001;
    const expired = service.ready(); assert.equal(expired.ready, false); assert.equal(expired.checking, true);
    assert.equal(checks, 2, 'a pending refresh must not spawn another check');
    gate.resolve({ ready: false, reason: 'provider stopped' }); await service.healthFlight;
    const failed = service.ready(); assert.equal(failed.ready, false); assert.equal(failed.reason, 'provider stopped');
    assert.equal(checks, 2);
  } finally { gate.resolve({ ready: false }); await service.close(); }
});

test('fresh requests arriving during an older health check wait for their own deduplicated later round', async () => {
  const gates = [deferred(), deferred()]; let checks = 0; let active = 0; let maximumActive = 0;
  const service = standalone({ preflight: async () => {
    const index = checks++; active++; maximumActive = Math.max(maximumActive, active);
    try { return await gates[index].promise; } finally { active--; }
  } });
  try {
    assert.equal(service.ready().checking, true); await tick(); assert.equal(checks, 1);
    let completed = 0;
    const fresh = Array.from({ length: 8 }, () => service.ready(true).then(value => { completed++; return value; }));
    gates[0].resolve({ ready: true }); await tick();
    assert.equal(checks, 2); assert.equal(completed, 0, 'older success cannot complete fresh requests');
    gates[1].resolve({ ready: false, reason: 'new check failed' });
    for (const value of await Promise.all(fresh)) { assert.equal(value.ready, false); assert.equal(value.reason, 'new check failed'); }
    assert.equal(maximumActive, 1); assert.equal(service.ready().ready, false);
  } finally { for (const gate of gates) gate.resolve({ ready: false }); await service.close(); }
});

test('a fresh request cannot join another fresh check which already started', async () => {
  const gates = [deferred(), deferred()]; let checks = 0;
  const service = standalone({ preflight: async () => gates[checks++].promise });
  try {
    const first = service.ready(true); await tick(); assert.equal(checks, 1);
    let laterCompleted = false;
    const second = service.ready(true).then(value => { laterCompleted = true; return value; });
    const third = service.ready(true);
    gates[0].resolve({ ready: true }); assert.equal((await first).ready, true); await tick();
    assert.equal(checks, 2); assert.equal(laterCompleted, false);
    gates[1].resolve({ ready: true }); assert.equal((await second).ready, true); assert.equal((await third).ready, true);
    assert.equal(checks, 2);
  } finally { for (const gate of gates) gate.resolve({ ready: false }); await service.close(); }
});

test('new order and signed free authorization fail fresh without using an old successful snapshot', async t => {
  let available = true;
  const app = await fixture(t, { preflight: async () => ({ ready: available, reason: 'latest unavailable' }) });
  await app.service.ready(true);
  const wallet = Wallet.createRandom();
  const photoDataUrl = `data:image/jpeg;base64,${(await sharp({ create: { width: 128, height: 128, channels: 3, background: '#caa' } }).jpeg().toBuffer()).toString('base64')}`;
  const body = { payerAddress: wallet.address, photoDataUrl, character: 'cz', scene: 'cafe', expectedBillingMode: 'free_trial' };
  available = false;
  await assert.rejects(createWithProof(app.service, body), { code: 'SERVICE_UNAVAILABLE' });
  assert.equal(Object.keys(app.service.store.state.orders).length, 0); assert.equal(app.service.ready().ready, false);
  available = true;
  const order = await createWithProof(app.service, body); assert.equal(app.service.ready().ready, true);
  available = false;
  await assert.rejects(authorizeWithProof(app.service, order.id, order.token, await wallet.signMessage(order.signatureMessage)), { code: 'SERVICE_UNAVAILABLE' });
  const stored = app.service.store.state.orders[order.id];
  assert.equal(stored.status, 'awaiting_authorization'); assert.equal(stored.authorizedAt, undefined); assert.equal(stored.payment, undefined);
  assert.deepEqual(app.service.store.state.consumedTrials, {}); assert.equal(app.service.ready().ready, false);
});

test('invalidating capacity discards successful results of checks which started before invalidation', async () => {
  const gate = deferred(); let checks = 0;
  const service = standalone({ preflight: async () => ++checks === 1 ? { ready: true } : gate.promise });
  try {
    await service.ready(true); service.healthCache.at = Date.now() - 20_001;
    assert.equal(service.ready().ready, true); await tick(); const oldFlight = service.healthFlight;
    service.invalidateHealth(); gate.resolve({ ready: true }); await oldFlight;
    assert.equal(service.healthCache, undefined, 'an older successful check cannot restore invalidated ready state');
    assert.equal(service.ready().ready, false);
  } finally { gate.resolve({ ready: false }); await service.close(); }
});

test('the final generation invalidates health throughout submission and leaves it unready after the budget is exhausted', async t => {
  const entered = deferred(); const release = deferred(); let remaining = 1; let submissions = 0;
  t.after(() => release.resolve());
  const provider = {
    preflight: async () => ({ ready: remaining > 0, remainingGenerations: remaining, reason: '本期 AI 合影名额已用完' }),
    submit: async () => { submissions++; remaining = 0; entered.resolve(); await release.promise; return { providerJobId: 'mock-only-job' }; },
    poll: async () => ({ status: 'pending' }),
  };
  const app = await fixture(t, provider);
  const wallet = Wallet.createRandom();
  const photoDataUrl = `data:image/jpeg;base64,${(await sharp({ create: { width: 128, height: 128, channels: 3, background: '#aac' } }).jpeg().toBuffer()).toString('base64')}`;
  const order = await createWithProof(app.service, { payerAddress: wallet.address, photoDataUrl, character: 'heyi', scene: 'cafe', expectedBillingMode: 'free_trial' });
  await authorizeWithProof(app.service, order.id, order.token, await wallet.signMessage(order.signatureMessage));
  const processing = app.service.processQueue(); await entered.promise;
  assert.equal(app.service.ready().ready, false); assert.equal(app.service.ready().checking, true);
  await assert.rejects(app.service.requireReady(), { code: 'SERVICE_UNAVAILABLE' });
  release.resolve(); await processing; await tick(); await app.service.healthFlight;
  const exhausted = app.service.ready(); assert.equal(exhausted.ready, false); assert.equal(exhausted.reason, '本期 AI 合影名额已用完');
  assert.equal(submissions, 1); assert.equal(app.service.store.state.consumedTrials[wallet.address.toLowerCase()], order.id);
});

test('fresh RPC failure invalidates cached success and disabled health never calls the provider', async () => {
  let checks = 0; const network = chain();
  const service = standalone({ preflight: async () => { checks++; return { ready: true }; } }, network);
  try {
    assert.equal((await service.ready(true)).ready, true);
    network.chainId = 1n;
    assert.equal((await service.ready(true)).ready, false); assert.equal(service.ready().ready, false);
    assert.equal(checks, 2);
    service.config.enabled = false;
    const disabled = service.ready(); assert.equal(disabled.ready, false); assert.equal(disabled.checking, undefined);
    assert.equal(disabled.firstFree, true); assert.equal(disabled.priceBnb, '0.001'); assert.equal(checks, 2);
  } finally { await service.close(); }
});
