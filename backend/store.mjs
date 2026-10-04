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
      catch (error) { if (error.code !== 'ENOENT') throw error; this.state = { version: 1, orders: {}, consumedTransactions: {} }; }
      if (this.state.version !== 1 || !this.state.orders || !this.state.consumedTransactions) throw new Error('Unsupported or damaged order store; refusing to start');
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
