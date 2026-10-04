import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtemp, rm, readFile, writeFile } from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { randomBytes } from 'node:crypto';
import { Wallet, getAddress } from 'ethers';
import sharp from 'sharp';
import { createPaidServer, loadConfig } from '../backend/server.mjs';
import { OrderStore } from '../backend/store.mjs';
import { PRICE_WEI, PRICE_BNB, RECIPIENT } from '../backend/payment.mjs';

const rootDir = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const photoDataUrl = `data:image/jpeg;base64,${(await sharp({ create: { width: 512, height: 512, channels: 3, background: '#caa' } }).jpeg().toBuffer()).toString('base64')}`;
const hash = () => `0x${randomBytes(32).toString('hex')}`;
const expectedRecipient = '0xdC0A1628203953EB54Cb8649B0b0C228b1364f95';
const legacyRecipient = getAddress('0x7c4383da12264bed66d125ef34d4a4a8bb8979f2');

class FakeChain {
  constructor() { this.chainId = 56n; this.latest = 100; this.finalized = 100; this.transactions = new Map(); this.blocks = new Map(); this.now = Math.floor(Date.now() / 1000); }
  async getNetwork() { return { chainId: this.chainId }; }
  async getBlock(tag) {
    const number = tag === 'latest' ? this.latest : tag === 'finalized' ? this.finalized : tag;
    return this.blocks.get(number) || { number, hash: `0x${number.toString(16).padStart(64, '0')}`, timestamp: this.now };
  }
  async getTransaction(id) { return this.transactions.get(id)?.tx || null; }
  async getTransactionReceipt(id) { return this.transactions.get(id)?.receipt || null; }
  pay(order, changes = {}) {
    const id = hash(), number = order.startBlock + 1;
    const blockHash = `0x${number.toString(16).padStart(64, '0')}`;
    const tx = { hash: id, chainId: 56n, from: order.payerAddress, to: order.payment.to, value: BigInt(order.payment.valueWei), data: order.payment.data, blockNumber: number, blockHash, ...changes.tx };
    const receipt = { hash: id, from: tx.from, to: tx.to, status: 1, blockNumber: tx.blockNumber, blockHash: tx.blockHash, ...changes.receipt };
    this.latest = number + 2; this.finalized = number + 1;
    this.transactions.set(id, { tx, receipt });
    return id;
  }
}

async function fixture(t, overrides = {}) {
  const dataDir = await mkdtemp(path.join(os.tmpdir(), 'photo-paid-test-'));
  const chain = new FakeChain();
  const provider = { submissions: 0, polls: 0, preflight: async () => ({ ready: true, provider: 'libtv' }), submit: async () => { provider.submissions++; return { providerJobId: 'mock-existing-job' }; }, poll: async (id, job) => { provider.polls++; return { status: 'succeeded', resultPath: job.inputPath }; }, ...overrides.provider };
  const config = { rootDir, dataDir, enabled: true, firstFree: false, allowedOrigins: ['http://127.0.0.1:48123'], ...overrides.config };
  const app = await createPaidServer({ config, chain, provider, autoProcess: false });
  t.after(async () => { await app.close(); await rm(dataDir, { recursive: true, force: true }); });
  const wallet = Wallet.createRandom();
  const create = (w = wallet, body = {}) => app.service.create({ payerAddress: w.address, photoDataUrl, character: 'cz', scene: 'terrace', ...body });
  const authorize = async (order, w = wallet) => app.service.authorize(order.id, order.token, await w.signMessage(order.signatureMessage));
  return { app, chain, provider, wallet, config, create, authorize };
}

test('disabled service never accepts an order or calls generation', async t => {
  const f = await fixture(t, { config: { enabled: false } });
  assert.equal((await f.app.service.ready()).ready, false);
  await assert.rejects(f.create(), { code: 'SERVICE_UNAVAILABLE' });
  assert.equal(Object.keys(f.app.service.store.state.orders).length, 0);
  assert.equal(f.provider.submissions, 0);
});

test('image data is decoded, normalized and kept private; SVG/fake JPEG rejected', async t => {
  const f = await fixture(t);
  await assert.rejects(f.create(undefined, { photoDataUrl: 'data:image/svg+xml;base64,PHN2Zy8+' }), { code: 'INVALID_PHOTO' });
  await assert.rejects(f.create(undefined, { photoDataUrl: `data:image/jpeg;base64,${Buffer.from('not jpeg').toString('base64')}` }), { code: 'INVALID_PHOTO' });
  const order = await f.create();
  const photo = await readFile(path.join(f.config.dataDir, 'orders', order.id, 'input.jpg'));
  assert.equal((await sharp(photo).metadata()).format, 'jpeg');
  assert.equal(order.payment, undefined);
  await assert.rejects(f.app.service.result(order.id, order.token), { code: 'RESULT_NOT_READY' });
});

test('wallet signature binds exact order and a second wallet cannot authorize', async t => {
  const f = await fixture(t); const order = await f.create();
  await assert.rejects(f.authorize(order, Wallet.createRandom()), { code: 'WRONG_SIGNER' });
  await assert.rejects(f.app.service.authorize(order.id, order.token, '0x12'), { code: 'INVALID_SIGNATURE' });
  const authorized = await f.authorize(order);
  assert.equal(authorized.payment.valueWei, '1000000000000000');
  assert.equal(authorized.payment.chainId, 56);
  const other = await f.create(Wallet.createRandom());
  await assert.rejects(f.app.service.authorize(other.id, other.token, await f.wallet.signMessage(other.signatureMessage)), { code: 'WRONG_SIGNER' });
});

