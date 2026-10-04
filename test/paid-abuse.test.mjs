import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtemp, readFile, writeFile, rm } from 'node:fs/promises';
import { randomBytes, randomUUID } from 'node:crypto';
import os from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { Wallet } from 'ethers';
import sharp from 'sharp';
import { createPaidServer, createTurnstileVerifier, visitorIp, loadConfig } from '../backend/server.mjs';
import { OrderStore } from '../backend/store.mjs';
import { protectionConfig, fakeTurnstileFetch, challengeToken, deviceFor } from './helpers/paid-protection-fixture.mjs';

const rootDir = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const photoDataUrl = `data:image/jpeg;base64,${(await sharp({ create: { width: 96, height: 96, channels: 3, background: '#aca' } }).jpeg().toBuffer()).toString('base64')}`;
const newDevice = () => randomBytes(32).toString('base64url');
const context = (deviceId, ip = '203.0.113.30') => ({ deviceId, ip, hostname: '127.0.0.1' });
const day = value => new Date(value + 8 * 60 * 60_000).toISOString().slice(0, 10);
async function fixture(t, configOverrides = {}, fetcher = fakeTurnstileFetch) {
  const dataDir = await mkdtemp(path.join(os.tmpdir(), 'photo-abuse-test-'));
  const config = { ...protectionConfig, rootDir, dataDir, enabled: true, firstFree: true, allowedOrigins: ['http://127.0.0.1'], ...configOverrides };
  let submissions = 0;
  const chain = { async getNetwork() { return { chainId: 56n }; }, async getBlock() { return { number: 100, hash: `0x${'a'.repeat(64)}`, timestamp: Math.floor(Date.now() / 1000) }; } };
  const provider = { preflight: async () => ({ ready: true, remainingGenerations: 100 - submissions }), submit: async () => { submissions++; return { providerJobId: 'mock-only-job' }; }, poll: async (_id, job) => ({ status: 'succeeded', resultPath: job.inputPath }) };
  const app = await createPaidServer({ config, chain, provider, autoProcess: false, turnstileFetch: fetcher });
  t.after(async () => { await app.close(); await rm(dataDir, { recursive: true, force: true }); });
  const create = (wallet, deviceId, ip = '203.0.113.30', extra = {}) => app.service.create({ payerAddress: wallet.address, photoDataUrl, character: 'cz', scene: 'cafe', trialDeviceId: deviceId, turnstileToken: challengeToken('photo_order', deviceId), ...extra }, context(deviceId, ip));
  const authorize = async (order, wallet, deviceId, ip = '203.0.113.30', extra = {}) => app.service.authorize(order.id, order.token, await wallet.signMessage(order.signatureMessage), { ...context(deviceId, ip), turnstileToken: challengeToken('photo_trial', deviceId), ...extra });
  return { app, config, chain, provider, create, authorize, submissions: () => submissions };
}

test('protection config has strict free limits and five-minute paid quotes; public health exposes no secrets', async t => {
  const defaults = loadConfig({});
  assert.equal(defaults.trialTotalLimit, 20); assert.equal(defaults.trialDailyLimit, 5); assert.equal(defaults.trialIpDailyLimit, 2); assert.equal(defaults.paidOrderTtlMs, 300000);
  assert.equal(defaults.trustCloudflareLoopbackProxy, false);
  const f = await fixture(t);
  const health = await f.app.service.ready(true);
  assert.equal(health.trialPolicy, 'wallet_device_ip_limits');
  assert.deepEqual(health.turnstile, { required: true, siteKey: 'unit-test-sitekey', orderAction: 'photo_order', trialAction: 'photo_trial', checkAction: 'photo_check' });
  assert.deepEqual(health.trialLimits, { total: 20, daily: 5, ipDaily: 2, deviceLifetime: 1, dayTimezone: 'Asia/Shanghai' });
  assert.equal(JSON.stringify(health).includes(f.config.turnstileSecret), false); assert.equal(JSON.stringify(health).includes(f.config.trialHmacSecret), false);
});

