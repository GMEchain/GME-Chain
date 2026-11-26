// Deploys GmeGasRouter on Robinhood Chain (mainnet or fork): the "bridge with ETH" contract.
//   ETH on Robinhood Chain -> Uniswap v3 swap to GME -> retryable ticket -> GME gas on GME CHAIN (one transaction)
//   GME claimed from a withdrawal -> Uniswap v3 swap -> ETH on Robinhood Chain
// Needs the rollup first (02-create-rollup.js): the router is bound to GME CHAIN's inbox for good.
//   node scripts/06-gas-router.js --mainnet
import { readFileSync } from "node:fs";
import path from "node:path";
import { NETWORK, ROOT, GME_TOKEN, parentPublicClient, walletClient, account, loadDeployment, saveDeployment, confirmMainnet } from "./lib.js";

// Uniswap v3 on Robinhood Chain (developers.uniswap.org, v3 Robinhood Chain deployments; checked on-chain:
// SwapRouter02.factory() is the factory of the GME pools, SwapRouter02.WETH9() is this WETH).
export const UNISWAP = {
  swapRouter02: "0xcaf681a66d020601342297493863e78c959e5cb2",
  quoterV2: "0x33e885ed0ec9bf04ecfb19341582aadcb4c8a9e7",
  factory: "0x1f7d7550b1b028f7571e69a784071f0205fd2efa",
  weth: "0x0Bd7D308f8E1639FAb988df18A8011f41EAcAD73",
};

if (NETWORK === "testnet") { console.log("The ETH bridge uses real Uniswap pools: mainnet (or fork) only."); process.exit(0); }
const dep = loadDeployment();
if (dep.gasRouter) { console.log(`GmeGasRouter already at ${dep.gasRouter}`); process.exit(0); }
const inbox = dep.coreContracts?.inbox;
if (!inbox) throw new Error("No GME CHAIN inbox yet: run 02-create-rollup.js first.");

const art = JSON.parse(readFileSync(path.join(ROOT, "out", "GmeGasRouter.sol", "GmeGasRouter.json"), "utf8"));
const deployer = account("DEPLOYER");
await confirmMainnet(`Deploy GmeGasRouter (router ${UNISWAP.swapRouter02}, inbox ${inbox})`);
console.log(`Deploying GmeGasRouter from ${deployer.address} ...`);
const hash = await walletClient("DEPLOYER").deployContract({ abi: art.abi, bytecode: art.bytecode.object, args: [UNISWAP.swapRouter02, UNISWAP.weth, GME_TOKEN, inbox] });
const r = await parentPublicClient.waitForTransactionReceipt({ hash });
if (r.status !== "success") throw new Error(`GmeGasRouter deploy failed: ${hash}`);
console.log(`GmeGasRouter: ${r.contractAddress}`);
saveDeployment({ gasRouter: r.contractAddress, gasRouterTx: hash });
