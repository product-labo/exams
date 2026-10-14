require('@nomicfoundation/hardhat-ethers');
const fs = require('fs');
// Read keys from ../.env without printing them.
const env = Object.fromEntries((fs.existsSync('../.env') ? fs.readFileSync('../.env', 'utf8') : '')
  .split(/\r?\n/).filter((l) => l.includes('=') && !l.startsWith('#')).map((l) => [l.slice(0, l.indexOf('=')), l.slice(l.indexOf('=') + 1)]));
const accounts = env.ANCHOR_PRIVATE_KEY ? [env.ANCHOR_PRIVATE_KEY] : [];
module.exports = {
  solidity: '0.8.24',
  mocha: { timeout: 120000 },
  paths: { sources: './src', tests: './test' },
  networks: {
    baseSepolia: { url: 'https://sepolia.base.org', accounts, chainId: 84532 },
    base: { url: 'https://mainnet.base.org', accounts, chainId: 8453 },
  },
};