test('Siteverify requires success, current origin hostname, expected action and bound device cData', async () => {
  const deviceId = newDevice(); const details = { ...context(deviceId), action: 'photo_order' };
  for (const invalid of [{ success: false }, { action: 'photo_trial' }, { hostname: 'localhost' }, { hostname: 'attacker.example' }, { cdata: newDevice() }]) {
    const verify = createTurnstileVerifier(protectionConfig, async () => ({ ok: true, json: async () => ({ success: true, action: 'photo_order', hostname: '127.0.0.1', cdata: deviceId, ...invalid }) }));
    await assert.rejects(verify(challengeToken('photo_order', deviceId), details), { code: 'CHALLENGE_FAILED' });
  }
  const accepted = createTurnstileVerifier(protectionConfig, fakeTurnstileFetch);
  await accepted(challengeToken('photo_order', deviceId), details);
});

test('missing challenge or unavailable configuration never calls siteverify; network and malformed results fail closed', async () => {
  const deviceId = newDevice(); const details = { ...context(deviceId), action: 'photo_order' }; let calls = 0;
  const verify = createTurnstileVerifier(protectionConfig, async () => { calls++; throw new Error('should not call'); });
  for (const token of [undefined, '', 'x'.repeat(2049)]) await assert.rejects(verify(token, details), { code: 'CHALLENGE_REQUIRED' });
  assert.equal(calls, 0);
  await assert.rejects(createTurnstileVerifier({ ...protectionConfig, turnstileSecret: '' }, fakeTurnstileFetch)('token', details), { code: 'CHALLENGE_UNAVAILABLE' });
  for (const fetcher of [async () => { throw new Error('offline'); }, async () => ({ ok: false }), async () => ({ ok: true, json: async () => { throw new Error('not json'); } })]) {
    await assert.rejects(createTurnstileVerifier(protectionConfig, fetcher)('token', details), { code: 'CHALLENGE_FAILED' });
  }
});

test('a token is reserved before siteverify; simultaneous replay and later replay both fail', async () => {
  let release; const gate = new Promise(resolve => { release = resolve; }); let calls = 0;
  const deviceId = newDevice(), token = challengeToken('photo_order', deviceId), details = { ...context(deviceId), action: 'photo_order' };
  const verify = createTurnstileVerifier(protectionConfig, async (...args) => { calls++; await gate; return fakeTurnstileFetch(...args); });
  const first = verify(token, details);
  await assert.rejects(verify(token, details), { code: 'CHALLENGE_REPLAYED' });
  release(); await first; await assert.rejects(verify(token, details), { code: 'CHALLENGE_REPLAYED' }); assert.equal(calls, 1);
});

test('forwarded visitor IP is ignored by default and only trusted for explicitly configured loopback ingress', () => {
  const request = (peer, value, method = 'POST', url = '/api/orders') => ({ socket: { remoteAddress: peer }, headers: { 'cf-connecting-ip': value, 'x-forwarded-for': 'attacker' }, method, url });
  assert.equal(visitorIp(request('198.51.100.9', '203.0.113.4'), {}), '198.51.100.9');
  const trusted = { host: '127.0.0.1', trustCloudflareLoopbackProxy: true };
  assert.equal(visitorIp(request('127.0.0.1', '203.0.113.4'), trusted), '203.0.113.4');
  assert.throws(() => visitorIp(request('198.51.100.9', '203.0.113.4'), trusted), { code: 'UNTRUSTED_PROXY' });
  assert.throws(() => visitorIp(request('127.0.0.1', '203.0.113.4'), { ...trusted, host: '0.0.0.0' }), { code: 'UNTRUSTED_PROXY' });
  for (const header of [undefined, 'invalid', '203.0.113.4,198.51.100.9', ['203.0.113.4']]) assert.throws(() => visitorIp(request('127.0.0.1', header), trusted), { code: 'VISITOR_IP_REQUIRED' });
  assert.equal(visitorIp(request('127.0.0.1', undefined, 'GET', '/api/health'), trusted), '127.0.0.1');
});

