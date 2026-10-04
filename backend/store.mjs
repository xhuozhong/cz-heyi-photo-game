import { mkdir, open, readFile, rename, unlink, rm } from 'node:fs/promises';
import path from 'node:path';
import os from 'node:os';
import { randomUUID } from 'node:crypto';
import { setTimeout as delay } from 'node:timers/promises';

export async function atomicWrite(filename, bytes) {
  await mkdir(path.dirname(filename), { recursive: true, mode: 0o700 });
  const temporary = `${filename}.${randomUUID()}.tmp`;
  const file = await open(temporary, 'wx', 0o600);
  try { await file.writeFile(bytes); await file.sync(); } finally { await file.close(); }
  try {
    // Windows antivirus/indexers may briefly hold the destination. Repeating the same
    // atomic rename is safe and never repeats a blockchain/provider operation.
    for (let attempt = 0; ; attempt++) {
      try { await rename(temporary, filename); break; }
      catch (error) { if (!['EPERM', 'EACCES', 'EBUSY'].includes(error.code) || attempt >= 5) throw error; await delay(25 * 2 ** attempt); }
    }
  } catch (error) { await unlink(temporary).catch(() => {}); throw error; }
  // A filesystem supporting directory fsync also durably records the rename.
  let directory;
  try { directory = await open(path.dirname(filename), 'r'); await directory.sync(); }
  catch (error) { if (!['EINVAL', 'EPERM', 'EISDIR', 'EBADF', 'ENOTSUP'].includes(error.code)) throw error; }
  finally { await directory?.close(); }
}

export class OrderStore {
  constructor(dataDir) { this.dataDir = path.resolve(dataDir); this.tail = Promise.resolve(); this.lockPath = path.join(this.dataDir, 'instance.lock'); }
  async open() {
    await mkdir(this.dataDir, { recursive: true, mode: 0o700 });
    try {
      const old = JSON.parse(await readFile(this.lockPath, 'utf8'));
      if (old.hostname === os.hostname() && Number.isInteger(old.pid)) {
        try { process.kill(old.pid, 0); } catch (error) { if (error.code === 'ESRCH') await unlink(this.lockPath); }
      }
    } catch (error) { if (error.code !== 'ENOENT') throw error; }
    this.lock = await open(this.lockPath, 'wx', 0o600);
    await this.lock.writeFile(JSON.stringify({ hostname: os.hostname(), pid: process.pid }));
    await this.lock.sync();
    try {
      try { this.state = JSON.parse(await readFile(path.join(this.dataDir, 'orders.json'), 'utf8')); }
      catch (error) { if (error.code !== 'ENOENT') throw error; this.state = { version: 3, orders: {}, consumedTransactions: {}, consumedTrials: {}, trialClaims: {} }; }
      const record = value => value && typeof value === 'object' && !Array.isArray(value);
      if (![1, 2, 3].includes(this.state.version) || !record(this.state.orders) || !record(this.state.consumedTransactions)) throw new Error('Unsupported or damaged order store; refusing to start');
      const migrating = this.state.version < 3;
      if (this.state.version === 1) {
        // Existing signed order messages/payment amounts are never rewritten.
        if (this.state.consumedTrials !== undefined && !record(this.state.consumedTrials)) throw new Error('Damaged trial ledger; refusing to start');
        this.state.consumedTrials ??= {};
      }
      if (!record(this.state.consumedTrials)) throw new Error('Damaged trial ledger; refusing to start');
      for (const [wallet, id] of Object.entries(this.state.consumedTrials)) {
        if (!/^0x[0-9a-f]{40}$/.test(wallet) || typeof id !== 'string' || !/^[0-9a-f-]{36}$/.test(id)) throw new Error('Damaged trial ledger; refusing to start');
      }
      for (const order of Object.values(this.state.orders)) {
        if (order.billingMode === 'free_trial' && order.authorizedAt && this.state.consumedTrials[order.payerAddress?.toLowerCase()] !== order.id) throw new Error('Free order missing durable trial reservation; refusing to start');
      }
      if (migrating) {
        this.state.trialClaims = {};
        for (const id of Object.values(this.state.consumedTrials)) {
          const order = this.state.orders[id];
          const reservedAt = order?.trialReservedAt || order?.authorizedAt || order?.createdAt || 0;
          this.state.trialClaims[id] = { legacy: true, reservedAt, day: new Date(reservedAt + 8 * 60 * 60_000).toISOString().slice(0, 10) };
        }
        this.state.version = 3;
      }
      if (!record(this.state.trialClaims)) throw new Error('Damaged free claim ledger; refusing to start');
      const claimIds = Object.values(this.state.consumedTrials);
      if (new Set(claimIds).size !== claimIds.length || Object.keys(this.state.trialClaims).length !== claimIds.length) throw new Error('Free claim ledger does not match wallet ledger; refusing to start');
      for (const id of claimIds) {
        const claim = this.state.trialClaims[id];
        if (!record(claim) || !Number.isSafeInteger(claim.reservedAt) || claim.reservedAt < 0 || !/^\d{4}-\d{2}-\d{2}$/.test(claim.day) || claim.day !== new Date(claim.reservedAt + 8 * 60 * 60_000).toISOString().slice(0, 10)) throw new Error('Damaged free claim ledger; refusing to start');
        if (claim.legacy !== true && (!/^[a-f0-9]{64}$/.test(claim.deviceHash || '') || !/^[a-f0-9]{64}$/.test(claim.ipHash || ''))) throw new Error('Damaged free claim identity; refusing to start');
      }
      if (migrating) await this.save();
    } catch (error) { await this.close(); throw error; }
  }
  async close() { await this.tail; if (this.lock) { await this.lock.close(); this.lock = null; await unlink(this.lockPath).catch(error => { if (error.code !== 'ENOENT') throw error; }); } }
  async save() { await atomicWrite(path.join(this.dataDir, 'orders.json'), JSON.stringify(this.state)); }
  async exclusive(fn) {
    const result = this.tail.then(async () => {
      const previous = structuredClone(this.state);
      try { return await fn(); } catch (error) { this.state = previous; throw error; }
    });
    this.tail = result.catch(() => {});
    return result;
  }
  orderDir(id) { return path.join(this.dataDir, 'orders', id); }
  async removeFiles(id) { await rm(this.orderDir(id), { recursive: true, force: true }); }
}