test('new paid checkout advertises and signs the new recipient consistently', async t => {
  const f = await fixture(t);
  assert.equal(RECIPIENT, expectedRecipient);
  await new Promise(resolve => f.app.server.listen(0, '127.0.0.1', resolve));
  const base = `http://127.0.0.1:${f.app.server.address().port}`;
  const headers = { 'Content-Type': 'application/json', Origin: f.config.allowedOrigins[0] };
  const health = await (await fetch(`${base}/api/health`)).json();
  assert.equal(health.recipient, expectedRecipient);
  const response = await fetch(`${base}/api/orders`, { method: 'POST', headers, body: JSON.stringify({ payerAddress: f.wallet.address, photoDataUrl, character: 'cz', scene: 'terrace', expectedBillingMode: 'paid' }) });
  assert.equal(response.status, 201);
  const order = await response.json();
  assert.equal(order.signatureMessage.split('\n').find(line => line.startsWith('Recipient: ')), `Recipient: ${expectedRecipient}`);
  const authorized = await f.authorize(order);
  assert.equal(authorized.payment.to, expectedRecipient);
  assert.equal(authorized.payment.chainId, 56);
  assert.equal(authorized.payment.valueWei, PRICE_WEI);
  assert.equal(f.provider.submissions, 0);
  assert.equal(f.chain.transactions.size, 0);
});

test('a new paid order rejects a transfer to the former recipient without granting credit', async t => {
  const f = await fixture(t); const order = await f.create(); await f.authorize(order);
  const id = f.chain.pay(f.app.service.store.state.orders[order.id], { tx: { to: legacyRecipient } });
  await assert.rejects(f.app.service.claim(order.id, order.token, id), { code: 'WRONG_RECIPIENT' });
  await f.app.service.processQueue();
  assert.equal((await f.app.service.get(order.id, order.token)).status, 'awaiting_payment');
  assert.equal(f.app.service.store.state.consumedTransactions[id], undefined);
  assert.equal(f.provider.submissions, 0);
});

for (const alreadyAuthorized of [false, true]) test(`restored legacy-recipient ${alreadyAuthorized ? 'authorized payment' : 'signed quote'} retains its address and rejects the new recipient`, async t => {
  const f = await fixture(t); const order = await f.create();
  let legacyMessage;
  await f.app.service.store.exclusive(async () => {
    const saved = f.app.service.store.state.orders[order.id];
    saved.payment.to = legacyRecipient;
    saved.signatureMessage = saved.signatureMessage.replace(`Recipient: ${RECIPIENT}`, `Recipient: ${legacyRecipient}`);
    legacyMessage = saved.signatureMessage;
    await f.app.service.store.save();
  });
  const legacySignature = await f.wallet.signMessage(legacyMessage);
  if (alreadyAuthorized) await f.app.service.authorize(order.id, order.token, legacySignature);
  const originalPayment = structuredClone(f.app.service.store.state.orders[order.id].payment);
  await f.app.close();
  const reopened = await createPaidServer({ config: f.config, chain: f.chain, provider: f.provider, autoProcess: false });
  try {
    assert.equal((await reopened.service.ready()).recipient, expectedRecipient);
    const stored = reopened.service.store.state.orders[order.id];
    assert.equal(stored.signatureMessage, legacyMessage);
    assert.deepEqual(stored.payment, originalPayment);
    const authorized = await reopened.service.authorize(order.id, order.token, legacySignature);
    assert.equal(authorized.payment.to, legacyRecipient);
    const wrongId = f.chain.pay(stored, { tx: { to: expectedRecipient } });
    await assert.rejects(reopened.service.claim(order.id, order.token, wrongId), { code: 'WRONG_RECIPIENT' });
    assert.equal(reopened.service.store.state.consumedTransactions[wrongId], undefined);
    assert.equal(f.provider.submissions, 0);
    const correctId = f.chain.pay(stored);
    await reopened.service.claim(order.id, order.token, correctId); await reopened.service.processQueue();
    assert.equal((await reopened.service.get(order.id, order.token)).status, 'completed');
    assert.equal(reopened.service.store.state.consumedTransactions[correctId], order.id);
    assert.equal(stored.signatureMessage, legacyMessage);
    assert.equal(stored.payment.to, legacyRecipient);
    assert.equal(f.provider.submissions, 1);
    const next = await reopened.service.create({ payerAddress: f.wallet.address, photoDataUrl, character: 'cz', scene: 'terrace', expectedBillingMode: 'paid' });
    assert.equal(next.signatureMessage.split('\n').find(line => line.startsWith('Recipient: ')), `Recipient: ${expectedRecipient}`);
    assert.equal((await reopened.service.authorize(next.id, next.token, await f.wallet.signMessage(next.signatureMessage))).payment.to, expectedRecipient);
  } finally { await reopened.close(); }
});

