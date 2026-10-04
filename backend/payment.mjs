import { JsonRpcProvider, getAddress, formatEther } from 'ethers';
import { ApiError, requireValue } from './errors.mjs';

export const CHAIN_ID = 56;
export const PRICE_WEI = '100000000000000';
export const PRICE_BNB = '0.0001';
export const RECIPIENT = getAddress('0x7c4383da12264bed66d125ef34d4a4a8bb8979f2');
export const TX_PATTERN = /^0x[0-9a-fA-F]{64}$/;

const same = (a, b) => typeof a === 'string' && typeof b === 'string' && a.toLowerCase() === b.toLowerCase();

export function createChainProvider(rpcUrl) {
  if (!rpcUrl) return null;
  const parsed = new URL(rpcUrl);
  if (parsed.protocol !== 'https:' && !(parsed.protocol === 'http:' && ['127.0.0.1', 'localhost'].includes(parsed.hostname))) throw new Error('BSC_RPC_URL must be HTTPS (or loopback HTTP)');
  return new JsonRpcProvider(rpcUrl, undefined, { cacheTimeout: -1, batchMaxCount: 1 });
}

export async function chainPreflight(chain) {
  if (!chain) throw new ApiError(503, 'RPC_UNAVAILABLE', '支付服务尚未配置');
  const network = await chain.getNetwork();
  requireValue(BigInt(network.chainId) === 56n, 503, 'RPC_WRONG_CHAIN', '支付服务网络配置错误');
  const [latest, finalized] = await Promise.all([chain.getBlock('latest'), chain.getBlock('finalized')]);
  requireValue(latest?.hash && finalized?.hash && Number.isSafeInteger(latest.number) && Number.isSafeInteger(finalized.number), 503, 'FINALITY_UNAVAILABLE', '暂时无法确认链上最终状态');
  requireValue(finalized.number <= latest.number && latest.timestamp * 1000 > Date.now() - 300_000, 503, 'RPC_STALE', '链上服务暂不可用');
  return { latest, finalized };
}

export async function verifyPayment(chain, order, hash) {
  requireValue(TX_PATTERN.test(hash), 400, 'INVALID_TX', '交易哈希格式不正确');
  const network = await chain.getNetwork();
  requireValue(BigInt(network.chainId) === BigInt(order.payment.chainId), 503, 'RPC_WRONG_CHAIN', '支付服务网络配置错误');
  const [tx, receipt] = await Promise.all([chain.getTransaction(hash), chain.getTransactionReceipt(hash)]);
  if (!tx || !receipt) return { pending: true };
  requireValue(same(tx.hash, hash) && same(receipt.hash || receipt.transactionHash, hash), 400, 'TX_MISMATCH', '链上交易信息不一致');
  requireValue(BigInt(tx.chainId) === BigInt(order.payment.chainId), 400, 'WRONG_CHAIN', '请使用 BNB Smart Chain 主网');
  requireValue(same(tx.from, order.payerAddress) && same(receipt.from, order.payerAddress), 400, 'WRONG_PAYER', '付款钱包与订单钱包不同');
  requireValue(same(tx.to, order.payment.to) && same(receipt.to, order.payment.to), 400, 'WRONG_RECIPIENT', '收款地址不正确');
  requireValue(BigInt(tx.value) === BigInt(order.payment.valueWei), 400, 'WRONG_AMOUNT', `付款金额必须为 ${formatEther(order.payment.valueWei)} BNB`);
  requireValue(same(tx.data || '0x', order.payment.data), 400, 'WRONG_ORDER', '交易不属于此订单');
  requireValue(receipt.status === 1, 400, 'TX_FAILED', '链上交易未成功');
  requireValue(Number.isSafeInteger(receipt.blockNumber) && tx.blockNumber === receipt.blockNumber && same(tx.blockHash, receipt.blockHash), 400, 'BLOCK_MISMATCH', '链上区块信息不一致');
  const [block, finalized] = await Promise.all([chain.getBlock(receipt.blockNumber), chain.getBlock('finalized')]);
  requireValue(block?.hash && same(block.hash, receipt.blockHash), 409, 'CHAIN_REORG', '交易尚未处于有效主链，请稍后重试');
  requireValue(receipt.blockNumber > order.startBlock, 400, 'OLD_PAYMENT', '交易早于订单授权');
  requireValue(block.timestamp * 1000 >= order.createdAt - 60_000, 400, 'OLD_PAYMENT', '交易早于订单创建');
  requireValue(finalized?.hash && Number.isSafeInteger(finalized.number), 503, 'FINALITY_UNAVAILABLE', '暂时无法确认链上最终状态');
  if (finalized.number < receipt.blockNumber) return { pending: true };
  return { pending: false, blockNumber: receipt.blockNumber, blockHash: receipt.blockHash, timestamp: block.timestamp * 1000, late: block.timestamp * 1000 > order.expiresAt };
}
