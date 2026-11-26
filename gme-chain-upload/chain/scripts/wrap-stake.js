// Wraps ETH into the rollup's stake token (WETH) for the validator, so BoLD can post its first assertion.
// Only wraps the shortfall up to baseStake; does nothing when the validator already holds enough.
import { formatEther } from "viem";
import { NETWORK, parentPublicClient as p, walletClient, account, loadDeployment, erc20Abi } from "./lib.js";

const dep = loadDeployment();
if (!dep.stakeToken || !dep.baseStake) throw new Error("No stakeToken/baseStake in the deployment file. Run 02-create-rollup.js first.");
const weth = dep.stakeToken, need = BigInt(dep.baseStake);
const me = account("VALIDATOR"), w = walletClient("VALIDATOR");
const have = await p.readContract({ address: weth, abi: erc20Abi, functionName: "balanceOf", args: [me.address] });
if (have >= need) { console.log(`[${NETWORK}] validator already holds ${formatEther(have)} WETH`); process.exit(0); }
const hash = await w.writeContract({ address: weth, abi: [{ type: "function", name: "deposit", stateMutability: "payable", inputs: [], outputs: [] }], functionName: "deposit", value: need - have });
await p.waitForTransactionReceipt({ hash });
console.log(`[${NETWORK}] wrapped ${formatEther(need - have)} ETH into WETH for the validator ${me.address} (${hash})`);