test('only one signed reservation opens payment while unsigned orders do not reserve quota', async t => {
  const f = await fixture(t); const first = await f.create();
  const secondWallet = Wallet.createRandom(); const second = await f.create(secondWallet);
  await f.authorize(first);
  await assert.rejects(f.authorize(second, secondWallet), { code: 'RESERVATION_BUSY' });
  assert.equal((await f.app.service.get(second.id, second.token)).payment, undefined);
});

test('an image decompression bomb is rejected before it is stored', async t => {
  const f = await fixture(t);
  const bomb = await sharp({ create: { width: 5000, height: 5000, channels: 3, background: '#fff' } }).png().toBuffer();
  await assert.rejects(f.create(undefined, { photoDataUrl: `data:image/png;base64,${bomb.toString('base64')}` }), { code: 'INVALID_PHOTO' });
  assert.equal(Object.keys(f.app.service.store.state.orders).length, 0);
});

test('unsupported finality or stale RPC closes checkout', async t => {
  const f = await fixture(t); f.chain.now = Math.floor(Date.now() / 1000) - 600;
  await assert.rejects(f.create(), { code: 'SERVICE_UNAVAILABLE' });
  f.chain.now = Math.floor(Date.now() / 1000);
  const original = f.chain.getBlock.bind(f.chain);
  f.chain.getBlock = async tag => tag === 'finalized' ? null : original(tag);
  await assert.rejects(f.create(), { code: 'SERVICE_UNAVAILABLE' }); assert.equal(f.provider.submissions, 0);
});

const invalid = [
  ['wrong sender', { tx: { from: Wallet.createRandom().address } }, 'WRONG_PAYER'],
  ['wrong recipient', { tx: { to: Wallet.createRandom().address } }, 'WRONG_RECIPIENT'],
  ['underpayment', { tx: { value: BigInt(PRICE_WEI) - 1n } }, 'WRONG_AMOUNT'],
  ['overpayment', { tx: { value: BigInt(PRICE_WEI) + 1n } }, 'WRONG_AMOUNT'],
  ['wrong chain', { tx: { chainId: 1n } }, 'WRONG_CHAIN'],
  ['wrong order data', { tx: { data: '0x' } }, 'WRONG_ORDER'],
  ['failed receipt', { receipt: { status: 0 } }, 'TX_FAILED'],
  ['receipt hash mismatch', { receipt: { hash: hash() } }, 'TX_MISMATCH'],
  ['old payment', { tx: { blockNumber: 100, blockHash: '0x' + '0'.repeat(62) + '64' } }, 'OLD_PAYMENT'],
  ['receipt sender mismatch', { receipt: { from: Wallet.createRandom().address } }, 'WRONG_PAYER'],
];
for (const [name, change, code] of invalid) test(`rejects ${name} without consuming generation`, async t => {
  const f = await fixture(t); const order = await f.create(); await f.authorize(order);
  const id = f.chain.pay(f.app.service.store.state.orders[order.id], change);
  await assert.rejects(f.app.service.claim(order.id, order.token, id), { code });
  await f.app.service.processQueue(); assert.equal(f.provider.submissions, 0);
  assert.equal(Object.keys(f.app.service.store.state.consumedTransactions).length, 0);
});

test('canonical block mismatch and non-finalized payments cannot trigger generation', async t => {
  const f = await fixture(t); const order = await f.create(); await f.authorize(order);
  const id = f.chain.pay(f.app.service.store.state.orders[order.id]);
  f.chain.blocks.set(101, { number: 101, hash: hash(), timestamp: f.chain.now });
  await assert.rejects(f.app.service.claim(order.id, order.token, id), { code: 'CHAIN_REORG' });
  f.chain.blocks.delete(101); f.chain.finalized = 100;
  const pending = await f.app.service.claim(order.id, order.token, id);
  assert.equal(pending.paymentStatus, 'pending'); await f.app.service.processQueue(); assert.equal(f.provider.submissions, 0);
  // The browser can now close: background verification finishes independently.
  f.chain.finalized = 102; await f.app.service.processQueue();
  assert.equal((await f.app.service.get(order.id, order.token)).status, 'completed'); assert.equal(f.provider.submissions, 1);
});

test('parallel duplicate claims produce one durable credit and one provider submission', async t => {
  const f = await fixture(t); const order = await f.create(); await f.authorize(order);
  const id = f.chain.pay(f.app.service.store.state.orders[order.id]);
  await Promise.all(Array.from({ length: 8 }, () => f.app.service.claim(order.id, order.token, id)));
  await Promise.all([f.app.service.processQueue(), f.app.service.processQueue()]);
  assert.equal(f.provider.submissions, 1);
  const persisted = JSON.parse(await readFile(path.join(f.config.dataDir, 'orders.json'), 'utf8'));
  assert.equal(persisted.consumedTransactions[id], order.id); assert.equal(persisted.orders[order.id].status, 'completed');
  const result = await f.app.service.result(order.id, order.token); assert.equal((await sharp(result).metadata()).format, 'jpeg');
  await assert.rejects(f.app.service.result(order.id, 'wrong'), { code: 'ORDER_NOT_FOUND' });
});

