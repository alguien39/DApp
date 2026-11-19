/**
 * Crea eventos de ejemplo para la demo en clase.
 *   - "Hackathon TEC" empieza en 3 horas: ya se puede comprar Y hacer check-in (puertas abren 6 h antes)
 *   - "Concierto de bienvenida" en 7 dias: para comprar y revender
 *   - "Obra de teatro" en 10 dias: para cancelarla y probar reembolsos
 *
 *   npx hardhat run scripts/seed.js --network localhost | sepolia
 */
const fs = require("fs");
const path = require("path");
const { ethers, network } = require("hardhat");

const HORA = 3600;
const DIA = 24 * HORA;

async function main() {
  const dep = JSON.parse(fs.readFileSync(path.join(__dirname, "..", "deployments", `${network.name}.json`), "utf8"));
  const boletera = await ethers.getContractAt("Boletera", dep.addresses.Boletera);
  const ahora = (await ethers.provider.getBlock("latest")).timestamp;
  const precio = ethers.parseEther("0.001");

  const eventos = [
    ["Hackathon TEC", ahora + 3 * HORA, precio, 30, 100],
    ["Concierto de bienvenida", ahora + 7 * DIA, precio, 50, 150],
    ["Obra de teatro", ahora + 10 * DIA, precio * 2n, 20, 120],
  ];
  for (const [nombre, fecha, p, cupo, tope] of eventos) {
    await (await boletera.createEvent(nombre, fecha, p, cupo, tope, "")).wait();
    console.log(`✔ ${nombre}  (${new Date(fecha * 1000).toLocaleString("es-MX")})`);
  }
  console.log(`\nEventos en la boletera: ${await boletera.eventCount()}`);
}

main().catch((e) => {
  console.error(e);
  process.exitCode = 1;
});
