// Deploys MockUSDC + ResultRegistry to a running `hardhat node` and prints their addresses.
const { ethers } = require('hardhat');
(async () => {
  const [, , , treasury] = await ethers.getSigners();
  const usdc = await (await ethers.getContractFactory('MockUSDC')).deploy();
  const reg = await (await ethers.getContractFactory('ResultRegistry')).deploy(await usdc.getAddress(), treasury.address, 100000n);
  console.log(JSON.stringify({ usdc: await usdc.getAddress(), registry: await reg.getAddress(), treasury: treasury.address }));
})();
