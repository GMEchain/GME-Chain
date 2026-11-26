// Claims the DEPLOYER's withdrawals on the parent chain once a confirmed send root covers them.
// Same logic as the bridge page: claimable when outbox.roots(sendRoot) is set for a root that includes the withdrawal.
// Exit 0 = claimed (or nothing to claim), exit 2 = not claimable yet.
import { parseAbi, parseAbiItem, formatEther, createPublicClient, http, defineChain, toHex, zeroHash } from "viem";
import { NETWORK, S, parentPublicClient, walletClient, account, loadDeployment, erc20Abi } from "./lib.js";

const dep = loadDeployment(), me = account("DEPLOYER");
const L3_RPC = process.env.L3_RPC || (NETWORK === "testnet" ? "https://rpc.testnet.gmechain.xyz" : "https://rpc.gmechain.xyz");
const l3 = createPublicClient({ chain: defineChain({ id: S.chainId, name: S.chainName, nativeCurrency: { name: "GME", symbol: "GME", decimals: 18 }, rpcUrls: { default: { http: [L3_RPC] } } }), transport: http(L3_RPC) });
const ARBSYS = "0x0000000000000000000000000000000000000064", NODE_IF = "0x00000000000000000000000000000000000000C8";
const outbox = dep.coreContracts.outbox;
const L2ToL1Tx = parseAbiItem("event L2ToL1Tx(address caller, address indexed destination, uint256 indexed hash, uint256 indexed position, uint256 arbBlockNum, uint256 ethBlockNum, uint256 timestamp, uint256 callvalue, bytes data)");
const oAbi = parseAbi(["function isSpent(uint256) view returns (bool)", "function roots(bytes32) view returns (bytes32)", "function executeTransaction(bytes32[],uint256,address,address,uint256,uint256,uint256,uint256,bytes)"]);

const all = await l3.getLogs({ address: ARBSYS, event: L2ToL1Tx, fromBlock: 0n, toBlock: "latest" });
let size = 0n;
for (const bn of [...new Set(all.map((l) => l.blockNumber))].sort((a, b) => (a < b ? 1 : -1))) {
  const b = await l3.request({ method: "eth_getBlockByNumber", params: [toHex(bn), false] });
  if (!b?.sendRoot || b.sendRoot === zeroHash) continue;
  const root = await parentPublicClient.readContract({ address: outbox, abi: oAbi, functionName: "roots", args: [b.sendRoot] });
  if (root && root !== zeroHash) { size = BigInt(b.sendCount); break; }
}
const mine = all.filter((l) => l.args.destination.toLowerCase() === me.address.toLowerCase());
console.log(`withdrawals to deployer: ${mine.length}, confirmed send count: ${size}`);
let pending = 0;
for (const l of mine) {
  const a = l.args;
  if (await parentPublicClient.readContract({ address: outbox, abi: oAbi, functionName: "isSpent", args: [a.position] })) { console.log(`  #${a.position} already claimed`); continue; }
  if (a.position >= size) { console.log(`  #${a.position} ${formatEther(a.callvalue)} not claimable yet`); pending++; continue; }
  const [, , proof] = await l3.readContract({ address: NODE_IF, abi: parseAbi(["function constructOutboxProof(uint64,uint64) view returns (bytes32,bytes32,bytes32[])"]), functionName: "constructOutboxProof", args: [size, a.position] });
  const before = await parentPublicClient.readContract({ address: dep.nativeToken, abi: erc20Abi, functionName: "balanceOf", args: [me.address] });
  const h = await walletClient("DEPLOYER").writeContract({ address: outbox, abi: oAbi, functionName: "executeTransaction", args: [proof, a.position, a.caller, a.destination, a.arbBlockNum, a.ethBlockNum, a.timestamp, a.callvalue, a.data] });
  const r = await parentPublicClient.waitForTransactionReceipt({ hash: h });
  const after = await parentPublicClient.readContract({ address: dep.nativeToken, abi: erc20Abi, functionName: "balanceOf", args: [me.address] });
  console.log(`  #${a.position} CLAIMED ${formatEther(a.callvalue)} (status ${r.status}, received ${formatEther(after - before)}) tx ${h}`);
}
process.exit(pending ? 2 : 0);
