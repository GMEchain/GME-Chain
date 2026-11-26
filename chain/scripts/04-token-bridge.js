// Deploys the canonical token bridge (router + gateways) for GME CHAIN on the parent chain
// and on GME CHAIN itself (via retryable tickets paid in GME).
//
// Usage:
//   node scripts/04-token-bridge.js --fork      parent-side dry run on a local Anvil fork (no real funds)
//   node scripts/04-token-bridge.js --mainnet   real deployment (asks you to type "deploy mainnet")
import { parseEther, formatEther, createPublicClient, defineChain, http, parseAbi } from "viem";
import {
  createTokenBridge,
  createTokenBridgePrepareTransactionRequest,
  createTokenBridgeEnoughCustomFeeTokenAllowance,
  createTokenBridgePrepareCustomFeeTokenApprovalTransactionRequest,
} from "@arbitrum/chain-sdk";
import { NETWORK, S, erc20Abi, parentPublicClient, account, walletClient, loadDeployment, saveDeployment, confirmMainnet } from "./lib.js";

const L3_RPC = process.env.L3_RPC || "https://rpc.gmechain.xyz";
const dep = loadDeployment();
if (!dep.coreContracts) throw new Error(`No core contracts in ${S.deploymentFile}.`);
if (dep.tokenBridge) {
  console.log("Token bridge already deployed:", dep.tokenBridge);
  process.exit(0);
}

const gmeChain = defineChain({
  id: S.chainId,
  name: S.chainName,
  network: "gme-chain",
  nativeCurrency: { name: "GME", symbol: "GME", decimals: 18 },
  rpcUrls: { default: { http: [L3_RPC] }, public: { http: [L3_RPC] } },
});
const orbitChainPublicClient = createPublicClient({ chain: gmeChain, transport: http(L3_RPC, { timeout: 120_000 }) });

const deployer = account("DEPLOYER");
const rollup = dep.coreContracts.rollup;
const nativeToken = dep.nativeToken;

// ---------- pre-flight ----------
const [eth, gme, l3Block, l3ChainId, router] = await Promise.all([
  parentPublicClient.getBalance({ address: deployer.address }),
  parentPublicClient.readContract({ address: nativeToken, abi: erc20Abi, functionName: "balanceOf", args: [deployer.address] }),
  orbitChainPublicClient.getBlockNumber(),
  orbitChainPublicClient.getChainId(),
  parentPublicClient
    .readContract({
      address: "0x8B1EFf64E1eAd493A82C6798f5708183AF91A3AD",
      abi: parseAbi(["function inboxToL1Deployment(address) view returns (address router, address standardGateway, address customGateway, address wethGateway, address weth)"]),
      functionName: "inboxToL1Deployment",
      args: [dep.coreContracts.inbox],
    })
    .then((r) => r[0])
    .catch(() => "unknown"),
]);
console.log(`Network ${NETWORK} | deployer ${deployer.address}`);
console.log(`  parent: ${formatEther(eth)} ETH, ${formatEther(gme)} GME | GME CHAIN ${l3ChainId} at block ${l3Block}`);
console.log(`  existing L1 router for our inbox: ${router}`);
if (l3ChainId !== S.chainId) throw new Error(`L3 RPC reports chain ${l3ChainId}, expected ${S.chainId}`);
if (eth < parseEther("0.001")) throw new Error("Deployer needs at least 0.001 ETH.");
if (gme < parseEther("0.02")) throw new Error("Deployer needs at least 0.02 GME for the retryable fees.");

if (NETWORK === "fork") {
  // Parent-side dry run only: the real GME CHAIN node does not see fork transactions,
  // so we approve and estimate gas for createTokenBridge, then stop.
  const wallet = walletClient("DEPLOYER");
  const enough = await createTokenBridgeEnoughCustomFeeTokenAllowance({ nativeToken, owner: deployer.address, publicClient: parentPublicClient });
  if (!enough) {
    const req = await createTokenBridgePrepareCustomFeeTokenApprovalTransactionRequest({ nativeToken, owner: deployer.address, publicClient: parentPublicClient });
    const h = await wallet.sendTransaction({ ...req, account: deployer });
    await parentPublicClient.waitForTransactionReceipt({ hash: h });
    console.log("  [fork] approved fee token for TokenBridgeCreator");
  }
  const req = await createTokenBridgePrepareTransactionRequest({
    params: { rollup, rollupOwner: deployer.address },
    parentChainPublicClient: parentPublicClient,
    account: deployer.address,
  });
  console.log(`  [fork] createTokenBridge estimates OK: gas ${req.gas} -> ~${formatEther(req.gas * (req.maxFeePerGas ?? req.gasPrice ?? 0n))} ETH max`);
  const h = await wallet.sendTransaction({ ...req, account: deployer });
  const r = await parentPublicClient.waitForTransactionReceipt({ hash: h });
  const gmeAfter = await parentPublicClient.readContract({ address: nativeToken, abi: erc20Abi, functionName: "balanceOf", args: [deployer.address] });
  console.log(`  [fork] createTokenBridge tx ${r.status}, gas used ${r.gasUsed}, GME spent ${formatEther(gme - gmeAfter)}`);
  process.exit(r.status === "success" ? 0 : 1);
}

await confirmMainnet(`Create the token bridge for rollup ${rollup}`);

const result = await createTokenBridge({
  rollupOwner: deployer.address,
  rollupAddress: rollup,
  rollupDeploymentBlockNumber: BigInt(dep.createdAtBlock),
  account: deployer,
  nativeTokenAddress: nativeToken,
  parentChainPublicClient: parentPublicClient,
  orbitChainPublicClient,
});

console.log("Parent tx:", result.transactionReceipt.transactionHash);
console.log("Token bridge contracts:", result.tokenBridgeContracts);
saveDeployment({
  tokenBridge: result.tokenBridgeContracts,
  tokenBridgeTx: result.transactionReceipt.transactionHash,
});
console.log(`Saved to ${S.deploymentFile}`);
