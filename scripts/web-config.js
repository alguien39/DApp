/**
 * Genera web/contracts.js con las direcciones de deployments/*.json y los ABI de artifacts/.
 * Lo llama deploy.js; tambien se puede correr solo:  node scripts/web-config.js
 * contracts.js no lleva secretos (solo direcciones y ABI), por eso SI se sube a GitHub/Vercel.
 */
const fs = require("fs");
const path = require("path");

const ROOT = path.join(__dirname, "..");
const NOMBRES = ["Boletera", "TicketNFT", "MultiSignWallet"];

const REDES = {
  sepolia: { name: "Sepolia", chainId: 11155111, rpc: "https://ethereum-sepolia-rpc.publicnode.com", explorer: "https://sepolia.etherscan.io" },
  localhost: { name: "Hardhat Local", chainId: 31337, rpc: "http://127.0.0.1:8545", explorer: "" },
};

function abiDe(nombre) {
  const archivo = path.join(ROOT, "artifacts", "contracts", `${nombre}.sol`, `${nombre}.json`);
  return JSON.parse(fs.readFileSync(archivo, "utf8")).abi;
}

function generar() {
  const redes = {};
  for (const [red, info] of Object.entries(REDES)) {
    const archivo = path.join(ROOT, "deployments", `${red}.json`);
    if (!fs.existsSync(archivo)) continue;
    const dep = JSON.parse(fs.readFileSync(archivo, "utf8"));
    redes[red] = { ...info, deployBlock: dep.deployBlock, addresses: dep.addresses };
  }
  const abis = Object.fromEntries(NOMBRES.map((n) => [n, abiDe(n)]));
  const salida = path.join(ROOT, "web", "contracts.js");
  fs.writeFileSync(
    salida,
    "// Generado por scripts/web-config.js (direcciones + ABI, sin secretos). No editar a mano.\n" +
      `window.BOLETOTEC = ${JSON.stringify({ redes, abis })};\n`
  );
  console.log(`web/contracts.js generado con: ${Object.keys(redes).join(", ") || "(ninguna red)"}`);
}

if (require.main === module) generar();
module.exports = { generar };
