// Testnet only: deploys a mock ETH/USD feed for the fee pricer (Robinhood Chain Testnet has no feed we rely on).
import { readFileSync } from "node:fs";
import path from "node:path";
import { NETWORK, ROOT, parentPublicClient, walletClient, account, loadDeployment, saveDeployment } from "./lib.js";

if (NETWORK !== "testnet") { console.log("The mock feed is testnet-only."); process.exit(0); }
const dep = loadDeployment();
if (dep.ethUsdFeed) { console.log(`Mock ETH/USD feed already at ${dep.ethUsdFeed}`); process.exit(0); }

const art = JSON.parse(readFileSync(path.join(ROOT, "out", "MockEthUsdFeed.sol", "MockEthUsdFeed.json"), "utf8"));
const deployer = account("DEPLOYER");
const usd = process.env.TESTNET_ETH_USD || "3000";
console.log(`Deploying MockEthUsdFeed ($${usd}) from ${deployer.address} ...`);
const hash = await walletClient("DEPLOYER").deployContract({ abi: art.abi, bytecode: art.bytecode.object, args: [BigInt(Math.round(Number(usd) * 1e8))] });
const r = await parentPublicClient.waitForTransactionReceipt({ hash });
if (r.status !== "success") throw new Error(`Mock feed deploy failed: ${hash}`);
console.log(`Mock feed: ${r.contractAddress}`);
saveDeployment({ ethUsdFeed: r.contractAddress, ethUsdFeedTx: hash });
