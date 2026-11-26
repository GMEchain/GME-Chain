// Sends parent-chain ETH from the deployer to the batch poster and validator (amounts in ETH via env).
// Testnet: FUND_FAUCET (ETH) and FUND_FAUCET_TGME (tGME) also stock the "Get test kit" faucet.
import { parseEther, formatEther } from "viem";
import { NETWORK, parentPublicClient, walletClient, env, confirmMainnet, loadDeployment, erc20Abi } from "./lib.js";

const plan = [
  ["BATCH_POSTER", process.env.FUND_BATCH_POSTER || "0.002"],
  ["VALIDATOR", process.env.FUND_VALIDATOR || "0.003"],
  ...(NETWORK === "testnet" && process.env.FUND_FAUCET ? [["FAUCET", process.env.FUND_FAUCET]] : []),
];
await confirmMainnet(`Fund operators: ${plan.map(([r, a]) => `${r} ${a} ETH`).join(", ")}`);
const w = walletClient("DEPLOYER");
for (const [role, amt] of plan) {
  const to = env(`${role}_ADDRESS`);
  const have = await parentPublicClient.getBalance({ address: to });
  if (have >= parseEther(amt)) { console.log(`${role} already has ${formatEther(have)} ETH`); continue; }
  const hash = await w.sendTransaction({ to, value: parseEther(amt) - have });
  await parentPublicClient.waitForTransactionReceipt({ hash });
  console.log(`${role} ${to} topped up to ${amt} ETH (${hash})`);
}
if (NETWORK === "testnet" && process.env.FUND_FAUCET_TGME) {
  const tgme = loadDeployment().nativeToken, to = env("FAUCET_ADDRESS"), want = parseEther(process.env.FUND_FAUCET_TGME);
  const have = await parentPublicClient.readContract({ address: tgme, abi: erc20Abi, functionName: "balanceOf", args: [to] });
  if (have < want) {
    const hash = await w.writeContract({ address: tgme, abi: erc20Abi, functionName: "transfer", args: [to, want - have] });
    await parentPublicClient.waitForTransactionReceipt({ hash });
    console.log(`FAUCET ${to} topped up to ${formatEther(want)} tGME (${hash})`);
  } else console.log(`FAUCET already has ${formatEther(have)} tGME`);
}
console.log(`[${NETWORK}] done`);
