// Sign in with an injected wallet (MetaMask, Rabby, Coinbase Wallet...). Signing is free; no transaction is sent.
async function walletLogin() {
  if (!window.ethereum) throw new Error('No wallet found. Install MetaMask or another browser wallet.');
  const [address] = await window.ethereum.request({ method: 'eth_requestAccounts' });
  const post = (url, body) => fetch(url, { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify(body) })
    .then(async (r) => { const j = await r.json(); if (!r.ok) throw new Error(j.error || r.status); return j; });
  const { message } = await post('/api/auth/nonce', { address });
  const signature = await window.ethereum.request({ method: 'personal_sign', params: [message, address] });
  const session = await post('/api/auth/verify', { address, signature });
  try { sessionStorage.setItem('walletSession', JSON.stringify(session)); } catch {}
  return session; // { token, address, role }
}
function walletSession() {
  try { return JSON.parse(sessionStorage.getItem('walletSession')); } catch { return null; }
}
function authHeaders() {
  const s = walletSession();
  return s ? { Authorization: 'Bearer ' + s.token } : {};
}
