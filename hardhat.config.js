require("@nomicfoundation/hardhat-toolbox");
require("dotenv").config();

const { PRIVATE_KEYS = "", NODO_URL = "", ETHERSCAN_API_KEY = "" } = process.env;

/** @type import('hardhat/config').HardhatUserConfig */
module.exports = {
  solidity: {
    version: "0.8.28",
    // OpenZeppelin 5 usa mcopy (Cancun)
    settings: { evmVersion: "cancun", optimizer: { enabled: true, runs: 200 } },
  },
  networks: {
    localhost: { url: "http://127.0.0.1:8545" },
    sepolia: {
      url: NODO_URL,
      accounts: PRIVATE_KEYS ? [PRIVATE_KEYS] : [],
      chainId: 11155111,
    },
  },
  etherscan: { apiKey: ETHERSCAN_API_KEY },
};
