const { expect } = require("chai");
const { ethers } = require("hardhat");
const { loadFixture, time } = require("@nomicfoundation/hardhat-toolbox/network-helpers");

const ONE = ethers.parseEther("1");
const DAY = 24 * 3600;

// La tesoreria es la MultiSignWallet del Parcial 2. Aqui se prueba con 2 owners y 2 aprobaciones.
describe("Tesoreria (MultiSignWallet)", function () {
  async function walletFixture() {
    const [a, b, c] = await ethers.getSigners();
    const Wallet = await ethers.getContractFactory("MultiSignWallet");
    const wallet = await Wallet.deploy([a.address, b.address], 2, [a.address, b.address], [80, 20], ONE);
    await wallet.deposit({ value: ethers.parseEther("2") });
    return { wallet, a, b, c };
  }

  it("valida el constructor", async function () {
    const [a] = await ethers.getSigners();
    const Wallet = await ethers.getContractFactory("MultiSignWallet");
    await expect(Wallet.deploy([], 1, [a.address], [1], 0)).to.be.revertedWith("Must have owners");
    await expect(Wallet.deploy([a.address], 2, [a.address], [1], 0)).to.be.revertedWith("Invalid approvals");
    await expect(Wallet.deploy([a.address, a.address], 1, [a.address], [1], 0)).to.be.revertedWith("Owner not unique");
    await expect(Wallet.deploy([a.address], 1, [a.address], [1, 2], 0)).to.be.revertedWith("Length mismatch");
  });

  it("necesita 2 aprobaciones y respeta el limite diario", async function () {
    const { wallet, a, b, c } = await loadFixture(walletFixture);
    await wallet.submitTransaction(c.address, ONE, DAY);
    await wallet.approveTransaction(0);
    await expect(wallet.executeTransaction(0)).to.be.revertedWith("Not enough approvals");
    await wallet.connect(b).approveTransaction(0);
    await expect(wallet.executeTransaction(0)).to.changeEtherBalance(c, ONE);

    await wallet.submitTransaction(c.address, 1, DAY);
    await wallet.approveTransaction(1);
    await wallet.connect(b).approveTransaction(1);
    await expect(wallet.executeTransaction(1)).to.be.revertedWith("Limite diario excedido");
    expect(await wallet.remainingToday()).to.equal(0);
  });

  it("revocar, cancelar y expirar", async function () {
    const { wallet, a, b, c } = await loadFixture(walletFixture);
    await wallet.submitTransaction(c.address, 1, DAY);
    await wallet.approveTransaction(0);
    await expect(wallet.approveTransaction(0)).to.be.revertedWith("Already approved");
    await wallet.revokeApproval(0);
    await expect(wallet.revokeApproval(0)).to.be.revertedWith("Not approved");
    await expect(wallet.connect(b).cancelTransaction(0)).to.be.revertedWith("Solo quien la propuso");
    await wallet.cancelTransaction(0);
    await expect(wallet.approveTransaction(0)).to.be.revertedWith("Transaccion cancelada");

    await wallet.submitTransaction(c.address, 1, 60);
    expect(await wallet.getPendingTransactions()).to.deep.equal([1n]);
    await time.increase(61);
    await expect(wallet.approveTransaction(1)).to.be.revertedWith("Transaccion expirada");
    expect(await wallet.getPendingTransactions()).to.deep.equal([]);
    expect(await wallet.getTransactionCount()).to.equal(2);
  });

  it("reparte el balance entre los payees", async function () {
    const { wallet, a, b, c } = await loadFixture(walletFixture);
    await expect(wallet.connect(c).releasePayments()).to.be.revertedWith("Not an owner");
    await expect(wallet.releasePayments()).to.changeEtherBalances(
      [a, b],
      [ethers.parseEther("1.6"), ethers.parseEther("0.4")]
    );
    await expect(wallet.releasePayments()).to.be.revertedWith("No funds to release");
  });

  it("consultas de owners, payees y aprobaciones", async function () {
    const { wallet, a, b, c } = await loadFixture(walletFixture);
    expect(await wallet.getOwners()).to.deep.equal([a.address, b.address]);
    expect(await wallet.getPayees()).to.deep.equal([a.address, b.address]);
    await wallet.submitTransaction(c.address, 1, DAY);
    await wallet.connect(b).approveTransaction(0);
    const [approvers] = await wallet.getApproversWithTimestamps(0);
    expect(approvers).to.deep.equal([b.address]);
    expect((await wallet.getTransactions()).length).to.equal(1);
    await expect(wallet.getApproversWithTimestamps(5)).to.be.revertedWith("Transaccion inexistente");
    await expect(wallet.submitTransaction(ethers.ZeroAddress, 1, DAY)).to.be.revertedWith("Invalid target");
    await expect(wallet.deposit()).to.be.revertedWith("Must send ether");
  });
});
