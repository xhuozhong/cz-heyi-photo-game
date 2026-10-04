import { randomBytes, randomUUID, createHash, createHmac, timingSafeEqual } from 'node:crypto';
import { isIP } from 'node:net';
import path from 'node:path';
import { mkdir, readFile } from 'node:fs/promises';
import { getAddress, verifyMessage, hexlify, toUtf8Bytes, formatEther } from 'ethers';
import { ApiError, requireValue } from './errors.mjs';
import { OrderStore, atomicWrite } from './store.mjs';
import { normalizePhoto, saveResult } from './images.mjs';
import { CHAIN_ID, PRICE_WEI, PRICE_BNB, RECIPIENT, TX_PATTERN, chainPreflight, verifyPayment } from './payment.mjs';

const digest = value => createHash('sha256').update(value).digest('hex');
const unpaid = order => ['awaiting_authorization', 'awaiting_payment'].includes(order.status);
const IN_PROGRESS = ['queued', 'submitting', 'generating'];
const HEALTH_TTL_MS = 20_000;
const HEALTH_MAX_STALE_MS = 60_000;
const HEALTH_CHECKING_REASON = '正在核验 AI 服务，请稍后重试';
const DEVICE_PATTERN = /^[A-Za-z0-9_-]{43}$/;
const trialDay = value => new Date(value + 8 * 60 * 60_000).toISOString().slice(0, 10); // Asia/Shanghai

