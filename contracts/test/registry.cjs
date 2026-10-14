const assert = require('node:assert/strict');
const { ethers } = require('hardhat');
const reverts = async (p) => { try { await (await p).wait?.(); return false; } catch { return true; } };
const FEE = 100000n; // 0.1 USDC

async function setup() {
  const [owner, student, other, treasury] = await ethers.getSigners();
  const usdc = await (await ethers.getContractFactory('MockUSDC')).deploy();
  const reg = await (await ethers.getContractFactory('ResultRegistry')).deploy(await usdc.getAddress(), treasury.address, FEE);
  await usdc.mint(student.address, 1_000_000n);
  return { owner, student, other, treasury, usdc, reg };
}

describe('ResultRegistry', () => {
  it('student pays the fee to the treasury and the hash is anchored to them', async () => {
    const { student, treasury, usdc, reg } = await setup();
    const h = ethers.id('result-1');
    await (await usdc.connect(student).approve(await reg.getAddress(), FEE)).wait();
    await (await reg.connect(student).payAndAnchor(h)).wait();
    assert.equal(await usdc.balanceOf(treasury.address), FEE);
    assert.equal(await reg.payerOf(h), student.address);
    assert.ok((await reg.anchoredAt(h)) > 0n);
  });
  it('reverts without allowance, on duplicates, and for non-owner admin calls', async () => {
    const { student, other, usdc, reg } = await setup();
    const h = ethers.id('result-2');
    assert.ok(await reverts(reg.connect(student).payAndAnchor(h)), 'no allowance');
    await (await usdc.connect(student).approve(await reg.getAddress(), FEE * 2n)).wait();
    await (await reg.connect(student).payAndAnchor(h)).wait();
    assert.ok(await reverts(reg.connect(student).payAndAnchor(h)), 'duplicate');
    assert.ok(await reverts(reg.connect(other).setFee(1n)), 'non-owner setFee');
    assert.ok(await reverts(reg.connect(other).setTreasury(other.address)), 'non-owner setTreasury');
  });
});
