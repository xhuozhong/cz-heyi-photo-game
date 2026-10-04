import { paidConfig as config } from './paid-config.js?ver=recipient-20261004';
import { stampPhotoBlob, SIGNATURE_VERSION } from './signature-stamp.js';

const $ = id => document.getElementById(id);
const delay = ms => new Promise(resolve => setTimeout(resolve, ms));
const RECEIPT_KEY = 'encounter-ai-order-v1';
const LEGACY_RECIPIENT = '0x7C4383da12264BeD66D125EF34d4a4A8Bb8979F2';
const ORDER_PRICES = Object.freeze({
  [config.priceWei]: config.priceBnb,
  '100000000000000': '0.0001',
  '1400000000000000': '0.0014',
});
const labels = {
  awaiting_authorization: '订单已准备好，等待钱包签名。',
  awaiting_payment: '等待链上付款确认。请保留此页面或稍后继续订单。',
  paid: '付款已确认，正在准备 AI 合影。',
  queued: '付款已确认，AI 合影正在排队。',
  submitting: '付款已确认，正在提交本次 AI 合影。',
  generating: 'AI 正在制作合影，完成后即可下载。',
  completed: 'AI 合影已完成。可以下载或收藏到浏览器相册。',
  review_required: '这笔订单需要服务方核查。请保留订单与交易凭证，不要再次付款。',
  failed: 'AI 合影暂未完成。请保留订单与交易凭证，不要再次付款。',
};

function backendBase() {
  if (!config.apiBase) return '';
  try {
    const localPage = ['localhost', '127.0.0.1', '[::1]'].includes(location.hostname);
    // Local development must not contact production or enable real payments by
    // inheriting the public Pages config; explicit local test configs still work.
    const configured = localPage && config.apiBase === 'https://xhuozhong.com' ? '/' : config.apiBase;
    const url = new URL(configured, location.href);
    const loopback = ['localhost', '127.0.0.1', '[::1]'].includes(url.hostname);
    if (url.username || url.password || url.search || url.hash || (url.protocol !== 'https:' && !(url.protocol === 'http:' && loopback && localPage))) return '';
    if (loopback && !localPage) return '';
    return url.href.replace(/\/$/, '');
  } catch { return ''; }
}

