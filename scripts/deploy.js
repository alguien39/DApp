/**
 * Despliega BoletoTEC completo:
 *   1. MultiSignWallet (tesoreria) con tu cuenta como unico owner y 1 aprobacion
 *   2. TicketNFT
 *   3. Boletera (conectada al NFT y a la tesoreria)
 *   4. ticket.setMinter(boletera)
 * Guarda las direcciones en deployments/<red>.json y regenera web/contracts.js.
 *
 *   npx hardhat run scripts/deploy.js --network localhost
 *   npx hardhat run scripts/deploy.js --network sepolia
 */
const fs = require("fs");
const path = require("path");
const { ethers, network } = require("hardhat");
const { generar } = require("./web-config");

async function main() {
  const [deployer] = await ethers.getSigners();
  const fee = Number(process.env.RESALE_FEE_PCT || 5);
  const deployBlock = await ethers.provider.getBlockNumber();
  console.log(`Red: ${network.name}   Cuenta: ${deployer.address}`);
  console.log(`Saldo: ${ethers.formatEther(await ethers.provider.getBalance(deployer.address))} ETH\n`);

  const walletArgs = [[deployer.address], 1, [deployer.address], [100], 0];
  const treasury = await ethers.deployContract("MultiSignWallet", walletArgs);
  await treasury.waitForDeployment();
  console.log(`MultiSignWallet (tesoreria): ${treasury.target}`);

  const ticket = await ethers.deployContract("TicketNFT");
  await ticket.waitForDeployment();
  console.log(`TicketNFT:                   ${ticket.target}`);

  const boleteraArgs = [ticket.target, treasury.target, fee];
  const boletera = await ethers.deployContract("Boletera", boleteraArgs);
  await boletera.waitForDeployment();
  console.log(`Boletera:                    ${boletera.target}`);

  await (await ticket.setMinter(boletera.target)).wait();
  console.log("ticket.setMinter(boletera)   listo\n");

  const datos = {
    network: network.name,
    chainId: Number(network.config.chainId || 31337),
    deployer: deployer.address,
    deployBlock,
    addresses: { Boletera: boletera.target, TicketNFT: ticket.target, MultiSignWallet: treasury.target },
    args: { Boletera: boleteraArgs, TicketNFT: [], MultiSignWallet: walletArgs },
  };
  const dir = path.join(__dirname, "..", "deployments");
  fs.mkdirSync(dir, { recursive: true });
  fs.writeFileSync(path.join(dir, `${network.name}.json`), JSON.stringify(datos, null, 2));
  console.log(`deployments/${network.name}.json guardado`);
  generar();

  if (network.name === "sepolia") {
    console.log("\nSiguiente: npm run verify:sepolia   (y opcional: npm run seed:sepolia)");
  }
}

main().catch((e) => {
  console.error(e);
  process.exitCode = 1;
});