test('a consumed transaction cannot buy another order', async t => {
  const f = await fixture(t); const order = await f.create(); await f.authorize(order);
  const id = f.chain.pay(f.app.service.store.state.orders[order.id]); await f.app.service.claim(order.id, order.token, id); await f.app.service.processQueue();
  const wallet = Wallet.createRandom(); const second = await f.create(wallet); await f.authorize(second, wallet);
  await assert.rejects(f.app.service.claim(second.id, second.token, id), { code: 'TX_ALREADY_USED' });
  assert.equal(f.provider.submissions, 1);
});

test('late successful payment is preserved for operator review instead of disappearing', async t => {
  const f = await fixture(t); const order = await f.create(); await f.authorize(order);
  const stored = f.app.service.store.state.orders[order.id];
  const id = f.chain.pay(stored);
  f.chain.blocks.set(101, { number: 101, hash: f.chain.transactions.get(id).receipt.blockHash, timestamp: Math.ceil((stored.expiresAt + 1000) / 1000) });
  const result = await f.app.service.claim(order.id, order.token, id);
  assert.equal(result.status, 'review_required'); assert.equal(result.paymentStatus, 'verified');
  await f.app.service.processQueue(); assert.equal(f.provider.submissions, 0);
});

test('ambiguous submit failure never submits again on retry or restart', async t => {
  const f = await fixture(t, { provider: { submit: async () => { f.provider.submissions++; throw new Error('connection lost after acceptance'); } } });
  const order = await f.create(); await f.authorize(order); const id = f.chain.pay(f.app.service.store.state.orders[order.id]);
  await f.app.service.claim(order.id, order.token, id); await f.app.service.processQueue(); await f.app.service.processQueue();
  assert.equal((await f.app.service.get(order.id, order.token)).status, 'review_required');
  await assert.rejects(f.app.service.retry(order.id, order.token), { code: 'RETRY_UNAVAILABLE' }); assert.equal(f.provider.submissions, 1);
});

test('restart resumes a persisted provider job only by polling', async t => {
  const f = await fixture(t, { provider: { poll: async () => ({ status: 'pending' }) } });
  const order = await f.create(); await f.authorize(order); const id = f.chain.pay(f.app.service.store.state.orders[order.id]);
  await f.app.service.claim(order.id, order.token, id); await f.app.service.processQueue(); assert.equal(f.provider.submissions, 1);
  await f.app.close();
  const reopened = await createPaidServer({ config: f.config, chain: f.chain, provider: { preflight: async () => ({ ready: true }), submit: async () => { throw new Error('MUST NOT RESUBMIT'); }, poll: async (jobId, job) => ({ status: 'succeeded', resultPath: job.inputPath }) }, autoProcess: false });
  try { await reopened.service.processQueue(); assert.equal((await reopened.service.get(order.id, order.token)).status, 'completed'); }
  finally { await reopened.close(); }
});

test('persisted submission intent without job ID becomes review rather than resubmit', async t => {
  const f = await fixture(t); const order = await f.create(); await f.authorize(order); const id = f.chain.pay(f.app.service.store.state.orders[order.id]);
  await f.app.service.claim(order.id, order.token, id);
  await f.app.service.store.exclusive(async () => { const current = f.app.service.store.state.orders[order.id]; current.status = 'submitting'; current.submissionStartedAt = Date.now(); await f.app.service.store.save(); });
  await f.app.service.processQueue(); assert.equal(f.provider.submissions, 0); assert.equal((await f.app.service.get(order.id, order.token)).status, 'review_required');
});

test('a terminal provider failure retains payment and cannot silently consume another generation', async t => {
  const f = await fixture(t, { provider: { poll: async () => ({ status: 'failed' }) } });
  const order = await f.create(); await f.authorize(order); const id = f.chain.pay(f.app.service.store.state.orders[order.id]);
  await f.app.service.claim(order.id, order.token, id); await f.app.service.processQueue();
  const failed = await f.app.service.get(order.id, order.token); assert.equal(failed.status, 'failed'); assert.equal(failed.paymentStatus, 'verified');
  await assert.rejects(f.app.service.retry(order.id, order.token), { code: 'RETRY_UNAVAILABLE' });
  await f.app.service.processQueue(); assert.equal(f.provider.submissions, 1);
});

test('durable write failure rolls back a verified payment and prevents submission', async t => {
  const f = await fixture(t); const order = await f.create(); await f.authorize(order); const id = f.chain.pay(f.app.service.store.state.orders[order.id]);
  const original = f.app.service.store.save.bind(f.app.service.store); f.app.service.store.save = async () => { throw new Error('disk full'); };
  await assert.rejects(f.app.service.claim(order.id, order.token, id), /disk full/);
  f.app.service.store.save = original;
  assert.equal(f.app.service.store.state.orders[order.id].status, 'awaiting_payment');
  await f.app.service.processQueue(); assert.equal(f.provider.submissions, 0);
});