test('HTTP order challenge is enforced before persistence; safe human-check has no order or entitlement side effects', async t => {
  let verifications = 0; const f = await fixture(t, {}, async (...args) => { verifications++; return fakeTurnstileFetch(...args); });
  await new Promise(resolve => f.app.server.listen(0, '127.0.0.1', resolve));
  const base = `http://127.0.0.1:${f.app.server.address().port}`, headers = { Origin: 'http://127.0.0.1', 'Content-Type': 'application/json' };
  const wallet = Wallet.createRandom(), trialDeviceId = newDevice();
  const body = { payerAddress: wallet.address, photoDataUrl, character: 'cz', scene: 'cafe', trialDeviceId, expectedBillingMode: 'free_trial' };
  const missing = await fetch(`${base}/api/orders`, { method: 'POST', headers, body: JSON.stringify(body) });
  assert.equal(missing.status, 403); assert.equal((await missing.json()).error.code, 'CHALLENGE_REQUIRED');
  const token = challengeToken('photo_check', trialDeviceId);
  const check = async () => fetch(`${base}/api/human-check`, { method: 'POST', headers, body: JSON.stringify({ trialDeviceId, turnstileToken: token }) });
  const success = await check(); assert.equal(success.status, 200); assert.deepEqual(await success.json(), { verified: true });
  const replay = await check(); assert.equal(replay.status, 403); assert.equal((await replay.json()).error.code, 'CHALLENGE_REPLAYED');
  const wrongAction = await fetch(`${base}/api/orders`, { method: 'POST', headers, body: JSON.stringify({ ...body, turnstileToken: challengeToken('photo_check', trialDeviceId) }) });
  assert.equal(wrongAction.status, 403);
  const wrongOrigin = await fetch(`${base}/api/human-check`, { method: 'POST', headers: { ...headers, Origin: 'https://attacker.example' }, body: JSON.stringify({ trialDeviceId, turnstileToken: challengeToken('photo_check', trialDeviceId) }) });
  assert.equal(wrongOrigin.status, 403);
  assert.equal(verifications, 2); assert.deepEqual(f.app.service.store.state.consumedTrials, {}); assert.deepEqual(f.app.service.store.state.trialClaims, {});
  assert.equal(Object.keys(f.app.service.store.state.orders).length, 0); assert.equal(f.submissions(), 0);
});

test('new HTTP order tokens cannot be reused for another order or a first-free grant', async t => {
  const f = await fixture(t), wallet = Wallet.createRandom(), deviceId = newDevice();
  const token = challengeToken('photo_order', deviceId);
  const order = await f.create(wallet, deviceId, undefined, { turnstileToken: token });
  await assert.rejects(f.create(Wallet.createRandom(), deviceId, undefined, { turnstileToken: token }), { code: 'CHALLENGE_REPLAYED' });
  await assert.rejects(f.authorize(order, wallet, deviceId, undefined, { turnstileToken: undefined }), { code: 'CHALLENGE_REQUIRED' });
  await assert.rejects(f.authorize(order, wallet, deviceId, undefined, { turnstileToken: token }), { code: 'CHALLENGE_REPLAYED' });
  await assert.rejects(f.authorize(order, wallet, newDevice()), { code: 'DEVICE_MISMATCH' });
  assert.deepEqual(f.app.service.store.state.consumedTrials, {}); assert.equal(f.submissions(), 0);
  await f.authorize(order, wallet, deviceId);
  const claim = f.app.service.store.state.trialClaims[order.id];
  assert.match(claim.deviceHash, /^[a-f0-9]{64}$/); assert.match(claim.ipHash, /^[a-f0-9]{64}$/);
  assert.equal(JSON.stringify(claim).includes(deviceId), false); assert.equal(JSON.stringify(claim).includes('203.0.113.30'), false);
  await f.app.service.authorize(order.id, order.token, 'ignored duplicate');
  assert.equal(Object.keys(f.app.service.store.state.trialClaims).length, 1);
});

test('legacy unsigned free quotes must pass a fresh challenge and bind a device without rewriting the old signature', async t => {
  const f = await fixture(t), wallet = Wallet.createRandom(), deviceId = newDevice();
  const order = await f.create(wallet, deviceId);
  const saved = f.app.service.store.state.orders[order.id]; delete saved.protectionVersion; delete saved.trialIdentity;
  const original = saved.signatureMessage;
  assert.equal((await f.app.service.get(order.id, order.token)).trialChallengeRequired, true);
  await assert.rejects(f.app.service.authorize(order.id, order.token, await wallet.signMessage(original)), { code: 'DEVICE_REQUIRED' });
  const boundDevice = newDevice();
  await assert.rejects(f.authorize(order, wallet, boundDevice, undefined, { turnstileToken: undefined }), { code: 'CHALLENGE_REQUIRED' });
  await f.authorize(order, wallet, boundDevice); assert.equal(saved.signatureMessage, original);
  assert.equal(f.app.service.store.state.trialClaims[order.id].legacy, false);
  await f.app.service.processQueue();
  assert.equal((await f.app.service.get(order.id, order.token)).trialChallengeRequired, false);
  assert.equal((await f.app.service.result(order.id, order.token)).length > 0, true);
  assert.equal(f.submissions(), 1);
});