export class PaidService {
  constructor(config, chain, provider, verifyChallenge) {
    this.config = { enabled: false, firstFree: true, orderTtlMs: 30 * 60_000, paidOrderTtlMs: 5 * 60_000, trialTotalLimit: 20, trialDailyLimit: 5, trialIpDailyLimit: 2, maxOpenOrders: 32, maxOrders: 10000, maxStoredPhotoBytes: 256 * 1024 * 1024, maxInProgress: 1, ...config };
    this.verifyChallenge = verifyChallenge;
    this.chain = chain;
    this.provider = provider;
    this.store = new OrderStore(this.config.dataDir);
    this.processing = false;
    this.healthWaiters = [];
    this.healthEpoch = 0;
    this.healthCapacityUpdating = false;
  }
  async open() { await this.store.open(); }
  async close() {
    this.healthClosed = true;
    for (const resolve of this.healthWaiters.splice(0)) resolve(this.healthValue({ ready: false, checking: true, reason: HEALTH_CHECKING_REASON }));
    await this.activeProcessing;
    await this.healthFlight;
    await this.store.close();
  }
  healthValue(value) {
    return { ...value, chainId: CHAIN_ID, recipient: RECIPIENT, priceBnb: PRICE_BNB, priceWei: PRICE_WEI, firstFree: this.config.firstFree, trialPolicy: 'wallet_device_ip_limits', provider: 'libtv', turnstile: { required: true, siteKey: this.config.turnstileSiteKey || '', orderAction: 'photo_order', trialAction: 'photo_trial', checkAction: 'photo_check' }, trialLimits: { total: this.config.trialTotalLimit, daily: this.config.trialDailyLimit, ipDaily: this.config.trialIpDailyLimit, deviceLifetime: 1, dayTimezone: 'Asia/Shanghai' } };
  }
  // Health is a fast read-only snapshot. It never waits for the CLI/RPC check.
  // Successful snapshots can survive one refresh, but never beyond 60 seconds.
  ready(fresh = false) {
    if (fresh) {
      if (this.healthClosed) return Promise.resolve(this.healthValue({ ready: false, checking: true, reason: HEALTH_CHECKING_REASON }));
      return new Promise(resolve => { this.healthWaiters.push(resolve); this.refreshHealth(); });
    }
    if (!this.config.enabled) return this.healthValue({ ready: false, reason: 'AI 付费模式尚未开放' });
    const age = this.healthCache ? Date.now() - this.healthCache.at : Infinity;
    if (!this.healthCache || age >= HEALTH_TTL_MS) this.refreshHealth();
    if (!this.healthCapacityUpdating && this.healthCache && age < HEALTH_TTL_MS) return { ...this.healthCache.value };
    if (!this.healthCapacityUpdating && this.healthCache?.value.ready && age < HEALTH_MAX_STALE_MS) {
      return { ...this.healthCache.value, refreshing: true };
    }
    return this.healthValue({ ready: false, checking: true, reason: HEALTH_CHECKING_REASON });
  }
  invalidateHealth() {
    this.healthEpoch++;
    this.healthCache = undefined;
  }
  // Batch callers until the next check actually starts. A fresh request arriving
  // during an older check waits for a subsequent round; it cannot authorize a
  // payment using a check that started before that request. Health refreshes and
  // fresh rounds share this serial worker, so concurrent requests do not fan out.
  refreshHealth() {
    if (this.healthClosed || this.healthFlight || this.healthScheduled) return;
    this.healthScheduled = true;
    queueMicrotask(() => {
      this.healthScheduled = false;
      if (this.healthClosed || this.healthFlight) return;
      const waiters = this.healthWaiters.splice(0);
      const epoch = this.healthEpoch;
      this.healthFlight = Promise.resolve().then(() => this.checkReady()).then(value => {
        if (epoch !== this.healthEpoch || this.healthClosed || this.healthCapacityUpdating) {
          value = this.healthValue({ ready: false, checking: true, reason: HEALTH_CHECKING_REASON });
        } else this.healthCache = { at: Date.now(), value };
        return value;
      }).finally(() => {
        this.healthFlight = undefined;
        if (this.healthWaiters.length) this.refreshHealth();
      }).then(value => {
        // Complete fresh callers only after this flight is released, so their
        // next action can immediately request a genuinely subsequent check.
        for (const resolve of waiters) resolve(value);
        return value;
      });
    });
  }
  async checkReady() {
    let value;
    try {
      requireValue(this.config.enabled, 503, 'PAID_DISABLED', 'AI 付费模式尚未开放');
      requireValue(!this.healthCapacityUpdating, 503, 'CAPACITY_UPDATING', HEALTH_CHECKING_REASON);
      const result = await this.provider?.preflight();
      requireValue(result?.ready, 503, 'PROVIDER_UNAVAILABLE', result?.reason || 'AI 生成服务尚未就绪');
      requireValue(result.remainingGenerations === undefined || (Number.isSafeInteger(result.remainingGenerations) && result.remainingGenerations > 0), 503, 'CAPACITY_EXHAUSTED', '本期 AI 合影名额已用完');
      await chainPreflight(this.chain);
      value = { ready: true };
    } catch (error) { value = { ready: false, reason: error instanceof ApiError ? error.message : '生成或链上服务暂不可用' }; }
    return this.healthValue(value);
  }
  async requireReady() { const health = await this.ready(true); requireValue(health.ready, 503, 'SERVICE_UNAVAILABLE', health.reason); }
  wallet(address) {
    try { return getAddress(address); } catch { throw new ApiError(400, 'INVALID_WALLET', '钱包地址格式不正确'); }
  }
  trialIdentity(deviceId, ip) {
    requireValue(DEVICE_PATTERN.test(deviceId || ''), 400, 'DEVICE_REQUIRED', '请允许浏览器保存体验标识后重试');
    requireValue(isIP(ip || '') > 0, 403, 'VISITOR_IP_REQUIRED', '请求来源无法验证');
    requireValue(typeof this.config.trialHmacSecret === 'string' && this.config.trialHmacSecret.length >= 32, 503, 'TRIAL_CONFIG', '首次免费体验暂不可用');
    for (const key of ['trialTotalLimit', 'trialDailyLimit', 'trialIpDailyLimit']) requireValue(Number.isSafeInteger(this.config[key]) && this.config[key] > 0, 503, 'TRIAL_CONFIG', '首次免费体验暂不可用');
    requireValue(!this.config.generationBudget || this.config.trialTotalLimit < this.config.generationBudget, 503, 'TRIAL_CONFIG', '首次免费体验暂不可用');
    const canonicalIp = isIP(ip) === 6 ? new URL(`http://[${ip}]/`).hostname : ip;
    const hash = (kind, value) => createHmac('sha256', this.config.trialHmacSecret).update(`${kind}:${value}`).digest('hex');
    return { deviceHash: hash('device', deviceId), ipHash: hash('ip', canonicalIp) };
  }
  trialStatus(wallet, identity, now = Date.now()) {
    const claims = Object.values(this.store.state.trialClaims);
    const today = trialDay(now);
    const poolReason = !this.config.firstFree ? 'disabled' : claims.length >= this.config.trialTotalLimit ? 'total_limit' : claims.filter(claim => claim.day === today).length >= this.config.trialDailyLimit ? 'daily_limit' : '';
    const blockReason = this.store.state.consumedTrials[wallet.toLowerCase()] ? 'wallet_used' : poolReason || (claims.some(claim => claim.deviceHash === identity.deviceHash) ? 'device_used' : claims.filter(claim => claim.ipHash === identity.ipHash && claim.day === today).length >= this.config.trialIpDailyLimit ? 'ip_daily_limit' : '');
    return { eligible: !blockReason, available: !poolReason, blockReason: blockReason || null, policy: 'wallet_device_ip_limits' };
  }
  async trial(address, context = {}) {
    const wallet = this.wallet(address);
    await this.requireReady();
    const identity = this.trialIdentity(context.deviceId, context.ip);
    return this.store.exclusive(() => this.trialStatus(wallet, identity));
  }
  async humanCheck(body, context = {}) {
    this.trialIdentity(body.trialDeviceId, context.ip);
    await this.verifyChallenge(body.turnstileToken, { ...context, action: 'photo_check', deviceId: body.trialDeviceId });
    return { verified: true };
  }
  authenticate(id, token) {
    const order = this.store.state.orders[id];
    const incoming = Buffer.from(digest(typeof token === 'string' ? token : ''));
    const expected = Buffer.from(order?.tokenHash || '0'.repeat(64));
    requireValue(order && incoming.length === expected.length && timingSafeEqual(incoming, expected), 404, 'ORDER_NOT_FOUND', '订单不存在或凭证无效');
    return order;
  }
  view(order) {
    return {
      id: order.id, status: order.status, character: order.character, scene: order.scene, options: order.options,
      protectionVersion: order.protectionVersion || 0, trialChallengeRequired: order.billingMode === 'free_trial' && !order.authorizedAt,
      billingMode: order.billingMode || 'paid', priceWei: order.priceWei || order.payment.valueWei,
      priceBnb: order.priceBnb || formatEther(order.payment.valueWei),
      createdAt: order.createdAt, expiresAt: order.expiresAt, payerAddress: order.payerAddress,
      signatureMessage: order.status === 'awaiting_authorization' ? order.signatureMessage : undefined,
      payment: order.authorizedAt && order.billingMode !== 'free_trial' ? order.payment : undefined,
      paymentStatus: order.paymentStatus || 'unpaid', txHash: order.txHash || order.pendingTxHash,
      resultUrl: order.status === 'completed' ? `/api/orders/${order.id}/result` : undefined,
      message: order.message, recoverable: order.status === 'generating' || (order.status === 'review_required' && !!this.provider?.recover),
    };
  }
  async cleanExpired() {
    let changed = false;
    for (const order of Object.values(this.store.state.orders)) {
      // Submitted payment evidence is retained even if the client closes the tab.
      const deadline = order.authorizedAt ? order.expiresAt + 24 * 60 * 60_000 : order.createdAt + 3 * 60_000;
      if (unpaid(order) && order.pendingTxHash && Date.now() > order.expiresAt + 24 * 60 * 60_000) {
        order.status = 'review_required'; order.message = '付款状态长时间未确认，交易哈希已保留，请联系运营方核对'; changed = true;
      }
      if (unpaid(order) && !order.pendingTxHash && Date.now() > deadline) {
        await this.store.removeFiles(order.id);
        delete this.store.state.orders[order.id]; changed = true;
      }
    }
    if (changed) await this.store.save();
  }
  async create(body, context = {}) {
    await this.requireReady();
    const identity = this.trialIdentity(body.trialDeviceId, context.ip);
    await this.verifyChallenge(body.turnstileToken, { ...context, action: 'photo_order', deviceId: body.trialDeviceId });
    return this.store.exclusive(async () => {
      await this.cleanExpired();
      const all = Object.values(this.store.state.orders);
      requireValue(all.length < this.config.maxOrders, 503, 'CAPACITY_FULL', '服务容量暂满，请稍后再试');
      requireValue(all.filter(o => unpaid(o)).length < this.config.maxOpenOrders && all.filter(o => IN_PROGRESS.includes(o.status)).length < this.config.maxInProgress, 503, 'BUSY', '生成服务繁忙，请稍后再试');
      const payerAddress = this.wallet(body.payerAddress);
      requireValue(!all.some(o => o.payerAddress.toLowerCase() === payerAddress.toLowerCase() && (IN_PROGRESS.includes(o.status) || (unpaid(o) && Date.now() < o.expiresAt))), 409, 'ACTIVE_ORDER', '此钱包已有未完成订单，请继续原订单');
      requireValue(['cz', 'heyi'].includes(body.character) && ['terrace', 'cafe', 'street'].includes(body.scene), 400, 'INVALID_SELECTION', '请选择有效的伙伴与场景');
      const options = { gender: body.options?.gender || 'male', body: body.options?.body || 'standard', outfit: body.options?.outfit || 'black' };
      requireValue(['male', 'female'].includes(options.gender) && ['slim', 'standard', 'full'].includes(options.body) && ['black', 'cream', 'red'].includes(options.outfit), 400, 'INVALID_OPTIONS', '服装或身材选项不正确');
      const trial = this.trialStatus(payerAddress, identity);
      requireValue(trial.eligible || trial.blockReason === 'wallet_used' || trial.blockReason === 'disabled' || body.expectedBillingMode === 'paid', 409, 'TRIAL_LIMIT_REACHED', '首次免费体验受名额限制已暂停；付费体验需您重新确认');
      const billingMode = trial.eligible ? 'free_trial' : 'paid';
      requireValue(body.expectedBillingMode === undefined || ['free_trial', 'paid'].includes(body.expectedBillingMode), 400, 'INVALID_BILLING_MODE', '请选择有效的计费方式');
      requireValue(body.expectedBillingMode === undefined || body.expectedBillingMode === billingMode, 409, 'TRIAL_CHANGED', '首次免费资格已变化，请重新确认本次费用');
      const normalized = await normalizePhoto(body.photoDataUrl);
      requireValue(all.reduce((sum, o) => sum + (o.photoBytes || 0), 0) + normalized.length <= this.config.maxStoredPhotoBytes, 503, 'PHOTO_STORAGE_FULL', '照片存储容量暂满，请稍后再试');
      const { latest } = await chainPreflight(this.chain);
      const id = randomUUID();
      const token = randomBytes(32).toString('base64url');
      const createdAt = Date.now();
      const priceWei = billingMode === 'free_trial' ? '0' : PRICE_WEI;
      const priceBnb = billingMode === 'free_trial' ? '0' : PRICE_BNB;
      const order = {
        id, tokenHash: digest(token), payerAddress, createdAt, expiresAt: createdAt + (billingMode === 'paid' ? this.config.paidOrderTtlMs : this.config.orderTtlMs),
        protectionVersion: 1, trialIdentity: identity,
        status: 'awaiting_authorization', paymentStatus: billingMode === 'free_trial' ? 'not_required' : 'unpaid', billingMode, priceBnb, priceWei, character: body.character, scene: body.scene, options,
        photoHash: digest(normalized), photoBytes: normalized.length, nonce: randomBytes(24).toString('hex'), startBlock: latest.number,
        payment: billingMode === 'paid' ? { chainId: CHAIN_ID, to: RECIPIENT, valueWei: priceWei, valueHex: `0x${BigInt(priceWei).toString(16)}`, data: hexlify(toUtf8Bytes(`cz-heyi-photo:${id}`)) } : undefined,
      };
      order.signatureMessage = [
        '偶遇照相馆 · AI 合影订单授权',
        `Service: ${this.config.serviceDomain || 'cz-heyi-photo-game'}`,
        `Order: ${id}`, `Wallet: ${payerAddress}`, `Chain: BNB Smart Chain (${CHAIN_ID})`,
        `Billing: ${billingMode}`, `Recipient: ${RECIPIENT}`, `Price: ${priceBnb} BNB (${priceWei} wei)`,
        `Photo SHA-256: ${order.photoHash}`, `Selection: ${order.character}/${order.scene}/${JSON.stringify(options)}`,
        `Nonce: ${order.nonce}`, `Expires: ${new Date(order.expiresAt).toISOString()}`,
        billingMode === 'free_trial' ? '此签名领取本钱包一次免费 AI 合影并绑定本订单，无需转账或代币授权。' : '此签名仅绑定本订单，不是转账或代币授权。付款需您另行在钱包确认。',
      ].join('\n');
      await mkdir(this.store.orderDir(id), { recursive: true, mode: 0o700 });
      try {
        await atomicWrite(path.join(this.store.orderDir(id), 'input.jpg'), normalized);
        this.store.state.orders[id] = order;
        await this.store.save();
      } catch (error) { delete this.store.state.orders[id]; await this.store.removeFiles(id); throw error; }
      return { ...this.view(order), token };
    });
  }
  async authorize(id, token, signature, context = {}) {
    const response = await this.store.exclusive(async () => {
      const order = this.authenticate(id, token);
      if (!unpaid(order)) return this.view(order);
      requireValue(Date.now() <= order.expiresAt, 410, 'ORDER_EXPIRED', '订单已过期，请勿向此订单付款');
      let signer;
      try { signer = verifyMessage(order.signatureMessage, signature); } catch { throw new ApiError(401, 'INVALID_SIGNATURE', '钱包签名无法验证'); }
      requireValue(signer.toLowerCase() === order.payerAddress.toLowerCase(), 401, 'WRONG_SIGNER', '签名钱包与订单钱包不同');
      requireValue(!Object.values(this.store.state.orders).some(other => other.id !== id && (IN_PROGRESS.includes(other.status) || (other.authorizedAt && unpaid(other) && Date.now() <= other.expiresAt))), 409, 'RESERVATION_BUSY', '已有订单正在等待付款或生成，请稍后再试');
      await this.requireReady();
      if (!order.authorizedAt) {
        if (order.billingMode === 'free_trial') {
          const wallet = order.payerAddress.toLowerCase();
          requireValue(this.config.firstFree, 409, 'TRIAL_DISABLED', '首次免费体验暂未开放，请重新创建订单');
          requireValue(!this.store.state.consumedTrials[wallet] || this.store.state.consumedTrials[wallet] === id, 409, 'TRIAL_ALREADY_USED', '此钱包的首次免费体验已用于另一订单，请继续原订单');
          let identity;
          identity = this.trialIdentity(context.deviceId, context.ip);
          requireValue(!order.trialIdentity || identity.deviceHash === order.trialIdentity.deviceHash, 403, 'DEVICE_MISMATCH', '请在创建订单的浏览器继续领取');
          requireValue(this.trialStatus(order.payerAddress, identity).eligible, 409, 'TRIAL_LIMIT_REACHED', '免费体验名额已用完，请重新确认付费订单');
          await this.verifyChallenge(context.turnstileToken, { ...context, action: 'photo_trial', deviceId: context.deviceId });
          // Reserve the normalized wallet and its generation together before any provider call.
          this.store.state.consumedTrials[wallet] = id;
          order.authorizedAt = Date.now(); order.trialReservedAt = order.authorizedAt;
          this.store.state.trialClaims[id] = { ...identity, day: trialDay(order.authorizedAt), reservedAt: order.authorizedAt, legacy: false };
          order.trialIdentity = identity;
          order.status = 'queued'; order.paymentStatus = 'not_required'; order.message = '首次免费体验已领取，等待 AI 生成';
        } else {
          const { latest } = await chainPreflight(this.chain);
          order.authorizedAt = Date.now(); order.startBlock = latest.number; order.status = 'awaiting_payment';
        }
        await this.store.save();
      }
      return this.view(order);
    });
    this.kick(); return response;
  }
  async claim(id, token, txHash) {
    const response = await this.store.exclusive(async () => {
      const order = this.authenticate(id, token);
      requireValue(order.billingMode !== 'free_trial', 409, 'PAYMENT_NOT_REQUIRED', '首次免费订单无需付款，请继续原订单');
      requireValue(typeof txHash === 'string' && TX_PATTERN.test(txHash), 400, 'INVALID_TX', '交易哈希格式不正确');
      const hash = txHash.toLowerCase();
      if (!unpaid(order) && !(order.status === 'review_required' && order.pendingTxHash && !order.txHash)) {
        requireValue(order.txHash === hash, 409, 'ALREADY_PAID', '本订单已绑定另一笔付款');
        return this.view(order);
      }
      requireValue(order.authorizedAt, 409, 'NOT_AUTHORIZED', '请先完成钱包签名');
      const consumed = this.store.state.consumedTransactions[hash];
      requireValue(!consumed || consumed === id, 409, 'TX_ALREADY_USED', '该交易已用于其他订单');
      const verified = await verifyPayment(this.chain, order, hash);
      if (verified.pending) {
        order.pendingTxHash = hash; order.paymentStatus = 'pending'; order.message = '正在等待链上最终确认';
        await this.store.save();
        return this.view(order);
      }
      // One atomic durable ledger write reserves this payment and its generation credit.
      this.store.state.consumedTransactions[hash] = id;
      order.txHash = hash; delete order.pendingTxHash; order.paymentStatus = 'verified';
      order.paymentProof = verified; order.paidAt = Date.now();
      order.status = verified.late ? 'review_required' : 'queued';
      order.message = verified.late ? '付款发生在订单过期后，付款凭证已保留，请联系运营方处理' : '付款已确认，等待 AI 生成';
      await this.store.save();
      return this.view(order);
    });
    this.kick(); return response;
  }
  async get(id, token) { return this.store.exclusive(() => this.view(this.authenticate(id, token))); }
  async result(id, token) {
    const filename = await this.store.exclusive(() => {
      const order = this.authenticate(id, token);
      requireValue(order.status === 'completed', 409, 'RESULT_NOT_READY', '合影尚未生成完成');
      return path.join(this.store.orderDir(id), 'result.jpg');
    });
    return readFile(filename);
  }
  job(order) {
    return { id: order.id, idempotencyKey: order.id, inputPath: path.join(this.store.orderDir(order.id), 'input.jpg'), outputDir: this.store.orderDir(order.id), character: order.character, scene: order.scene, options: order.options };
  }
  kick() { if (this.autoProcess) void this.processQueue().catch(() => {}); }
  async retry(id, token) {
    const value = await this.store.exclusive(async () => {
      const order = this.authenticate(id, token);
      requireValue(['generating', 'review_required'].includes(order.status) && !order.paymentProof?.late, 409, 'RETRY_UNAVAILABLE', '订单需由运营方处理，重试不会重新扣取额度');
      if (order.status === 'review_required') {
        requireValue(this.provider?.recover && order.submissionStartedAt && !order.providerJobId, 409, 'RETRY_UNAVAILABLE', '生成状态需人工核对');
        const recovered = await this.provider.recover(this.job(order));
        requireValue(recovered?.providerJobId, 409, 'RETRY_UNAVAILABLE', '未找到已提交任务，请联系运营方核对');
        order.providerJobId = recovered.providerJobId; order.status = 'generating'; order.message = '已恢复同一生成任务'; await this.store.save();
      }
      return this.view(order);
    });
    this.kick(); return value;
  }
  processQueue() {
    if (this.processing) return this.activeProcessing;
    this.processing = true;
    this.activeProcessing = this.runQueue().finally(() => { this.processing = false; });
    return this.activeProcessing;
  }
  async runQueue() {
    // Finish chain verification after a player's tab closes. Never rely on browser polling.
    const waiting = await this.store.exclusive(async () => {
      await this.cleanExpired();
      return Object.values(this.store.state.orders).filter(o => o.status === 'awaiting_payment' && o.pendingTxHash).map(o => ({ id: o.id, hash: o.pendingTxHash, tokenHash: o.tokenHash }));
    });
    for (const pending of waiting) {
      await this.store.exclusive(async () => {
        const order = this.store.state.orders[pending.id];
        let verified;
        try { verified = await verifyPayment(this.chain, order, pending.hash); } catch { return; }
        if (verified.pending) return;
        const consumed = this.store.state.consumedTransactions[pending.hash];
        if (consumed && consumed !== order.id) { order.status = 'review_required'; order.message = '付款凭证已绑定其他订单，需人工核对'; }
        else {
          this.store.state.consumedTransactions[pending.hash] = order.id;
          order.txHash = pending.hash; delete order.pendingTxHash; order.paymentStatus = 'verified';
          order.paymentProof = verified; order.paidAt = Date.now(); order.status = verified.late ? 'review_required' : 'queued';
          order.message = verified.late ? '付款发生在订单过期后，付款凭证已保留，请联系运营方处理' : '付款已确认，等待 AI 生成';
        }
        await this.store.save();
      });
    }
    // Serial generation avoids racing one account's quota; pending jobs are polled on later ticks.
    const ids = await this.store.exclusive(() => Object.values(this.store.state.orders).filter(o => IN_PROGRESS.includes(o.status)).map(o => o.id));
    for (const id of ids) {
      let order = await this.store.exclusive(() => structuredClone(this.store.state.orders[id]));
      const job = this.job(order);
      if (order.status === 'submitting') {
        let recovered;
        try { recovered = await this.provider?.recover?.(job); } catch {}
        await this.store.exclusive(async () => {
          const current = this.store.state.orders[id];
          if (recovered?.providerJobId) { current.providerJobId = recovered.providerJobId; current.status = 'generating'; }
          else { current.status = 'review_required'; current.message = current.billingMode === 'free_trial' ? '提交时服务中断，首次免费订单已保留，需核对原生成任务；不会自动重复扣额度' : '提交时服务中断，已保留付款，需核对生成任务；不会自动重复扣额度'; }
          await this.store.save(); order = structuredClone(current);
        });
      }
      if (order.status === 'queued') {
        try { await this.requireReady(); } catch { continue; }
        // This intent is committed BEFORE entering the credit-consuming provider operation.
        await this.store.exclusive(async () => { const current = this.store.state.orders[id]; current.status = 'submitting'; current.submissionStartedAt = Date.now(); current.message = 'AI 正在提交生成任务'; await this.store.save(); });
        // Submission may consume the final configured generation. Invalidate
        // before entering it, reject older in-flight health results by epoch,
        // and refresh only after the provider has finished updating its journal.
        this.healthCapacityUpdating = true; this.invalidateHealth();
        let submission;
        try { submission = await this.provider.submit(job); requireValue(typeof submission?.providerJobId === 'string' && submission.providerJobId.length > 0, 500, 'NO_PROVIDER_JOB', '生成任务信息缺失'); }
        catch {
          await this.store.exclusive(async () => { const current = this.store.state.orders[id]; current.status = 'review_required'; current.message = current.billingMode === 'free_trial' ? '生成提交状态需核对，首次免费订单已保留；请恢复原订单，不会自动重复扣额度' : '生成提交状态需核对，付款已保留；不会自动重复扣额度'; await this.store.save(); });
          continue;
        }
        finally { this.healthCapacityUpdating = false; this.invalidateHealth(); this.refreshHealth(); }
        await this.store.exclusive(async () => { const current = this.store.state.orders[id]; current.providerJobId = submission.providerJobId; current.status = 'generating'; current.message = 'AI 正在生成合影'; await this.store.save(); order = structuredClone(current); });
      }
      if (order.status !== 'generating') continue;
      try {
        const progress = await this.provider.poll(order.providerJobId, job);
        if (progress?.status === 'pending') continue;
        if (progress?.status === 'failed') {
          await this.store.exclusive(async () => { const current = this.store.state.orders[id]; current.status = 'failed'; current.message = current.billingMode === 'free_trial' ? 'AI 生成失败，首次免费订单已保留，请联系运营方处理' : 'AI 生成失败，付款凭证已保留，请联系运营方处理'; await this.store.save(); });
          continue;
        }
        requireValue(progress?.status === 'succeeded' && path.isAbsolute(progress.resultPath || ''), 500, 'INVALID_PROVIDER_RESULT', '生成结果不正确');
        await saveResult(progress.resultPath, path.join(job.outputDir, 'result.jpg'));
        await this.store.exclusive(async () => { const current = this.store.state.orders[id]; current.status = 'completed'; current.completedAt = Date.now(); current.message = 'AI 合影已完成'; await this.store.save(); });
      } catch {
        // Poll/download failures may be retried because they never purchase another generation.
        await this.store.exclusive(async () => { const current = this.store.state.orders[id]; current.message = '生成任务已提交，正在恢复状态；无需再次付款'; current.lastPollFailureAt = Date.now(); await this.store.save(); });
      }
    }
  }
}
