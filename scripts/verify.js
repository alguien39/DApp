/**
 * Verifica los 3 contratos en Etherscan con los argumentos guardados en deployments/sepolia.json
 *   npm run verify:sepolia
 */
const { execFileSync } = require("child_process");
const fs = require("fs");
const path = require("path");

const dep = JSON.parse(fs.readFileSync(path.join(__dirname, "..", "deployments", "sepolia.json"), "utf8"));
const tmp = path.join(__dirname, "..", "cache", "verify-args");
fs.mkdirSync(tmp, { recursive: true });

for (const [nombre, address] of Object.entries(dep.addresses)) {
  const argsFile = path.join(tmp, `${nombre}.js`);
  fs.writeFileSync(argsFile, `module.exports = ${JSON.stringify(dep.args[nombre])};\n`);
  console.log(`\n== ${nombre} ${address}`);
  try {
    execFileSync("npx", ["hardhat", "verify", "--network", "sepolia", "--constructor-args", argsFile, address], { stdio: "inherit" });
  } catch {
    console.log(`(si dice "Already Verified" no hay problema)`);
  }
}
