// Loaded first. Fills in standard defaults, then refuses to start with a plain list of what is missing,
// instead of failing later with a confusing error (for example at admin login).
import { ethers } from 'ethers';

const env = process.env;

// Standard Base mainnet settings, so a deployment only has to provide the values that are really its own.
env.CHAIN_ID ||= '8453';
env.CHAIN_NAME ||= 'base';
if (env.CHAIN_ID === '8453') {
  env.RPC_URL ||= 'https://mainnet.base.org';
  env.USDC_ADDRESS ||= '0x833589fCD6eDb6E08f4c7C32D4f71b54bdA02913';
  env.EXPLORER_TX_URL ||= 'https://basescan.org/tx/';
}

const problems = [];
if (!env.SESSION_SECRET || env.SESSION_SECRET.length < 16) problems.push('SESSION_SECRET is missing or too short. Set it to 32 or more random characters.');
if (!env.ADMIN_WALLET || !ethers.isAddress(env.ADMIN_WALLET)) problems.push('ADMIN_WALLET is missing or is not a valid address. Set it to your admin wallet address (starts with 0x).');
if (!env.DATABASE_URL) problems.push('DATABASE_URL is not set. Create a Postgres database and set its connection URL.');
if (env.CONTRACT_ADDRESS && !ethers.isAddress(env.CONTRACT_ADDRESS)) problems.push('CONTRACT_ADDRESS is not a valid address.');
if (problems.length) {
  throw new Error('Configuration problems, fix these environment variables and redeploy:\n - ' + problems.join('\n - '));
}

// One line saying what is switched on, with no secrets, so a deployment log shows how it is configured.
const short = (a) => a.slice(0, 6) + '…' + a.slice(-4);
console.log(`Config: admin ${short(env.ADMIN_WALLET)} | chain ${env.CHAIN_NAME} (${env.CHAIN_ID}) | `
  + `payments ${env.CONTRACT_ADDRESS ? 'ON via ' + short(env.CONTRACT_ADDRESS) : 'OFF (CONTRACT_ADDRESS not set)'} | `
  + `AI generation ${env.GEMINI_API_KEY ? 'ON' : 'OFF (GEMINI_API_KEY not set)'}`);