test('HTTP requires explicit allowed origin and token; backend paths are private', async t => {
  const f = await fixture(t);
  await new Promise(resolve => f.app.server.listen(0, '127.0.0.1', resolve));
  const base = `http://127.0.0.1:${f.app.server.address().port}`;
  const headers = { 'Content-Type': 'application/json', Origin: f.config.allowedOrigins[0] };
  assert.equal((await fetch(`${base}/api/health`)).status, 200);
  assert.equal((await fetch(`${base}/api/orders`, { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: '{}' })).status, 403);
  assert.equal((await fetch(`${base}/api/orders`, { method: 'POST', headers: { ...headers, Origin: 'https://evil.example' }, body: '{}' })).status, 403);
  assert.equal((await fetch(`${base}/backend/server.mjs`)).status, 404);
  const order = await f.create();
  assert.equal((await fetch(`${base}/api/orders/${order.id}`)).status, 404);
  const info = await fetch(`${base}/api/orders/${order.id}`, { headers: { Authorization: `Bearer ${order.token}` } });
  assert.equal(info.headers.get('cache-control'), 'no-store'); assert.equal(info.status, 200);
  const cfg = await (await fetch(`${base}/paid-config.js`)).text(); assert.match(cfg, /apiBase: '\/'/);
});

test('new AI price is exactly 0.001 BNB and first-free defaults on with an explicit opt-out', () => {
  assert.equal(PRICE_BNB, '0.001'); assert.equal(PRICE_WEI, '1000000000000000');
  assert.equal(loadConfig({}).firstFree, true);
  assert.equal(loadConfig({ AI_FIRST_FREE: 'false' }).firstFree, false);
});

test('trial preview is case normalized, unsigned uploads do not consume, and only the exact wallet can claim', async t => {
  const f = await fixture(t, { config: { firstFree: true } });
  assert.deepEqual(await f.app.service.trial(f.wallet.address.toLowerCase()), { eligible: true, policy: 'once_per_wallet' });
  const order = await f.create();
  assert.equal(order.billingMode, 'free_trial'); assert.equal(order.priceWei, '0'); assert.equal(order.priceBnb, '0');
  assert.equal(order.payment, undefined); assert.equal((await f.app.service.trial(f.wallet.address)).eligible, true);
  assert.match(order.signatureMessage, /Billing: free_trial/); assert.match(order.signatureMessage, /Price: 0 BNB \(0 wei\)/);
  await assert.rejects(f.authorize(order, Wallet.createRandom()), { code: 'WRONG_SIGNER' });
  await assert.rejects(f.app.service.authorize(order.id, order.token, '0x12'), { code: 'INVALID_SIGNATURE' });
  assert.equal(Object.keys(f.app.service.store.state.consumedTrials).length, 0);
  const granted = await f.authorize(order);
  assert.equal(granted.status, 'queued'); assert.equal(granted.paymentStatus, 'not_required'); assert.equal(granted.payment, undefined);
  assert.equal(f.app.service.store.state.consumedTrials[f.wallet.address.toLowerCase()], order.id);
  assert.equal((await f.app.service.trial(f.wallet.address.toLowerCase())).eligible, false);
  await assert.rejects(f.app.service.claim(order.id, order.token, hash()), { code: 'PAYMENT_NOT_REQUIRED' });
  await f.app.service.processQueue();
  assert.equal(f.provider.submissions, 1); assert.equal((await f.app.service.get(order.id, order.token)).status, 'completed');
  assert.equal(Object.keys(f.app.service.store.state.consumedTransactions).length, 0);
  const second = await f.create(undefined, { payerAddress: f.wallet.address.toLowerCase() });
  assert.equal(second.billingMode, 'paid'); assert.equal(second.priceBnb, '0.001'); assert.equal(second.priceWei, '1000000000000000');
  const paid = await f.authorize(second); assert.equal(paid.status, 'awaiting_payment'); assert.equal(paid.payment.valueWei, PRICE_WEI);
});

test('parallel free authorizations and repeated polls grant and submit exactly once, including after restart', async t => {
  const f = await fixture(t, { config: { firstFree: true }, provider: { poll: async () => ({ status: 'pending' }) } });
  const order = await f.create(); const signature = await f.wallet.signMessage(order.signatureMessage);
  await Promise.all(Array.from({ length: 8 }, () => f.app.service.authorize(order.id, order.token, signature)));
  await Promise.all([f.app.service.processQueue(), f.app.service.processQueue()]);
  assert.equal(f.provider.submissions, 1);
  const saved = JSON.parse(await readFile(path.join(f.config.dataDir, 'orders.json'), 'utf8'));
  assert.equal(saved.version, 2); assert.deepEqual(saved.consumedTrials, { [f.wallet.address.toLowerCase()]: order.id });
  await f.app.close();
  let newSubmissions = 0;
  const reopened = await createPaidServer({ config: f.config, chain: f.chain, provider: { preflight: async () => ({ ready: true }), submit: async () => { newSubmissions++; throw new Error('MUST NOT RESUBMIT'); }, poll: async (jobId, job) => ({ status: 'succeeded', resultPath: job.inputPath }) }, autoProcess: false });
  try {
    assert.equal((await reopened.service.trial(f.wallet.address)).eligible, false);
    await reopened.service.authorize(order.id, order.token, signature); await reopened.service.processQueue();
    assert.equal((await reopened.service.get(order.id, order.token)).status, 'completed');
    assert.equal(newSubmissions, 0);
    const next = await reopened.service.create({ payerAddress: f.wallet.address.toLowerCase(), photoDataUrl, character: 'heyi', scene: 'cafe' });
    assert.equal(next.billingMode, 'paid'); assert.equal(next.priceWei, PRICE_WEI);
  } finally { await reopened.close(); }
});

