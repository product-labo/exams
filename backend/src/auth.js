import crypto from 'node:crypto';
import { ethers } from 'ethers';

const NONCES = new Map(); // address(lowercase) -> { nonce, expires }
const NONCE_TTL_MS = 5 * 60_000;
const TOKEN_TTL_S = 8 * 3600;

const secret = () => {
  if (!process.env.SESSION_SECRET) throw Object.assign(new Error('SESSION_SECRET is not set'), { status: 500 });
  return process.env.SESSION_SECRET;
};
const b64 = (o) => Buffer.from(JSON.stringify(o)).toString('base64url');
const sign = (data) => crypto.createHmac('sha256', secret()).update(data).digest('base64url');

export const adminAddress = () => (process.env.ADMIN_WALLET || '').toLowerCase();
const isAdmin = (addr) => Boolean(adminAddress()) && addr.toLowerCase() === adminAddress();

const messageFor = (address, nonce, issuedAt) =>
  `Sign in to Voice Exam\n\nWallet: ${address}\nNonce: ${nonce}\nIssued: ${issuedAt}\n\nThis signature costs no gas.`;

export function createNonce(address) {
  if (!ethers.isAddress(address)) throw Object.assign(new Error('invalid address'), { status: 400 });
  const addr = ethers.getAddress(address);
  const now = Date.now();
  for (const [k, v] of NONCES) if (v.expires < now) NONCES.delete(k); // keep the store from growing forever
  if (NONCES.size > 10_000) throw Object.assign(new Error('busy, try again shortly'), { status: 503 });
  const nonce = crypto.randomBytes(16).toString('hex');
  const issuedAt = new Date().toISOString();
  NONCES.set(addr.toLowerCase(), { nonce, issuedAt, expires: Date.now() + NONCE_TTL_MS });
  return { message: messageFor(addr, nonce, issuedAt) };
}

export function verifyLogin(address, signature) {
  if (!ethers.isAddress(address)) throw Object.assign(new Error('invalid address'), { status: 400 });
  const addr = ethers.getAddress(address);
  const entry = NONCES.get(addr.toLowerCase());
  NONCES.delete(addr.toLowerCase()); // one use only
  if (!entry || entry.expires < Date.now()) throw Object.assign(new Error('nonce expired, try again'), { status: 401 });
  let recovered;
  try { recovered = ethers.verifyMessage(messageFor(addr, entry.nonce, entry.issuedAt), signature); }
  catch { throw Object.assign(new Error('bad signature'), { status: 401 }); }
  if (recovered !== addr) throw Object.assign(new Error('signature does not match wallet'), { status: 401 });
  const role = isAdmin(addr) ? 'admin' : 'student';
  const body = b64({ addr, role, exp: Math.floor(Date.now() / 1000) + TOKEN_TTL_S });
  return { token: `${body}.${sign(body)}`, address: addr, role };
}

/** Returns { addr, role } for a valid Bearer token, else null. */
export function readToken(req) {
  const raw = (req.get('authorization') || '').replace(/^Bearer /, '');
  const [body, sig] = raw.split('.');
  if (!body || !sig) return null;
  const expected = sign(body);
  if (sig.length !== expected.length || !crypto.timingSafeEqual(Buffer.from(sig), Buffer.from(expected))) return null;
  try {
    const p = JSON.parse(Buffer.from(body, 'base64url').toString());
    if (p.exp < Date.now() / 1000) return null;
    // Re-check against the configured admin on every request, so changing ADMIN_WALLET revokes old tokens.
    return { addr: p.addr, role: p.role === 'admin' && isAdmin(p.addr) ? 'admin' : 'student' };
  } catch { return null; }
}
