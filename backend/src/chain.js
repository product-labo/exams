import { ethers } from 'ethers';

const ABI = [
  'function payAndAnchor(bytes32 resultHash)',
  'function anchoredAt(bytes32) view returns (uint256)',
  'function payerOf(bytes32) view returns (address)',
  'function fee() view returns (uint256)',
  'event Anchored(bytes32 indexed resultHash, address indexed payer, uint256 timestamp)',
];
const iface = new ethers.Interface(ABI);

export const chainConfigured = () => Boolean(process.env.RPC_URL && process.env.CONTRACT_ADDRESS);

// Free public RPC servers rate-limit ("request limit reached"), so reads fail over to the next server in this list.
const DEFAULT_FALLBACKS = {
  8453: ['https://base-rpc.publicnode.com', 'https://1rpc.io/base'],
  84532: ['https://base-sepolia-rpc.publicnode.com'],
};
export const rpcUrls = () => [...new Set([
  process.env.RPC_URL,
  ...(process.env.RPC_FALLBACK_URLS || '').split(',').map((x) => x.trim()),
  ...(DEFAULT_FALLBACKS[Number(process.env.CHAIN_ID || 8453)] || []),
].filter(Boolean))];

/** Run a read against the first RPC server that answers; only the last error is surfaced. */
export async function withRpc(fn) {
  const net = ethers.Network.from(Number(process.env.CHAIN_ID || 8453));
  let lastErr;
  for (const url of rpcUrls()) {
    const provider = new ethers.JsonRpcProvider(url, net, { staticNetwork: net });
    try { return await fn(provider); }
    catch (e) { lastErr = e; }
    finally { provider.destroy(); }
  }
  throw lastErr || new Error('no RPC server configured');
}

/** Hash binds the result to the student's wallet, so nobody else can claim it. */
export function resultHash({ sessionId, courseId, wallet, score, total, completedAt }) {
  return ethers.solidityPackedKeccak256(
    ['string', 'address', 'uint256', 'uint256', 'uint256', 'uint256'],
    [sessionId, wallet, courseId, score, total, Math.floor(new Date(completedAt).getTime() / 1000)],
  );
}

/** Public payment details the browser needs to build the transaction. */
export async function paymentConfig() {
  if (!chainConfigured()) return null;
  const fee = await withRpc((p) => new ethers.Contract(process.env.CONTRACT_ADDRESS, ABI, p).fee());
  return {
    chainId: Number(process.env.CHAIN_ID || 8453),
    chainName: process.env.CHAIN_NAME || 'base',
    contract: process.env.CONTRACT_ADDRESS,
    token: process.env.USDC_ADDRESS,
    fee: fee.toString(),
  };
}

/** Confirms a payAndAnchor tx: succeeded, from our contract, for this hash, paid by this wallet. */
export async function verifyPayment(txHash, expectedHash, expectedPayer) {
  let receipt = null, lastErr;
  for (let i = 0; i < 10 && !receipt; i++) {
    try { receipt = await withRpc((p) => p.getTransactionReceipt(txHash)); lastErr = null; }
    catch (e) { lastErr = e; }
    if (!receipt) await new Promise((r) => setTimeout(r, 1500));
  }
  if (!receipt) return { ok: false, reason: lastErr ? 'the blockchain servers are busy, please try again in a minute' : 'transaction not found yet, try again shortly' };
  if (receipt.status !== 1) return { ok: false, reason: 'transaction failed' };
  for (const log of receipt.logs) {
    if (log.address.toLowerCase() !== process.env.CONTRACT_ADDRESS.toLowerCase()) continue;
    let parsed;
    try { parsed = iface.parseLog(log); } catch { continue; }
    if (parsed?.name !== 'Anchored') continue;
    if (parsed.args.resultHash.toLowerCase() === expectedHash.toLowerCase() && parsed.args.payer.toLowerCase() === expectedPayer.toLowerCase()) {
      return { ok: true };
    }
  }
  return { ok: false, reason: 'no matching payment in this transaction' };
}

export async function onChainRecord(hash) {
  if (!chainConfigured()) return null;
  return withRpc(async (p) => {
    const c = new ethers.Contract(process.env.CONTRACT_ADDRESS, ABI, p);
    const [at, payer] = await Promise.all([c.anchoredAt(hash), c.payerOf(hash)]);
    return { anchoredAt: Number(at), payer };
  });
}