test('parallel wallet reservations serialize generation and leave the other wallet eligible', async t => {
  const f = await fixture(t, { config: { firstFree: true } });
  const first = await f.create(); const otherWallet = Wallet.createRandom(); const second = await f.create(otherWallet);
  const attempts = await Promise.allSettled([f.authorize(first), f.authorize(second, otherWallet)]);
  assert.equal(attempts.filter(result => result.status === 'fulfilled').length, 1);
  assert.equal(attempts.find(result => result.status === 'rejected').reason.code, 'RESERVATION_BUSY');
  assert.equal(Object.keys(f.app.service.store.state.consumedTrials).length, 1);
  await f.app.service.processQueue();
  const unclaimed = attempts[0].status === 'rejected' ? [first, f.wallet] : [second, otherWallet];
  assert.equal((await f.app.service.trial(unclaimed[1].address)).eligible, true);
  await f.authorize(...unclaimed); await f.app.service.processQueue();
  assert.equal(Object.keys(f.app.service.store.state.consumedTrials).length, 2); assert.equal(f.provider.submissions, 2);
});

test('expired unsigned free orders leave eligibility intact, and a signature cannot replay onto another order', async t => {
  const f = await fixture(t, { config: { firstFree: true } }); const first = await f.create();
  const signature = await f.wallet.signMessage(first.signatureMessage);
  await f.app.service.store.exclusive(async () => {
    const order = f.app.service.store.state.orders[first.id]; order.expiresAt = Date.now() - 1; order.createdAt = Date.now() - 4 * 60_000; await f.app.service.store.save();
  });
  await assert.rejects(f.app.service.authorize(first.id, first.token, signature), { code: 'ORDER_EXPIRED' });
  const second = await f.create(); assert.equal(second.billingMode, 'free_trial');
  await assert.rejects(f.app.service.authorize(second.id, second.token, signature), { code: 'WRONG_SIGNER' });
  assert.equal((await f.app.service.trial(f.wallet.address)).eligible, true);
  assert.equal(Object.keys(f.app.service.store.state.consumedTrials).length, 0);
});

test('free reservation is rolled back on durable write failure and unready provider never consumes eligibility', async t => {
  const f = await fixture(t, { config: { firstFree: true } }); const order = await f.create();
  f.provider.preflight = async () => ({ ready: false, reason: 'test unavailable' });
  await assert.rejects(f.authorize(order), { code: 'SERVICE_UNAVAILABLE' });
  assert.equal(Object.keys(f.app.service.store.state.consumedTrials).length, 0);
  f.provider.preflight = async () => ({ ready: true });
  const original = f.app.service.store.save.bind(f.app.service.store); f.app.service.store.save = async () => { throw new Error('disk full'); };
  await assert.rejects(f.authorize(order), /disk full/); f.app.service.store.save = original;
  assert.equal(Object.keys(f.app.service.store.state.consumedTrials).length, 0);
  assert.equal((await f.app.service.get(order.id, order.token)).status, 'awaiting_authorization');
  await f.app.service.processQueue(); assert.equal(f.provider.submissions, 0);
  await f.authorize(order); await f.app.service.processQueue(); assert.equal(f.provider.submissions, 1);
});

test('an ambiguous free submission keeps its trial and resumes only the original provider job', async t => {
  const f = await fixture(t, { config: { firstFree: true }, provider: {
    submit: async () => { f.provider.submissions++; throw new Error('accepted but connection lost'); },
    recover: async () => ({ providerJobId: 'same-free-job' }),
  } });
  const order = await f.create(); await f.authorize(order); await f.app.service.processQueue();
  assert.equal((await f.app.service.get(order.id, order.token)).status, 'review_required');
  assert.equal((await f.app.service.trial(f.wallet.address)).eligible, false);
  await f.app.service.processQueue(); assert.equal(f.provider.submissions, 1);
  await f.app.service.retry(order.id, order.token); await f.app.service.processQueue();
  assert.equal((await f.app.service.get(order.id, order.token)).status, 'completed'); assert.equal(f.provider.submissions, 1);
  assert.equal(f.app.service.store.state.consumedTrials[f.wallet.address.toLowerCase()], order.id);
});

test('terminal free generation failure retains the consumed trial without buying another generation', async t => {
  const f = await fixture(t, { config: { firstFree: true }, provider: { poll: async () => ({ status: 'failed' }) } });
  const order = await f.create(); await f.authorize(order); await f.app.service.processQueue();
  assert.equal((await f.app.service.get(order.id, order.token)).status, 'failed');
  assert.equal((await f.app.service.trial(f.wallet.address)).eligible, false);
  await assert.rejects(f.app.service.retry(order.id, order.token), { code: 'RETRY_UNAVAILABLE' });
  await f.app.service.processQueue(); assert.equal(f.provider.submissions, 1);
  assert.equal((await f.create()).billingMode, 'paid');
});