export function createPaidMode({ getInput, onModeChange, onBusy, onStatus, onResult }) {
  const base = backendBase();
  const state = { mode: 'free', ready: false, checking: false, healthPending: false, busy: false, stage: 'closed', account: '', order: null, message: '', error: '', storageWarning: '', receiptConflict: null, trialEligibility: 'unknown', trialAddress: '' };
  let operation = 0, restoredOrderId = null, legacyRecipientAcknowledged = null;

  function receiptMetadata(order) {
    // Whitelist metadata: uploaded photo bytes and result blobs never enter storage.
    const keys = ['id', 'token', 'status', 'signatureMessage', 'recipient', 'payerAddress', 'character', 'scene', 'createdAt', 'expiresAt', 'txHash', 'paymentRequested', 'recoverable', 'paymentStatus', 'billingMode', 'priceBnb', 'priceWei'];
    const receipt = Object.fromEntries(keys.filter(key => order[key] !== undefined).map(key => [key, order[key]]));
    if (order.options) receipt.options = Object.fromEntries(['gender', 'body', 'outfit'].filter(key => order.options[key] !== undefined).map(key => [key, order.options[key]]));
    if (order.payment) receipt.payment = Object.fromEntries(['chainId', 'to', 'valueWei', 'valueHex', 'data'].filter(key => order.payment[key] !== undefined).map(key => [key, order.payment[key]]));
    return { ...receipt, endpoint: base };
  }
  function clearReceipt(id) {
    for (const storageName of ['localStorage', 'sessionStorage']) {
      try {
        const storage = window[storageName];
        const stored = JSON.parse(storage.getItem(RECEIPT_KEY) || 'null');
        if (stored?.id === id && stored?.endpoint === base) storage.removeItem(RECEIPT_KEY);
      } catch { /* Never clear another tab's newer order receipt. */ }
    }
  }
  function storeReceipt() {
    if (!state.order) return false;
    state.receiptConflict = null;
    try {
      let stored;
      const previous = localStorage.getItem(RECEIPT_KEY);
      try { stored = JSON.parse(previous || 'null'); } catch { stored = null; }
      const valid = stored?.endpoint === base && /^[A-Za-z0-9_-]{8,128}$/.test(stored.id) && typeof stored.token === 'string' && stored.token.length >= 16 && stored.token.length <= 512 && typeof stored.status === 'string';
      if (valid && stored.id !== state.order.id && stored.status !== 'completed') {
        state.receiptConflict = stored.id;
        return false;
      }
      const serialized = JSON.stringify(receiptMetadata(state.order));
      localStorage.setItem(RECEIPT_KEY, serialized);
      if (localStorage.getItem(RECEIPT_KEY) !== serialized) return false;
    } catch { return false; }
    state.storageWarning = '';
    try {
      const legacy = JSON.parse(sessionStorage.getItem(RECEIPT_KEY) || 'null');
      if (legacy?.id === state.order.id && legacy?.endpoint === base) sessionStorage.removeItem(RECEIPT_KEY);
    } catch { /* Durable receipt is already verified; legacy cleanup is optional. */ }
    return true;
  }
  function storageError() {
    if (state.receiptConflict) return userError(`此浏览器已有未完成订单（${state.receiptConflict}）。已保留原订单凭证，请回到原标签页，或刷新此页继续原订单。当前不会请求签名或转账。`);
    return userError('浏览器暂时无法保存订单凭证。请允许本站存储后再试，当前不会请求签名或转账。');
  }
  function warnReceiptLoss() {
    if (isTrial()) state.storageWarning = state.receiptConflict ? '另一个标签页已有未完成订单，已保留该订单凭证。本页免费合影仍会继续制作，请保存本页订单号，完成后立即下载。' : '浏览器暂时无法保存订单凭证，免费合影仍会继续制作。请保存本页订单号，完成后立即下载。';
    else state.storageWarning = state.receiptConflict ? '另一个标签页已有未完成订单，已保留该订单凭证。本页付款仍会继续核验，请保存本页的订单号和交易哈希，不要再次付款，合影完成后立即下载。' : '浏览器暂时无法保存订单凭证，本次付款仍会继续核验。请保存页面上的订单号和交易哈希，不要再次付款，合影完成后立即下载。';
  }
  try {
    const durable = localStorage.getItem(RECEIPT_KEY);
    const legacy = durable ? null : sessionStorage.getItem(RECEIPT_KEY);
    const saved = JSON.parse(durable || legacy || 'null');
    if (base && saved?.endpoint === base && /^[A-Za-z0-9_-]{8,128}$/.test(saved.id) && typeof saved.token === 'string' && saved.token.length >= 16 && saved.token.length <= 512) {
      state.order = receiptMetadata(saved);
      restoredOrderId = saved.id;
      state.message = '找到此浏览器中保存的订单，可继续查看。';
      if (legacy) storeReceipt();
    }
  } catch { /* Ignore invalid or unavailable storage. */ }

  function isTrial(order = state.order) { return order?.billingMode === 'free_trial'; }
  function orderRecipient(order = state.order) {
    if (isTrial(order)) return '';
    const lines = typeof order?.signatureMessage === 'string' ? order.signatureMessage.split('\n').filter(line => line.startsWith('Recipient:')) : [];
    const signed = lines.length === 1 && /^Recipient: 0x[0-9a-f]{40}$/i.test(lines[0]) ? lines[0].slice(11) : '';
    const payment = typeof order?.payment?.to === 'string' && /^0x[0-9a-f]{40}$/i.test(order.payment.to) ? order.payment.to : '';
    if (signed && payment && signed.toLowerCase() !== payment.toLowerCase()) return '';
    return payment || signed;
  }
  function allowedRecipient(recipient, order = state.order) {
    return recipient?.toLowerCase() === config.recipient.toLowerCase() || (order?.id === restoredOrderId && recipient?.toLowerCase() === LEGACY_RECIPIENT.toLowerCase());
  }
  function displayedRecipient() {
    return state.order?.billingMode === 'paid' && state.order.status !== 'completed' ? state.order.recipient || orderRecipient() || config.recipient : config.recipient;
  }
  function orderQuote(order = state.order) {
    if (isTrial(order)) return { mode: 'free_trial', wei: '0', bnb: '0' };
    const wei = String(order?.priceWei || order?.payment?.valueWei || config.priceWei);
    return { mode: 'paid', wei, bnb: ORDER_PRICES[wei] || config.priceBnb };
  }
  function trialKnown() { return state.trialAddress.toLowerCase() === state.account.toLowerCase() && ['eligible', 'used'].includes(state.trialEligibility); }
  function displayedQuote() {
    if (state.order && state.order.status !== 'completed') return orderQuote();
    if (trialKnown()) return state.trialEligibility === 'eligible' ? { mode: 'free_trial', wei: '0', bnb: '0' } : { mode: 'paid', wei: config.priceWei, bnb: config.priceBnb };
    return { mode: 'unknown', wei: null, bnb: null };
  }
  function orderLabel(status) {
    if (!isTrial()) return labels[status] || '正在查询这笔订单。';
    return ({
      awaiting_authorization: '首次免费订单已准备好，等待钱包签名。',
      queued: '首次免费已确认，AI 合影正在排队。',
      submitting: '正在提交这次首次免费的 AI 合影。',
      generating: 'AI 正在制作你的首次免费合影。',
      completed: '首次免费 AI 合影已完成。可以下载或收藏。',
      review_required: '首次免费订单需要服务方核查。请保留订单号，不要重复创建任务。',
      failed: '首次免费 AI 合影暂未完成。请保留订单号，继续查看原任务。',
    })[status] || '正在查询这次首次免费订单。';
  }
  function render() {
    const inputBusy = getInput().busy;
    const paid = state.mode === 'paid';
    $('modeFree').classList.toggle('selected', !paid); $('modeFree').setAttribute('aria-pressed', String(!paid));
    $('modePaid').classList.toggle('selected', paid); $('modePaid').setAttribute('aria-pressed', String(paid));
    $('modeFree').disabled = state.busy || inputBusy; $('modePaid').disabled = state.busy || inputBusy;
    $('paidPanel').hidden = !paid; $('shootButton').hidden = paid;
    $('serviceNote').innerHTML = paid ? 'AI 合影 · 每个钱包首次免费<br>之后 0.001 BNB / 次，由第三方 AI 服务生成。' : '本地模板合成 · 保留真实五官<br>头像不上传，不使用生图额度。';
    $('paidAvailability').textContent = state.checking ? '正在确认 AI 合影是否可以使用…' : state.healthPending ? '正在核验 AI 服务，请稍后点击重新检查。核验完成前无法生成或付款。' : state.ready ? 'AI 合影已开放。每个钱包首次免费，之后每次 0.001 BNB。' : base ? 'AI 服务暂未连接，免费模板仍可使用。当前无法生成或付款，请稍后重新检查。' : 'AI 合影尚未开放。你可以继续免费拍摄。';
    $('paidAvailability').classList.toggle('ready', state.ready);
    $('paidHealthRetry').hidden = !base || state.ready; $('paidHealthRetry').disabled = state.checking || state.busy;
    $('paidConsent').disabled = !state.ready || state.busy;
    $('paidConnect').disabled = !state.ready || state.busy;
    $('paidConnect').textContent = state.account ? '更换钱包连接' : '连接钱包';
    $('paidWallet').hidden = !state.account;
    $('paidWallet').textContent = state.account ? `当前钱包：${state.account.slice(0, 6)}…${state.account.slice(-4)}` : '';
    $('paidRecipient').textContent = displayedRecipient();
    const existing = state.order && state.order.status !== 'completed';
    const quote = displayedQuote();
    const noTransfer = quote.mode === 'free_trial';
    $('paidPrice').textContent = noTransfer ? '首次免费 · 0 BNB' : quote.mode === 'paid' ? `${quote.bnb} BNB` : '首次免费资格待核验';
    $('paidFeeNote').textContent = noTransfer ? '只需签名，不支付 BNB，不产生网络手续费' : quote.mode === 'paid' ? quote.bnb === config.priceBnb ? '钱包另计网络手续费' : '这是旧订单创建时约定的金额；新订单为 0.001 BNB' : '之后 0.001 BNB / 次，付费时另计网络手续费';
    $('paidWalletExplanation').textContent = noTransfer ? '本次首次免费，只需钱包签名确认订单。不会请求转账。' : quote.mode === 'paid' ? `钱包先请求签名确认订单（不扣费），再请求支付 ${quote.bnb} BNB。请核对网络、金额和收款地址。` : '连接钱包后核验首次免费资格。首次免费只需签名，之后的合影需要支付 0.001 BNB。';
    $('paidTrialStatus').textContent = state.trialEligibility === 'checking' ? '正在核验此钱包的首次免费资格…' : !state.account ? '连接钱包后，核验首次免费资格。' : trialKnown() ? state.trialEligibility === 'eligible' ? '此钱包可以使用一次免费 AI 合影。' : '此钱包的首次免费名额已使用；之后每次 0.001 BNB。' : '暂时无法确认首次免费资格，尚未请求生成或付款。';
    $('paidTrialRetry').hidden = !state.account || !state.ready || trialKnown();
    $('paidTrialRetry').disabled = state.busy || state.trialEligibility === 'checking';
    $('paidGenerate').disabled = !state.ready || state.busy || getInput().photoLoading || !state.account || !$('paidConsent').checked || (!existing && (!getInput().photo || !trialKnown()));
    $('paidGenerate').querySelector('span').textContent = existing ? ['awaiting_authorization', 'awaiting_payment'].includes(state.order.status) && !state.order.txHash && !state.order.paymentRequested ? noTransfer ? '签名并免费生成' : `支付 ${quote.bnb} BNB 并继续` : '继续查看这笔订单' : noTransfer ? '签名并免费生成' : quote.mode === 'paid' ? `支付 ${quote.bnb} BNB 并生成` : '核验资格后生成 AI 合影';
    $('paidOrderInfo').hidden = !state.order;
    $('paidOrderStatus').textContent = state.message || labels[state.order?.status] || '';
    $('paidOrderId').textContent = state.order ? `订单号：${state.order.id}` : '';
    $('paidTransaction').hidden = isTrial() || !state.order?.txHash;
    $('paidTransaction').textContent = state.order?.txHash ? `交易凭证：${state.order.txHash}` : '';
    $('paidResume').hidden = !state.order || state.busy;
    // An existing order can be read even when new generation capacity is unavailable.
    $('paidResume').disabled = !base;
    $('paidResume').textContent = state.order?.status === 'completed' ? '重新打开已生成合影' : '继续这笔订单';
    $('paidPause').hidden = !state.busy || !['confirming', 'generating', 'polling'].includes(state.stage);
    $('paidTxRecovery').hidden = isTrial() || !state.order?.paymentRequested || state.busy || !['awaiting_authorization', 'awaiting_payment'].includes(state.order?.status) || (!!state.order?.txHash && !state.error);
    $('paidSubmitTx').disabled = state.busy || isTrial();
    document.querySelector('.receipt-note').textContent = isTrial() ? '订单凭证保存在此浏览器，清理站点数据可能丢失，请保存订单号。照片完成后记得下载。' : '订单凭证保存在此浏览器，清理站点数据可能丢失，请保存订单号和交易哈希。照片完成后记得下载。';
    const visibleError = [state.storageWarning, state.error].filter(Boolean).join(' ');
    $('paidError').hidden = !visibleError; $('paidError').textContent = visibleError;
  }
  function setBusy(busy) { state.busy = busy; onBusy(busy); render(); }
  function setStage(stage, message) {
    state.stage = stage; state.message = message; render();
    if (state.busy) onStatus(message, displayedQuote().mode === 'free_trial' ? '本次首次免费，只生成这笔订单的合影，不会请求转账。' : stage === 'confirming' ? '付款需要链上确认，确认前不会扣用 AI 生图额度。' : '每笔订单只对应本次 AI 合影，请不要重复创建订单。');
  }
  function errorMessage(error) {
    if (Number(error?.code) === 4001 || Number(error?.code) === -32002) return '钱包操作已取消，或有请求等待确认。订单会保留，可稍后继续。';
    if (error?.name === 'AbortError') return '连接暂时超时。订单会保留，可稍后继续查看。';
    if (Number(error?.code) === 4902) return '钱包尚未添加 BNB Smart Chain 主网，请在钱包中添加此网络后重试。';
    return error?.userMessage || (isTrial() ? '暂时无法继续。首次免费订单会保留，请稍后查看原订单。' : '暂时无法继续。订单会保留，请稍后重试；已付款请不要再次付款。');
  }
  function userError(message) { const safeMessage = String(message).replace(/libtv/gi, 'AI 服务'); const error = new Error(safeMessage); error.userMessage = safeMessage; return error; }
  async function request(path, { method = 'GET', data, token, blob = false, freshPreflight = false } = {}) {
    if (!base) throw userError('AI 合影尚未开放，当前无法付款。');
    const controller = new AbortController();
    // Only fresh service verification waits longer; health and order polling stay bounded.
    const timeout = setTimeout(() => controller.abort(), blob || freshPreflight ? 60000 : 20000);
    try {
      const response = await fetch(`${base}${path}`, { method, headers: { ...(data ? { 'Content-Type': 'application/json' } : {}), ...(token ? { Authorization: `Bearer ${token}` } : {}) }, ...(data ? { body: JSON.stringify(data) } : {}), signal: controller.signal, credentials: 'omit', cache: 'no-store', redirect: 'error' });
      if (!response.ok) {
        const body = await response.json().catch(() => ({}));
        const rawMessage = body.error?.message || body.message;
        const message = typeof rawMessage === 'string' ? rawMessage.slice(0, 240) : '';
        const error = userError(message || (response.status === 429 ? '操作有点频繁，请稍后继续。' : '这笔订单暂时无法处理，请稍后继续。'));
        error.apiCode = body.error?.code || body.code;
        throw error;
      }
      return blob ? response.blob() : response.json();
    } finally { clearTimeout(timeout); }
  }
  function matchesService(info) {
    return info?.ready === true && Number(info.chainId) === config.chainId && String(info.recipient).toLowerCase() === config.recipient.toLowerCase() && String(info.priceWei) === config.priceWei && String(info.priceBnb) === config.priceBnb && info.provider === 'libtv' && info.firstFree === config.firstFree && info.trialPolicy === config.trialPolicy;
  }
  async function checkHealth() {
    if (!base || state.checking) { render(); return false; }
    state.checking = true; render();
    try {
      const info = await request('/api/health');
      state.ready = matchesService(info);
      state.healthPending = !state.ready && info?.checking === true;
    }
    catch { state.ready = false; state.healthPending = false; }
    finally { state.checking = false; render(); }
    return state.ready;
  }
  async function checkEligibility() {
    if (!base || !state.ready || !/^0x[0-9a-f]{40}$/i.test(state.account)) return null;
    const address = state.account;
    state.trialEligibility = 'checking'; state.trialAddress = ''; render();
    if (state.busy) setStage('checking_trial', '正在核验首次免费资格，请稍等。不会请求转账。');
    try {
      const info = await request(`/api/trial?address=${encodeURIComponent(address)}`, { freshPreflight: true });
      if (info?.policy !== config.trialPolicy || typeof info.eligible !== 'boolean') throw userError('首次免费资格暂时无法核验，请稍后重试。');
      if (state.account.toLowerCase() !== address.toLowerCase()) return null;
      state.trialAddress = address; state.trialEligibility = info.eligible ? 'eligible' : 'used';
      return info.eligible;
    } catch {
      if (state.account.toLowerCase() === address.toLowerCase()) { state.trialEligibility = 'unknown'; state.trialAddress = address; }
      return null;
    } finally { render(); }
  }
  function wallet() {
    if (!window.ethereum?.request) throw userError('请使用支持 BNB Smart Chain 的钱包浏览器，或安装钱包扩展后再继续。');
    return window.ethereum;
  }
  async function ensureChain(provider) {
    let chain = await provider.request({ method: 'eth_chainId' });
    if (Number.parseInt(chain, 16) !== config.chainId) {
      await provider.request({ method: 'wallet_switchEthereumChain', params: [{ chainId: config.chainHex }] });
      chain = await provider.request({ method: 'eth_chainId' });
    }
    if (Number.parseInt(chain, 16) !== config.chainId) throw userError('请将钱包切换到 BNB Smart Chain 主网后继续。');
  }
  async function connect() {
    if (state.busy) return;
    state.error = ''; setBusy(true); setStage('connecting', '请在钱包中确认连接。');
    try {
      if (!await checkHealth()) throw userError('AI 合影暂不可用，当前无法付款。');
      const provider = wallet();
      const accounts = await provider.request({ method: 'eth_requestAccounts' });
      if (!/^0x[0-9a-f]{40}$/i.test(accounts?.[0])) throw userError('暂未取得钱包地址，请重新连接钱包。');
      await ensureChain(provider); state.account = accounts[0];
      const eligible = await checkEligibility();
      setStage('ready', eligible === true ? '此钱包首次 AI 合影免费。上传照片并授权后，即可签名生成。' : eligible === false ? '首次免费名额已使用。上传照片并授权后，可确认 0.001 BNB 的合影。' : '钱包已连接，首次免费资格暂时无法核验。请稍后重试。');
    } catch (error) { state.error = errorMessage(error); }
    finally { setBusy(false); }
  }
  function validateBilling(order) {
    if (!['free_trial', 'paid'].includes(order?.billingMode) || !/^\d+$/.test(String(order.priceWei)) || !/^\d+(?:\.\d+)?$/.test(String(order.priceBnb))) throw userError('订单费用暂时无法核验，尚未请求签名或转账。');
    if (order.billingMode === 'free_trial') {
      if (BigInt(order.priceWei) !== 0n || Number(order.priceBnb) !== 0 || order.payment || order.txHash || order.status === 'awaiting_payment') throw userError('首次免费订单信息不一致，已停止操作，不会转账。');
    } else {
      const expectedBnb = ORDER_PRICES[String(order.priceWei)];
      if (!expectedBnb || String(order.priceBnb) !== expectedBnb) throw userError('订单金额不在可核验范围内，已停止付款。');
    }
  }
  function adoptOrder(order) {
    if (!order || order.id !== state.order?.id || typeof order.status !== 'string') throw userError('订单信息暂时无法核验，请稍后继续。');
    validateBilling(order);
    const recipient = isTrial(order) ? '' : orderRecipient(order);
    if (order.billingMode === 'paid' && ['awaiting_authorization', 'awaiting_payment'].includes(order.status) && !state.order.txHash && !state.order.paymentRequested) {
      const previousRecipient = state.order.recipient || orderRecipient(state.order);
      if (!allowedRecipient(recipient, order) || (previousRecipient && previousRecipient.toLowerCase() !== recipient.toLowerCase())) throw userError('订单收款地址无法核验或与原约定不同，已停止签名和付款。请核对原订单。');
    }
    // Retain only the private order receipt in this browser; never put it in a URL.
    const trial = order.billingMode === 'free_trial';
    state.order = { ...state.order, status: order.status, character: order.character || state.order.character, scene: order.scene || state.order.scene, options: order.options || state.order.options, payerAddress: order.payerAddress || state.order.payerAddress, expiresAt: order.expiresAt, billingMode: order.billingMode, priceWei: String(order.priceWei), priceBnb: String(order.priceBnb), recipient: trial ? undefined : recipient || state.order.recipient, txHash: trial ? undefined : order.txHash || state.order.txHash, signatureMessage: order.signatureMessage || state.order.signatureMessage, payment: trial ? undefined : order.payment || state.order.payment, paymentRequested: trial ? false : state.order.paymentRequested, recoverable: order.recoverable, paymentStatus: order.paymentStatus };
    state.message = orderLabel(order.status);
    if (trial && order.status !== 'awaiting_authorization' && state.account.toLowerCase() === state.order.payerAddress?.toLowerCase()) { state.trialEligibility = 'used'; state.trialAddress = state.account; }
    if (!storeReceipt() && (state.order.txHash || (trial && order.status !== 'awaiting_authorization'))) warnReceiptLoss();
    render();
  }
  function validatePayment(payment) {
    if (isTrial() || !payment || Number(payment.chainId) !== config.chainId || !allowedRecipient(payment.to) || String(payment.to).toLowerCase() !== String(state.order.recipient).toLowerCase() || String(payment.valueWei) !== state.order.priceWei || !/^0x[0-9a-f]+$/i.test(payment.valueHex) || BigInt(payment.valueHex) !== BigInt(state.order.priceWei) || !/^0x(?:[0-9a-f]{2})+$/i.test(payment.data)) throw userError('付款信息与已确认的订单费用和收款地址不一致，已停止付款。请稍后继续。');
  }
  function requirePaymentWindow() {
    // Once a wallet request or transaction exists, retain the receipt and query the chain.
    if (state.order?.paymentRequested || state.order?.txHash) return;
    if (typeof state.order?.expiresAt !== 'number' || !Number.isFinite(state.order.expiresAt) || state.order.expiresAt - Date.now() < 30000) {
      const error = userError(isTrial() ? '这笔未签名的首次免费订单已过期或即将过期，请重新创建一笔订单。' : '这笔未付款订单已过期或即将过期，当前不可付款。请重新创建一笔订单。');
      error.apiCode = 'ORDER_EXPIRED';
      throw error;
    }
  }
  async function currentAccount(provider) {
    const accounts = await provider.request({ method: 'eth_accounts' });
    if (!state.account || accounts?.[0]?.toLowerCase() !== state.account.toLowerCase() || (state.order?.payerAddress && state.order.payerAddress.toLowerCase() !== state.account.toLowerCase())) throw userError('钱包账号已变化，请连接创建此订单的钱包再继续。');
    await ensureChain(provider);
  }
  async function showResult(order, run) {
    setStage('generating', '合影已完成，正在打开照片。');
    const resultMeta = { ...state.order.options, character: state.order.character, scene: state.order.scene, orderId: state.order.id };
    const image = await request(`/api/orders/${encodeURIComponent(order.id)}/result`, { token: state.order.token, blob: true });
    if (!/^image\/(jpeg|png|webp)$/.test(image.type) || !image.size || image.size > 40 * 1024 * 1024) throw userError('合影暂时无法打开，可稍后重新查看订单。');
    if (run !== operation) return;
    // Always stamp the pristine server result, including when reopening an order.
    // No face or original watermark is covered: the signature gets its own footer.
    const stamped = await stampPhotoBlob(image, resultMeta.character, 'ai');
    if (run !== operation) return;
    onResult({ blob: stamped, ...resultMeta, photoMethod: 'ai', signatureVersion: SIGNATURE_VERSION });
    setStage('completed', orderLabel('completed'));
  }
  async function monitor(run) {
    while (run === operation) {
      let order;
      if (!isTrial() && state.order.txHash && ['awaiting_authorization', 'awaiting_payment'].includes(state.order.status)) {
        setStage('confirming', labels.awaiting_payment);
        order = await request(`/api/orders/${encodeURIComponent(state.order.id)}/payment`, { method: 'POST', token: state.order.token, data: { txHash: state.order.txHash } });
      } else {
        setStage('polling', state.message || '正在查询订单。');
        order = await request(`/api/orders/${encodeURIComponent(state.order.id)}`, { token: state.order.token });
      }
      if (run !== operation) return;
      adoptOrder(order);
      if (order.status === 'completed') { await showResult(order, run); return; }
      if (order.status === 'review_required') { setStage('review_required', orderLabel('review_required')); return; }
      if (order.status === 'failed') { setStage('failed', orderLabel('failed')); return; }
      if (order.status === 'awaiting_authorization' || (order.status === 'awaiting_payment' && !state.order.txHash)) return;
      setStage(order.status === 'awaiting_payment' ? 'confirming' : 'generating', state.message);
      await delay(3500);
    }
  }
  async function continueOrder(run, displayedPriceWei, clickedRecipient) {
    const orderPath = `/api/orders/${encodeURIComponent(state.order.id)}`;
    const existing = await request(orderPath, { token: state.order.token });
    if (run !== operation) return;
    adoptOrder(existing);
    if (existing.status === 'completed') { await showResult(existing, run); return; }
    if (existing.status === 'review_required') {
      if (!existing.recoverable) { setStage('review_required', orderLabel('review_required')); return; }
      setStage('polling', '正在恢复原来的 AI 任务，既不再次付款，也不创建新的生成。');
      adoptOrder(await request(`${orderPath}/retry`, { method: 'POST', token: state.order.token, data: {} }));
    }
    if (existing.status === 'failed') {
      if (!existing.recoverable) { setStage('failed', orderLabel('failed')); return; }
      adoptOrder(await request(`${orderPath}/retry`, { method: 'POST', token: state.order.token, data: {} }));
    }
    if (['awaiting_authorization', 'awaiting_payment'].includes(state.order.status) && !state.order.txHash) {
      requirePaymentWindow();
      const legacy = !isTrial() && state.order.recipient?.toLowerCase() === LEGACY_RECIPIENT.toLowerCase();
      if (!isTrial() && (String(displayedPriceWei) !== state.order.priceWei || clickedRecipient.toLowerCase() !== state.order.recipient.toLowerCase() || (legacy && legacyRecipientAcknowledged !== state.order.id))) {
        if (legacy) legacyRecipientAcknowledged = state.order.id;
        throw userError(`这笔${legacy ? '旧' : ''}订单约定支付 ${state.order.priceBnb} BNB，收款地址为 ${state.order.recipient}。已更新页面，请核对金额和地址后再次点击；当前不会签名或转账。`);
      }
      if (!$('paidConsent').checked) throw userError('请先勾选本次照片发送授权，再继续这笔订单。');
      if (!await checkHealth()) throw userError(isTrial() ? 'AI 合影暂不可用，尚未签名使用首次免费名额。订单会保留。' : 'AI 合影暂不可用，已停止付款。订单会保留。');
      const provider = wallet();
      if (!state.account) {
        const accounts = await provider.request({ method: 'eth_requestAccounts' });
        state.account = accounts?.[0] || '';
      }
      await currentAccount(provider);
      if (state.order.paymentRequested) throw userError('钱包曾请求过这笔付款，请先核对钱包记录。若已付款，请填写交易哈希；不要重复付款。');
      if (state.order.status === 'awaiting_authorization') {
        if (!storeReceipt()) throw storageError();
        requirePaymentWindow();
        if (typeof state.order.signatureMessage !== 'string' || state.order.signatureMessage.length > 4096) throw userError('订单签名信息暂时无法核验，请稍后继续。');
        setStage('signing', isTrial() ? '请在钱包签名确认首次免费订单，不会请求转账。' : '请在钱包签名确认这笔订单，签名不扣费。');
        const messageHex = '0x' + [...new TextEncoder().encode(state.order.signatureMessage)].map(byte => byte.toString(16).padStart(2, '0')).join('');
        const signedBillingMode = state.order.billingMode, signedPriceWei = state.order.priceWei, signedRecipient = state.order.recipient;
        const signature = await provider.request({ method: 'personal_sign', params: [messageHex, state.account] });
        if (run !== operation) return;
        setStage('authorizing', isTrial() ? '正在核验首次免费订单，请稍等。不会请求转账。' : '正在核验订单，请稍等。此时尚未请求付款。');
        const authorized = await request(`${orderPath}/authorize`, { method: 'POST', token: state.order.token, data: { signature }, freshPreflight: true });
        if (authorized.billingMode !== signedBillingMode || String(authorized.priceWei) !== signedPriceWei || (signedBillingMode === 'paid' && orderRecipient(authorized).toLowerCase() !== signedRecipient.toLowerCase())) throw userError('签名后的订单费用或收款地址发生变化，已停止操作，不会请求转账。请稍后核对原订单。');
        adoptOrder(authorized);
      }
      if (isTrial()) {
        if (state.order.status === 'awaiting_authorization') throw userError('首次免费订单尚未确认，请稍后继续，不会转账。');
        await monitor(run);
        return;
      }
      // Another tab may already have confirmed this exact order while the wallet was open.
      if (!['awaiting_authorization', 'awaiting_payment'].includes(state.order.status)) { await monitor(run); return; }
      if (!await checkHealth()) throw userError('AI 合影暂不可用，已停止付款。订单会保留。');
      validatePayment(state.order.payment);
      await currentAccount(provider);
      requirePaymentWindow();
      setStage('paying', `请在钱包确认支付 ${state.order.priceBnb} BNB，并核对收款地址。`);
      const payment = state.order.payment;
      // A refresh while the wallet is open must never start a second transfer.
      state.order.paymentRequested = true;
      if (!storeReceipt()) {
        state.order.paymentRequested = false;
        storeReceipt(); // Best effort also removes a marker if the write succeeded but read-back failed.
        throw storageError();
      }
      let txHash;
      try { txHash = await provider.request({ method: 'eth_sendTransaction', params: [{ from: state.account, to: payment.to, value: payment.valueHex, data: payment.data }] }); }
      catch (error) { if (Number(error?.code) === 4001) { state.order.paymentRequested = false; storeReceipt(); } throw error; }
      if (!/^0x[0-9a-f]{64}$/i.test(txHash)) throw userError('钱包未返回有效交易凭证，请核对钱包记录后继续。');
      state.order.txHash = txHash;
      if (!storeReceipt()) warnReceiptLoss();
    }
    await monitor(run);
  }
  async function generate({ resumeOnly = false } = {}) {
    if (state.busy) return;
    if (!base) { state.error = 'AI 合影尚未开放，当前无法付款。'; render(); return; }
    const clickedQuote = displayedQuote(), clickedRecipient = displayedRecipient();
    state.error = ''; const run = ++operation; setBusy(true);
    try {
      const input = getInput();
      const useExisting = state.order && (resumeOnly || state.order.status !== 'completed');
      if (!useExisting) {
        if (!await checkHealth()) throw userError('AI 合影暂不可用，尚未请求生成或付款。');
        if (!input.photo || !state.account || !$('paidConsent').checked) throw userError('请先上传照片、连接钱包并勾选本次发送授权。');
        await currentAccount(wallet());
        if (!['free_trial', 'paid'].includes(clickedQuote.mode)) throw userError('请先核验首次免费资格，再确认本次费用。');
        const eligible = await checkEligibility();
        if (eligible === null) throw userError('首次免费资格暂时无法核验，尚未请求签名或转账。请稍后重试。');
        const expectedBillingMode = eligible ? 'free_trial' : 'paid';
        if (expectedBillingMode !== clickedQuote.mode) throw userError('首次免费资格已更新。请核对页面显示的本次费用后，再点击生成；当前不会转账。');
        setStage('creating', expectedBillingMode === 'free_trial' ? '正在核验服务并准备首次免费订单，请稍等。' : '正在核验服务并准备 0.001 BNB 的订单，请稍等。此时尚未付款。');
        const options = { gender: input.gender, body: input.body, outfit: input.outfit };
        const order = await request('/api/orders', { method: 'POST', data: { payerAddress: state.account, photoDataUrl: input.photo.dataURL, character: input.character, scene: input.scene, options, expectedBillingMode }, freshPreflight: true });
        if (!/^[A-Za-z0-9_-]{8,128}$/.test(order?.id) || typeof order.token !== 'string' || order.token.length < 16 || order.token.length > 512 || order.status !== 'awaiting_authorization') throw userError('订单暂时无法核验，尚未请求付款。');
        validateBilling(order);
        const recipient = isTrial(order) ? undefined : orderRecipient(order);
        if (order.billingMode === 'paid' && recipient?.toLowerCase() !== config.recipient.toLowerCase()) throw userError('新订单的收款地址与当前公布地址不一致，已停止操作，不会签名或付款。');
        state.order = { id: order.id, token: order.token, status: order.status, signatureMessage: order.signatureMessage, recipient, payerAddress: state.account, character: input.character, scene: input.scene, options, createdAt: Date.now(), expiresAt: order.expiresAt, billingMode: order.billingMode, priceBnb: String(order.priceBnb), priceWei: String(order.priceWei) };
        if (!storeReceipt()) throw storageError();
        render();
        if (order.billingMode !== expectedBillingMode || (order.billingMode === 'paid' && state.order.priceWei !== config.priceWei)) throw userError('订单费用与刚确认的首次免费资格或金额不同。已停止操作，请核对页面报价后重试；当前不会签名或转账。');
      }
      if (!state.order) throw userError('未找到可继续的订单。');
      await continueOrder(run, clickedQuote.wei, clickedRecipient);
    } catch (error) {
      if (run === operation) {
        state.error = errorMessage(error);
        if (error.apiCode === 'ORDER_EXPIRED' && state.order && !state.order.paymentRequested && !state.order.txHash) { clearReceipt(state.order.id); state.order = null; }
        if (error.apiCode === 'TRIAL_CHANGED') { await checkEligibility(); state.error = '首次免费资格已变化，请核对当前费用后重新点击。当前不会转账。'; }
      }
    }
    finally { if (run === operation) { setBusy(false); render(); } }
  }
  function selectMode(mode) {
    if (state.busy || getInput().busy || state.mode === mode) return;
    state.mode = mode; onModeChange(mode); render();
    if (mode === 'paid' && base) checkHealth().then(ready => { if (ready && state.account) checkEligibility(); });
  }
  $('modeFree').addEventListener('click', () => selectMode('free'));
  $('modePaid').addEventListener('click', () => selectMode('paid'));
  $('paidHealthRetry').addEventListener('click', async () => { if (await checkHealth() && state.account) await checkEligibility(); });
  $('paidTrialRetry').addEventListener('click', checkEligibility);
  $('paidConsent').addEventListener('change', render);
  $('paidConnect').addEventListener('click', connect);
  $('paidGenerate').addEventListener('click', () => generate());
  $('paidResume').addEventListener('click', () => generate({ resumeOnly: true }));
  $('paidSubmitTx').addEventListener('click', () => {
    if (isTrial()) { state.error = '首次免费订单不需要付款，不接受交易哈希。'; render(); return; }
    const txHash = $('paidTxHash').value.trim();
    if (!state.order || state.busy || !/^0x[0-9a-f]{64}$/i.test(txHash)) { state.error = '请填写钱包中该笔付款的完整交易哈希（0x 开头的 66 个字符）。'; render(); return; }
    state.order.txHash = txHash;
    if (!storeReceipt()) warnReceiptLoss();
    generate({ resumeOnly: true });
  });
  $('paidPause').addEventListener('click', () => {
    if (!state.busy || !['confirming', 'generating', 'polling'].includes(state.stage)) return;
    ++operation; setBusy(false); state.message = '订单已保留。回到 AI 合影模式，可继续查看。'; selectMode('free'); render();
  });
  window.addEventListener('pagehide', () => { ++operation; });
  render();
  return {
    refresh: render,
    get mode() { return state.mode; },
    snapshot: () => ({ mode: state.mode, available: state.ready, configured: !!base, healthChecking: state.checking || state.healthPending, busy: state.busy, stage: state.stage, walletConnected: !!state.account, trialEligibility: state.trialEligibility, billingMode: state.order?.billingMode || null, orderPriceBnb: state.order?.priceBnb || null, orderStatus: state.order?.status || null, hasOrder: !!state.order, hasTransaction: !!state.order?.txHash, message: state.message, error: state.error, storageWarning: state.storageWarning }),
  };
}
