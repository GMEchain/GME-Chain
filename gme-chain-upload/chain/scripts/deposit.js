// Deposits the gas token from the DEPLOYER on the parent chain into GME CHAIN (approve + depositERC20),
// then waits until it is credited on the chain. Amount in whole tokens: DEPOSIT=10000 node scripts/deposit.js --testnet
import { parseEther, formatEther, parseAbi, createPublicClient, http, defineChain } from "viem";
import { NETWORK, S, parentPublicClient, walletClient, account, loadDeployment, confirmMainnet, erc20Abi } from "./lib.js";

const dep = loadDeployment();
const token = S.nativeToken || dep.nativeToken;
const inbox = dep.coreContracts?.inbox;
if (!token || !inbox) throw new Error("No gas token or inbox in the deployment file.");
const l3Rpc = process.env.L3_RPC || (NETWORK === "testnet" ? "https://rpc.testnet.gmechain.xyz" : "https://rpc.gmechain.xyz");
const l3 = createPublicClient({ chain: defineChain({ id: S.chainId, name: S.chainName, nativeCurrency: { name: "GME", symbol: "GME", decimals: 18 }, rpcUrls: { default: { http: [l3Rpc] } } }), transport: http(l3Rpc, { timeout: 20_000 }) });

const me = account("DEPLOYER");
const amount = parseEther(process.env.DEPOSIT || "1");
await confirmMainnet(`Deposit ${formatEther(amount)} gas token into GME CHAIN`);
const w = walletClient("DEPLOYER");
const before = await l3.getBalance({ address: me.address });
const allowance = await parentPublicClient.readContract({ address: token, abi: erc20Abi, functionName: "allowance", args: [me.address, inbox] });
if (allowance < amount) {
  const h = await w.writeContract({ address: token, abi: erc20Abi, functionName: "approve", args: [inbox, amount] });
  await parentPublicClient.waitForTransactionReceipt({ hash: h });
  console.log("approved", h);
}
const h = await w.writeContract({ address: inbox, abi: parseAbi(["function depositERC20(uint256) returns (uint256)"]), functionName: "depositERC20", args: [amount] });
await parentPublicClient.waitForTransactionReceipt({ hash: h });
console.log("deposit sent", h);
for (let i = 0; i < 120; i++) {
  await new Promise((r) => setTimeout(r, 5000));
  const now = await l3.getBalance({ address: me.address }).catch(() => before);
  if (now > before) { console.log(`credited on GME CHAIN: ${formatEther(now)} (after ${(i + 1) * 5}s)`); process.exit(0); }
}
console.log("not credited yet; it will arrive when the sequencer reads the deposit");