test('expected billing mode prevents stale first-free buttons creating paid orders', async t => {
  const f = await fixture(t, { config: { firstFree: true } });
  await assert.rejects(f.create(undefined, { expectedBillingMode: 'paid' }), { code: 'TRIAL_CHANGED' });
  assert.equal(Object.keys(f.app.service.store.state.orders).length, 0);
  const order = await f.create(undefined, { expectedBillingMode: 'free_trial' }); await f.authorize(order); await f.app.service.processQueue();
  await assert.rejects(f.create(undefined, { expectedBillingMode: 'free_trial' }), { code: 'TRIAL_CHANGED' });
  await assert.rejects(f.create(undefined, { expectedBillingMode: 'free' }), { code: 'INVALID_BILLING_MODE' });
  assert.equal(Object.keys(f.app.service.store.state.orders).length, 1);
  assert.equal((await f.create(undefined, { expectedBillingMode: 'paid' })).priceWei, PRICE_WEI);
});

test('legacy v1 store migration preserves signed order and its exact original payment price', async t => {
  const f = await fixture(t); const order = await f.create();
  const original = f.app.service.store.state.orders[order.id];
  original.payment.valueWei = '1400000000000000'; original.payment.valueHex = '0x4f94e4c440000';
  original.signatureMessage = original.signatureMessage.replace(`${PRICE_BNB} BNB (${PRICE_WEI} wei)`, '0.0014 BNB (1400000000000000 wei)');
  assert.match(original.signatureMessage, /Price: 0\.0014 BNB \(1400000000000000 wei\)/);
  delete original.billingMode; delete original.priceBnb; delete original.priceWei;
  f.app.service.store.state.version = 1; delete f.app.service.store.state.consumedTrials;
  const oldHash = hash(); f.app.service.store.state.consumedTransactions[oldHash] = 'old-existing-order';
  await f.app.service.store.save(); await f.app.close();
  const reopened = await createPaidServer({ config: { ...f.config, firstFree: true }, chain: f.chain, provider: f.provider, autoProcess: false });
  try {
    const existing = await reopened.service.get(order.id, order.token);
    assert.equal(existing.billingMode, 'paid'); assert.equal(existing.priceBnb, '0.0014'); assert.equal(existing.priceWei, '1400000000000000');
    assert.equal(existing.signatureMessage, original.signatureMessage);
    const authorized = await reopened.service.authorize(order.id, order.token, await f.wallet.signMessage(existing.signatureMessage));
    assert.equal(authorized.payment.valueWei, '1400000000000000');
    const tx = f.chain.pay(reopened.service.store.state.orders[order.id]); await reopened.service.claim(order.id, order.token, tx); await reopened.service.processQueue();
    assert.equal((await reopened.service.get(order.id, order.token)).status, 'completed');
    assert.equal(reopened.service.store.state.consumedTransactions[oldHash], 'old-existing-order');
    assert.equal(reopened.service.store.state.version, 2); assert.deepEqual(reopened.service.store.state.consumedTrials, {});
  } finally { await reopened.close(); }
});

test('restored v2 0.0001 BNB order keeps its exact signature and price while new paid orders cost 0.001', async t => {
  const f = await fixture(t, { config: { firstFree: true } });
  const trial = await f.create(); await f.authorize(trial); await f.app.service.processQueue();
  const order = await f.create(undefined, { expectedBillingMode: 'paid' });
  const legacyWei = '100000000000000', legacyBnb = '0.0001';
  let legacySignature;
  await f.app.service.store.exclusive(async () => {
    const saved = f.app.service.store.state.orders[order.id];
    saved.priceWei = saved.payment.valueWei = legacyWei; saved.priceBnb = legacyBnb;
    saved.payment.valueHex = `0x${BigInt(legacyWei).toString(16)}`;
    saved.signatureMessage = saved.signatureMessage.replace(`${PRICE_BNB} BNB (${PRICE_WEI} wei)`, `${legacyBnb} BNB (${legacyWei} wei)`);
    legacySignature = saved.signatureMessage;
    assert.match(legacySignature, /Price: 0\.0001 BNB \(100000000000000 wei\)/);
    await f.app.service.store.save();
  });
  await f.app.close();
  const reopened = await createPaidServer({ config: f.config, chain: f.chain, provider: f.provider, autoProcess: false });
  try {
    const health = await reopened.service.ready();
    assert.equal(health.priceBnb, '0.001'); assert.equal(health.priceWei, '1000000000000000');
    const restored = await reopened.service.get(order.id, order.token);
    assert.equal(restored.priceBnb, legacyBnb); assert.equal(restored.priceWei, legacyWei); assert.equal(restored.signatureMessage, legacySignature);
    assert.equal((await reopened.service.trial(f.wallet.address)).eligible, false);
    assert.equal(reopened.service.store.state.consumedTrials[f.wallet.address.toLowerCase()], trial.id);
    const authorized = await reopened.service.authorize(order.id, order.token, await f.wallet.signMessage(legacySignature));
    assert.equal(authorized.payment.valueWei, legacyWei); assert.equal(authorized.payment.valueHex, `0x${BigInt(legacyWei).toString(16)}`);
    const stored = reopened.service.store.state.orders[order.id];
    const wrongHash = f.chain.pay(stored, { tx: { value: BigInt(PRICE_WEI) } });
    await assert.rejects(reopened.service.claim(order.id, order.token, wrongHash), error => error.code === 'WRONG_AMOUNT' && error.message === '付款金额必须为 0.0001 BNB');
    assert.equal(reopened.service.store.state.consumedTransactions[wrongHash], undefined);
    const correctHash = f.chain.pay(stored);
    await reopened.service.claim(order.id, order.token, correctHash); await reopened.service.processQueue();
    assert.equal((await reopened.service.get(order.id, order.token)).status, 'completed');
    assert.equal(reopened.service.store.state.orders[order.id].signatureMessage, legacySignature);
    assert.equal(reopened.service.store.state.consumedTransactions[correctHash], order.id);
    const next = await reopened.service.create({ payerAddress: f.wallet.address, photoDataUrl, character: 'cz', scene: 'terrace', expectedBillingMode: 'paid' });
    assert.equal(next.priceBnb, '0.001'); assert.equal(next.priceWei, '1000000000000000'); assert.equal(next.billingMode, 'paid');
    assert.match(next.signatureMessage, /Price: 0\.001 BNB \(1000000000000000 wei\)/);
    assert.equal(f.provider.submissions, 2);
  } finally { await reopened.close(); }
});