test('another wallet on a consumed browser is denied a free grant and is never silently changed to paid', async t => {
  const f = await fixture(t), firstWallet = Wallet.createRandom(), deviceId = newDevice();
  const first = await f.create(firstWallet, deviceId); await f.authorize(first, firstWallet, deviceId); await f.app.service.processQueue();
  const other = Wallet.createRandom();
  const preview = await f.app.service.trial(other.address, context(deviceId));
  assert.deepEqual(preview, { eligible: false, available: true, blockReason: 'device_used', policy: 'wallet_device_ip_limits' });
  await assert.rejects(f.create(other, deviceId), { code: 'TRIAL_LIMIT_REACHED' });
  await assert.rejects(f.create(other, deviceId, undefined, { expectedBillingMode: 'free_trial' }), { code: 'TRIAL_LIMIT_REACHED' });
  const paid = await f.create(other, deviceId, undefined, { expectedBillingMode: 'paid' });
  assert.equal(paid.billingMode, 'paid'); assert.equal(paid.priceBnb, '0.001'); assert.equal(paid.expiresAt - paid.createdAt, 300000);
  assert.equal(f.submissions(), 1);
});

test('two first-free claims exhaust one visitor IP for the Shanghai day without exhausting the global pool', async t => {
  const f = await fixture(t);
  for (let index = 0; index < 2; index++) {
    const wallet = Wallet.createRandom(), deviceId = newDevice(), order = await f.create(wallet, deviceId);
    await f.authorize(order, wallet, deviceId); await f.app.service.processQueue();
  }
  const other = Wallet.createRandom(), deviceId = newDevice();
  assert.deepEqual(await f.app.service.trial(other.address, context(deviceId)), { eligible: false, available: true, blockReason: 'ip_daily_limit', policy: 'wallet_device_ip_limits' });
  assert.equal((await f.app.service.trial(other.address, context(deviceId, '203.0.113.31'))).eligible, true);
  await assert.rejects(f.create(other, deviceId), { code: 'TRIAL_LIMIT_REACHED' }); assert.equal(f.submissions(), 2);
});

test('five daily free claims pause free checkout explicitly; next day resets only daily counters', async t => {
  const f = await fixture(t);
  for (let index = 0; index < 5; index++) {
    const wallet = Wallet.createRandom(), deviceId = newDevice(), ip = `203.0.113.${40 + index}`, order = await f.create(wallet, deviceId, ip);
    await f.authorize(order, wallet, deviceId, ip); await f.app.service.processQueue();
  }
  const sixth = Wallet.createRandom(), deviceId = newDevice(), ip = '203.0.113.50';
  assert.deepEqual(await f.app.service.trial(sixth.address, context(deviceId, ip)), { eligible: false, available: false, blockReason: 'daily_limit', policy: 'wallet_device_ip_limits' });
  await assert.rejects(f.create(sixth, deviceId, ip, { expectedBillingMode: 'free_trial' }), { code: 'TRIAL_LIMIT_REACHED' });
  for (const claim of Object.values(f.app.service.store.state.trialClaims)) { claim.reservedAt -= 24 * 60 * 60_000; claim.day = day(claim.reservedAt); }
  assert.equal((await f.app.service.trial(sixth.address, context(deviceId, ip))).eligible, true);
  assert.equal(Object.keys(f.app.service.store.state.consumedTrials).length, 5); assert.equal(f.submissions(), 5);
});

test('cumulative free cap preserves the paid pool and requires an explicit paid choice', async t => {
  const f = await fixture(t);
  const yesterday = Date.now() - 24 * 60 * 60_000;
  for (let index = 0; index < 20; index++) {
    const wallet = Wallet.createRandom(), id = randomUUID();
    f.app.service.store.state.consumedTrials[wallet.address.toLowerCase()] = id;
    f.app.service.store.state.trialClaims[id] = { legacy: true, reservedAt: yesterday, day: day(yesterday) };
  }
  const wallet = Wallet.createRandom(), deviceId = newDevice();
  assert.deepEqual(await f.app.service.trial(wallet.address, context(deviceId)), { eligible: false, available: false, blockReason: 'total_limit', policy: 'wallet_device_ip_limits' });
  await assert.rejects(f.create(wallet, deviceId), { code: 'TRIAL_LIMIT_REACHED' });
  const paid = await f.create(wallet, deviceId, undefined, { expectedBillingMode: 'paid' }); await f.authorize(paid, wallet, deviceId);
  assert.equal((await f.app.service.get(paid.id, paid.token)).status, 'awaiting_payment'); assert.equal(paid.priceBnb, '0.001');
  assert.equal(Object.keys(f.app.service.store.state.trialClaims).length, 20); assert.equal(f.submissions(), 0);
});

