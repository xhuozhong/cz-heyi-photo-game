import { createHash, randomBytes } from 'node:crypto';

export const protectionConfig = {
  turnstileSecret: 'unit-test-secret-not-a-real-credential', turnstileSiteKey: 'unit-test-sitekey',
  turnstileHostnames: ['127.0.0.1', 'localhost'], trialHmacSecret: 'unit-test-ledger-pepper-not-a-real-secret',
  generationBudget: 100, trialTotalLimit: 20, trialDailyLimit: 5, trialIpDailyLimit: 2,
};
export const deviceFor = address => createHash('sha256').update(address.toLowerCase()).digest('base64url');
export const challengeToken = (action, deviceId, hostname = '127.0.0.1') => Buffer.from(JSON.stringify({ action, cdata: deviceId, hostname, nonce: randomBytes(12).toString('hex') })).toString('base64url');
export async function fakeTurnstileFetch(url, options) {
  if (url !== 'https://challenges.cloudflare.com/turnstile/v0/siteverify') throw new Error('Unexpected mock URL');
  try { return { ok: true, json: async () => ({ success: true, ...JSON.parse(Buffer.from(options.body.get('response'), 'base64url').toString('utf8')) }) }; }
  catch { return { ok: true, json: async () => ({ success: false }) }; }
}
export const proofContext = address => ({ ip: '203.0.113.20', hostname: '127.0.0.1', deviceId: deviceFor(address) });
export const proofBody = body => {
  const trialDeviceId = body.trialDeviceId || deviceFor(body.payerAddress);
  return { ...body, trialDeviceId, turnstileToken: body.turnstileToken || challengeToken('photo_order', trialDeviceId) };
};
export const createWithProof = (service, body) => service.create(proofBody(body), proofContext(body.payerAddress));
export function authorizeWithProof(service, id, token, signature) {
  const payer = service.store.state.orders[id]?.payerAddress || 'missing';
  const context = proofContext(payer);
  return service.authorize(id, token, signature, { ...context, turnstileToken: challengeToken('photo_trial', context.deviceId) });
}
export const trialWithProof = (service, wallet) => service.trial(wallet, proofContext(wallet));
