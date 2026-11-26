// Deploys the TestGME (tGME) gas token on Robinhood Chain Testnet.
import { readFileSync } from "node:fs";
import path from "node:path";
import { parseEther } from "viem";
import { NETWORK, ROOT, parentPublicClient, walletClient, account, loadDeployment, saveDeployment } from "./lib.js";

if (NETWORK !== "testnet") {
  console.log("tGME is testnet-only. Mainnet uses the real GME Stock Token.");
  process.exit(0);
}

const existing = loadDeployment().nativeToken;
if (existing) {
  console.log(`tGME already deployed at ${existing}. Delete it from deployment.json to redeploy.`);
  process.exit(0);
}

const artifact = JSON.parse(readFileSync(path.join(ROOT, "out", "TestGME.sol", "TestGME.json"), "utf8"));
const deployer = account("DEPLOYER");
const wallet = walletClient("DEPLOYER");

console.log(`Deploying tGME from ${deployer.address} ...`);
const hash = await wallet.deployContract({
  abi: artifact.abi,
  bytecode: artifact.bytecode.object,
  args: [deployer.address],
});
const receipt = await parentPublicClient.waitForTransactionReceipt({ hash });
if (receipt.status !== "success") throw new Error(`Deploy failed: ${hash}`);
const tgme = receipt.contractAddress;
console.log(`tGME deployed: ${tgme} (tx ${hash})`);

// Seed the deployer: rollup creation and token bridge creation pay retryable
// fees on the new chain in the native token.
const mintHash = await wallet.writeContract({
  address: tgme,
  abi: artifact.abi,
  functionName: "mint",
  args: [deployer.address, parseEther("1000000")],
});
await parentPublicClient.waitForTransactionReceipt({ hash: mintHash });
console.log("Minted 1,000,000 tGME to deployer.");

saveDeployment({ nativeToken: tgme, nativeTokenTx: hash });
