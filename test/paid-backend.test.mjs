import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtemp, rm, readFile } from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { randomBytes } from 'node:crypto';
import { Wallet } from 'ethers';
import sharp from 'sharp';
import { createPaidServer } from '../backend/server.mjs';

const rootDir = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const photoDataUrl = `data:image/jpeg;base64,${(await sharp({ create: { width: 512, height: 512, channels: 3, background: '#caa' } }).jpeg().toBuffer()).toString('base64')}`;
const hash = () => `0x${randomBytes(32).toString('hex')}`;

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
  const config = { rootDir, dataDir, enabled: true, allowedOrigins: ['http://127.0.0.1:48123'], ...overrides.config };
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
  assert.equal(authorized.payment.valueWei, '1400000000000000');
  assert.equal(authorized.payment.chainId, 56);
  const other = await f.create(Wallet.createRandom());
  await assert.rejects(f.app.service.authorize(other.id, other.token, await f.wallet.signMessage(other.signatureMessage)), { code: 'WRONG_SIGNER' });
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
  ['underpayment', { tx: { value: 1399999999999999n } }, 'WRONG_AMOUNT'],
  ['overpayment', { tx: { value: 1400000000000001n } }, 'WRONG_AMOUNT'],
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