test('v2 migration preserves completed orders, wallet/transaction ledgers and signed values while counting historical free usage', async t => {
  const f = await fixture(t), wallet = Wallet.createRandom(), deviceId = newDevice();
  const order = await f.create(wallet, deviceId); await f.authorize(order, wallet, deviceId); await f.app.service.processQueue();
  const oldOrders = JSON.parse(JSON.stringify(f.app.service.store.state.orders)), oldTrials = structuredClone(f.app.service.store.state.consumedTrials);
  f.app.service.store.state.version = 2; delete f.app.service.store.state.trialClaims;
  const oldTxHash = `0x${'b'.repeat(64)}`; f.app.service.store.state.consumedTransactions[oldTxHash] = 'historical-paid-order';
  await f.app.service.store.save(); await f.app.close();
  const reopened = await createPaidServer({ config: f.config, chain: f.chain, provider: f.provider, autoProcess: false, turnstileFetch: fakeTurnstileFetch });
  try {
    assert.equal(reopened.service.store.state.version, 3); assert.deepEqual(reopened.service.store.state.orders, oldOrders); assert.deepEqual(reopened.service.store.state.consumedTrials, oldTrials);
    assert.equal(reopened.service.store.state.consumedTransactions[oldTxHash], 'historical-paid-order'); assert.equal(Object.keys(reopened.service.store.state.trialClaims).length, 1);
    assert.equal((await reopened.service.get(order.id, order.token)).status, 'completed');
    assert.equal((await reopened.service.result(order.id, order.token)).length > 0, true);
    await reopened.service.authorize(order.id, order.token, 'no new signature/captcha'); assert.equal(f.submissions(), 1);
  } finally { await reopened.close(); }
});

test('damaged v3 claim state fails closed instead of resetting free counters', async t => {
  const f = await fixture(t), wallet = Wallet.createRandom(), deviceId = newDevice();
  const order = await f.create(wallet, deviceId); await f.authorize(order, wallet, deviceId); await f.app.close();
  const filename = path.join(f.config.dataDir, 'orders.json'), saved = JSON.parse(await readFile(filename, 'utf8'));
  for (const trialClaims of [undefined, [], {}, { [order.id]: { legacy: false, reservedAt: Date.now(), day: day(Date.now()), deviceHash: 'invalid', ipHash: 'invalid' } }]) {
    const damaged = { ...saved, trialClaims }; await writeFile(filename, JSON.stringify(damaged));
    const store = new OrderStore(f.config.dataDir); await assert.rejects(store.open(), /claim ledger|claim identity/); assert.equal(await readFile(filename, 'utf8'), JSON.stringify(damaged));
  }
});

test('free cap cannot be configured to consume the entire provider generation budget', async t => {
  const f = await fixture(t, { generationBudget: 20, trialTotalLimit: 20 });
  await assert.rejects(f.create(Wallet.createRandom(), newDevice()), { code: 'TRIAL_CONFIG' }); assert.equal(f.submissions(), 0);
});

test('new five-minute paid reservations free the slot after expiry; legacy signed expiry is preserved', async t => {
  const f = await fixture(t, { firstFree: false }), firstWallet = Wallet.createRandom(), deviceId = newDevice();
  const first = await f.create(firstWallet, deviceId); await f.authorize(first, firstWallet, deviceId);
  const otherWallet = Wallet.createRandom(), otherDevice = newDevice(), second = await f.create(otherWallet, otherDevice);
  await assert.rejects(f.authorize(second, otherWallet, otherDevice), { code: 'RESERVATION_BUSY' });
  const saved = f.app.service.store.state.orders[first.id], originalMessage = saved.signatureMessage;
  saved.expiresAt = Date.now() - 1;
  await f.authorize(second, otherWallet, otherDevice); assert.equal((await f.app.service.get(second.id, second.token)).status, 'awaiting_payment');
  assert.equal(saved.signatureMessage, originalMessage); assert.equal(f.submissions(), 0);
});
