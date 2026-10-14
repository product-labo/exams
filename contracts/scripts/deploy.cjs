// Deploys ResultRegistry with (USDC, treasury, fee) read from ../.env. Treasury = ADMIN_WALLET.
const { ethers, network } = require('hardhat');
const fs = require('fs');

const env = Object.fromEntries(fs.readFileSync('../.env', 'utf8').split(/\r?\n/)
  .filter((l) => l.includes('=') && !l.startsWith('#')).map((l) => [l.slice(0, l.indexOf('=')), l.slice(l.indexOf('=') + 1)]));

(async () => {
  const token = env.USDC_ADDRESS, treasury = env.ADMIN_WALLET, fee = BigInt(env.FEE_UNITS || '100000'); // 0.10 USDC (6 decimals)
  if (!ethers.isAddress(token) || !ethers.isAddress(treasury)) throw new Error('USDC_ADDRESS and ADMIN_WALLET must be set in ../.env');
  const [d] = await ethers.getSigners();
  console.log(`Network:   ${network.name}\nDeployer:  ${d.address}\nUSDC:      ${token}\nTreasury:  ${treasury}\nFee:       ${fee} units`);
  const c = await (await ethers.getContractFactory('ResultRegistry')).deploy(token, treasury, fee);
  await c.waitForDeployment();
  console.log('CONTRACT_ADDRESS=' + (await c.getAddress()));
})().catch((e) => { console.error(e.message); process.exit(1); });
