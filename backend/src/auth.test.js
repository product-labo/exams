import test from 'node:test';
import assert from 'node:assert/strict';
import { ethers } from 'ethers';
import { createNonce, verifyLogin, readToken } from './auth.js';

process.env.SESSION_SECRET = 'test-secret';
const adminW = ethers.Wallet.createRandom();
const otherW = ethers.Wallet.createRandom();
process.env.ADMIN_WALLET = adminW.address;
const req = (token) => ({ get: () => `Bearer ${token}` });

async function login(w) {
  const { message } = createNonce(w.address);
  return verifyLogin(w.address, await w.signMessage(message));
}

test('only the configured wallet becomes admin', async () => {
  assert.equal(readToken(req((await login(adminW)).token)).role, 'admin');
  assert.equal(readToken(req((await login(otherW)).token)).role, 'student');
});
test('signature from a different wallet is rejected', async () => {
  const { message } = createNonce(adminW.address);
  assert.throws(() => verifyLogin(adminW.address, otherW.signMessage ? 'x' : 'x'));
  createNonce(adminW.address);
  const sig = await otherW.signMessage(message);
  assert.throws(() => verifyLogin(adminW.address, sig), /nonce|signature/);
});
test('nonce is single-use and tampered tokens fail', async () => {
  const { message } = createNonce(otherW.address);
  const sig = await otherW.signMessage(message);
  const ok = verifyLogin(otherW.address, sig);
  assert.throws(() => verifyLogin(otherW.address, sig));
  assert.equal(readToken(req(ok.token + 'x')), null);
});
