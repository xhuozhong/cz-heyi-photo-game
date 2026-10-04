const $ = id => document.getElementById(id);
const supportedHost = (location.protocol === 'https:' && location.hostname === 'xhuozhong.com') || (['localhost', '127.0.0.1', '[::1]'].includes(location.hostname) && ['http:', 'https:'].includes(location.protocol));
let token = null, widgetId = null, busy = false, configuration = null, scriptPromise = null, widgetEpoch = 0;
const deviceId = supportedHost ? btoa(String.fromCharCode(...crypto.getRandomValues(new Uint8Array(32)))).replace(/\+/g, '-').replace(/\//g, '_').replace(/=+$/, '') : '';

function status(message) { $('status').textContent = message; }
function clearWidget() {
  ++widgetEpoch;
  token = null; $('verify').disabled = true;
  if (widgetId !== null && window.turnstile) {
    try { window.turnstile.reset(widgetId); } catch { /* Expired or removed widgets still clear the local token. */ }
    try { window.turnstile.remove(widgetId); } catch { /* Cleanup cannot submit a token. */ }
  }
  widgetId = null; $('widget').replaceChildren();
}
function showResult(message, error = false) {
  $('result').hidden = false; $('result').textContent = message; $('result').classList.toggle('error', error);
}
function safeCode(body) {
  const code = body?.error?.code || body?.code;
  return typeof code === 'string' && /^[A-Z][A-Z0-9_]{0,50}$/.test(code) ? code : 'API_ERROR';
}
async function loadScript() {
  if (window.turnstile?.render && window.turnstile?.execute) return window.turnstile;
  if (scriptPromise) return scriptPromise;
  scriptPromise = new Promise((resolve, reject) => {
    const script = document.createElement('script'); script.async = true;
    script.src = 'https://challenges.cloudflare.com/turnstile/v0/api.js?render=explicit';
    const timeout = setTimeout(fail, 20000);
    function fail() { clearTimeout(timeout); script.remove(); reject(new Error('SCRIPT_UNAVAILABLE')); }
    script.onerror = fail;
    script.onload = () => {
      clearTimeout(timeout);
      if (!window.turnstile?.render || !window.turnstile?.execute) return fail();
      // An async script is initialized when onload fires. The actual SDK rejects
      // ready() with async/defer; no token is stored or logged here.
      resolve(window.turnstile);
    };
    document.head.append(script);
  }).catch(error => { scriptPromise = null; throw error; });
  return scriptPromise;
}
async function prepare() {
  if (!supportedHost || busy) return;
  busy = true; $('retry').disabled = true; clearWidget(); status('正在加载正式人机验证…');
  try {
    const response = await fetch('/api/health', { credentials: 'omit', cache: 'no-store', redirect: 'error' });
    if (!response.ok) throw new Error('SERVICE_UNAVAILABLE');
    const health = await response.json();
    if (health.turnstile?.required !== true || !/^[A-Za-z0-9_-]{10,128}$/.test(health.turnstile.siteKey || '') || health.turnstile.checkAction !== 'photo_check') throw new Error('CONFIG_UNAVAILABLE');
    configuration = health.turnstile;
    const client = await loadScript();
    const epoch = widgetEpoch;
    const fail = () => { if (epoch !== widgetEpoch) return; token = null; $('verify').disabled = true; status('人机验证暂未完成。可以点击“重新人机验证”，或检查网络后再试。'); };
    widgetId = client.render($('widget'), { sitekey: configuration.siteKey, action: 'photo_check', cData: deviceId, execution: 'execute', appearance: 'always', size: 'compact', theme: 'light', language: 'zh-cn', 'response-field': false,
      callback: value => {
        if (epoch !== widgetEpoch) return;
        if (typeof value !== 'string' || value.length < 10 || value.length > 4096) return fail();
        token = value; $('verify').disabled = busy; status('人机验证已完成。点击下方按钮检查正式验证和重复提交。');
      },
      'error-callback': () => { fail(); return true; },
      'expired-callback': () => { if (epoch !== widgetEpoch) return; token = null; $('verify').disabled = true; status('验证码已过期，请点击“重新人机验证”。'); },
      'timeout-callback': fail,
    });
    status('请完成人机验证，然后点击“验证并检查重复提交”。'); client.execute(widgetId);
  } catch {
    clearWidget(); configuration = null;
    status('人机验证或服务暂时无法加载。请检查网络后点击“重新人机验证”。当前未提交测试。');
  } finally { busy = false; $('retry').disabled = false; $('verify').disabled = !token; }
}
async function verify() {
  if (!supportedHost || busy || !token || !configuration) return;
  busy = true; $('verify').disabled = true; $('retry').disabled = true; status('正在验证一次，并检查同一验证码的重复提交…');
  let currentToken = token; token = null;
  const controller = new AbortController();
  const timeout = setTimeout(() => controller.abort(), 20000);
  const post = async () => {
    const response = await fetch('/api/human-check', { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ trialDeviceId: deviceId, turnstileToken: currentToken }), signal: controller.signal, credentials: 'omit', cache: 'no-store', redirect: 'error' });
    const body = await response.json().catch(() => ({}));
    return { status: response.status, verified: body.verified === true, code: safeCode(body) };
  };
  try {
    const first = await post();
    if (first.status !== 200 || !first.verified) {
      showResult(`首次验证未通过：HTTP ${first.status}，${first.code}。\n未创建订单、生成照片或请求付款。`, true);
      return;
    }
    const repeated = await post();
    const passed = repeated.status === 403;
    showResult(passed ? `连接检查通过：首次验证成功（HTTP 200）；同一验证码重复提交已被拒绝（HTTP 403，${repeated.code}）。\n未创建订单、生成照片或请求付款。` : `首次验证成功（HTTP 200），重复提交检查未通过：HTTP ${repeated.status}，${repeated.code}。\n未创建订单、生成照片或请求付款，请运营者检查服务配置。`, !passed);
  } catch {
    showResult('连接超时或请求暂未完成。本轮不会再提交，请点击“重新人机验证”后重试。\n未创建订单、生成照片或请求付款。', true);
  } finally {
    clearTimeout(timeout); currentToken = null; clearWidget(); busy = false; $('retry').disabled = false;
    status('本轮测试已结束。如需再次检查，请点击“重新人机验证”。');
  }
}
$('verify').addEventListener('click', verify);
$('retry').addEventListener('click', prepare);
window.addEventListener('pagehide', clearWidget);
if (supportedHost) prepare();
else { $('hostNotice').hidden = false; status('此测试页仅在正式服务域名或本地开发环境运行。当前不会发送验证请求。'); $('widget').hidden = true; }