test('damaged or missing v2 trial ledger refuses startup instead of granting free credits again', async t => {
  const f = await fixture(t, { config: { firstFree: true } }); const order = await f.create(); await f.authorize(order); await f.app.close();
  const filename = path.join(f.config.dataDir, 'orders.json'); const saved = JSON.parse(await readFile(filename, 'utf8'));
  for (const value of [undefined, [], {}, { [f.wallet.address.toLowerCase()]: 'broken-id' }]) {
    const damaged = { ...saved, consumedTrials: value }; await writeFile(filename, JSON.stringify(damaged));
    const store = new OrderStore(f.config.dataDir);
    await assert.rejects(store.open(), /trial ledger|trial reservation/);
    assert.equal((await readFile(filename, 'utf8')), JSON.stringify(damaged));
  }
});

test('HTTP trial preview, signed free generation, private result and used-wallet paid checkout work without a transaction', async t => {
  const f = await fixture(t, { config: { firstFree: true } });
  await new Promise(resolve => f.app.server.listen(0, '127.0.0.1', resolve));
  const base = `http://127.0.0.1:${f.app.server.address().port}`;
  const headers = { 'Content-Type': 'application/json', Origin: f.config.allowedOrigins[0] };
  const health = await (await fetch(`${base}/api/health`)).json();
  assert.equal(health.priceBnb, '0.001'); assert.equal(health.priceWei, PRICE_WEI); assert.equal(health.firstFree, true); assert.equal(health.trialPolicy, 'once_per_wallet');
  assert.deepEqual(await (await fetch(`${base}/api/trial?address=${f.wallet.address.toLowerCase()}`)).json(), { eligible: true, policy: 'once_per_wallet' });
  assert.equal((await fetch(`${base}/api/trial?address=invalid`)).status, 400);
  const created = await fetch(`${base}/api/orders`, { method: 'POST', headers, body: JSON.stringify({ payerAddress: f.wallet.address, photoDataUrl, character: 'cz', scene: 'terrace', expectedBillingMode: 'free_trial' }) });
  assert.equal(created.status, 201); const order = await created.json(); const secured = { ...headers, Authorization: `Bearer ${order.token}` };
  const authorized = await fetch(`${base}/api/orders/${order.id}/authorize`, { method: 'POST', headers: secured, body: JSON.stringify({ signature: await f.wallet.signMessage(order.signatureMessage) }) });
  assert.equal(authorized.status, 200); const info = await authorized.json(); assert.equal(info.status, 'queued'); assert.equal(info.payment, undefined);
  assert.equal((await fetch(`${base}/api/orders/${order.id}/payment`, { method: 'POST', headers: secured, body: JSON.stringify({ txHash: hash() }) })).status, 409);
  await f.app.service.processQueue();
  const finished = await (await fetch(`${base}/api/orders/${order.id}`, { headers: secured })).json(); assert.equal(finished.status, 'completed');
  const result = await fetch(`${base}${finished.resultUrl}`, { headers: secured }); assert.equal(result.status, 200); assert.equal(result.headers.get('content-type'), 'image/jpeg');
  assert.equal((await fetch(`${base}${finished.resultUrl}`)).status, 404);
  assert.equal((await (await fetch(`${base}/api/trial?address=${f.wallet.address}`)).json()).eligible, false);
  const next = await f.create(); assert.equal(next.billingMode, 'paid'); assert.equal(next.priceWei, PRICE_WEI);
  assert.equal(f.chain.transactions.size, 0); assert.equal(f.provider.submissions, 1);
});

test('trial endpoint is unavailable until AI backend is ready and opt-out produces only paid orders', async t => {
  const f = await fixture(t);
  assert.equal((await f.app.service.ready()).firstFree, false);
  assert.equal((await f.app.service.trial(f.wallet.address)).eligible, false);
  assert.equal((await f.create()).billingMode, 'paid');
  f.app.service.config.enabled = false;
  await assert.rejects(f.app.service.trial(f.wallet.address), { code: 'SERVICE_UNAVAILABLE' });
  assert.equal(Object.keys(f.app.service.store.state.consumedTrials).length, 0);
});
