// Withdrawal delivery. Once the challenge window has passed, this claims every eligible withdrawal on the parent
// chain for its owner, so nobody has to come back to press Claim. The claim pays out to the withdrawal's own
// destination; this wallet only pays the gas. Users can still claim themselves at any time.
//
// Eligible: plain GME withdrawals (no calldata) of at least MIN_VALUE, and token withdrawals through our own
// gateways. Anything else is left for its owner. Gas per claim and claims per day are capped.
// Env: CLAIMER_PRIVATE_KEY (+ CLAIMER_ADDRESS), PARENT_RPC, L3_RPC, INTERVAL_SEC, MIN_VALUE, MAX_GAS, MAX_PER_DAY, MIN_ETH
import http from "node:http";
import { parseAbi, parseAbiItem, parseEther, formatEther, createPublicClient, http as viemHttp, defineChain, toHex, zeroHash, getFunctionSelector } from "viem";
import { NETWORK, S, parentPublicClient as parent, walletClient, account, loadDeployment } from "./lib.js";

if (!["mainnet", "testnet"].includes(NETWORK)) throw new Error("Run with --mainnet or --testnet.");
const dep = loadDeployment(), C = dep.coreContracts, TB = dep.tokenBridge || null;
const L3_RPC = process.env.L3_RPC || (NETWORK === "testnet" ? "https://rpc.testnet.gmechain.xyz" : "https://rpc.gmechain.xyz");
const CFG = {
  intervalSec: Number(process.env.INTERVAL_SEC || 300),
  minValue: parseEther(process.env.MIN_VALUE || (NETWORK === "mainnet" ? "0.01" : "0")),
  maxGas: BigInt(process.env.MAX_GAS || 400_000),
  maxPerDay: Number(process.env.MAX_PER_DAY || 50),
  minEth: Number(process.env.MIN_ETH || 0.0005),
};
const me = account("CLAIMER"), wallet = walletClient("CLAIMER");
const l3 = createPublicClient({ chain: defineChain({ id: S.chainId, name: S.chainName, nativeCurrency: { name: "GME", symbol: "GME", decimals: 18 }, rpcUrls: { default: { http: [L3_RPC] } } }), transport: viemHttp(L3_RPC) });
const ARBSYS = "0x0000000000000000000000000000000000000064", NODE_IF = "0x00000000000000000000000000000000000000C8";
const L2ToL1Tx = parseAbiItem("event L2ToL1Tx(address caller, address indexed destination, uint256 indexed hash, uint256 indexed position, uint256 arbBlockNum, uint256 ethBlockNum, uint256 timestamp, uint256 callvalue, bytes data)");
const oAbi = parseAbi(["function isSpent(uint256) view returns (bool)", "function roots(bytes32) view returns (bytes32)", "function executeTransaction(bytes32[],uint256,address,address,uint256,uint256,uint256,uint256,bytes)"]);
const proofAbi = parseAbi(["function constructOutboxProof(uint64,uint64) view returns (bytes32,bytes32,bytes32[])"]);
const FINALIZE = getFunctionSelector("finalizeInboundTransfer(address,address,address,uint256,bytes)");
const parentGw = new Set(TB ? [TB.parentChainContracts.standardGateway, TB.parentChainContracts.customGateway].map((a) => a.toLowerCase()) : []);
const childGw = new Set(TB ? [TB.orbitChainContracts.standardGateway, TB.orbitChainContracts.customGateway].map((a) => a.toLowerCase()) : []);

const log = (msg, extra = {}) => console.log(JSON.stringify({ t: new Date().toISOString(), msg, ...extra }));
const status = { ok: false, network: NETWORK, wallet: me.address, claimed: 0, skipped: 0, pending: 0, lastTick: null, lastClaim: null, lastError: null, eth: null };

function eligible(a) {
  const data = (a.data || "0x").toLowerCase();
  if (data === "0x") return a.callvalue >= CFG.minValue ? null : "below the minimum value";
  if (parentGw.has(a.destination.toLowerCase()) && childGw.has(a.caller.toLowerCase()) && data.startsWith(FINALIZE)) return null; // token withdrawal
  return "carries a contract call";
}

let nextBlock = 0n;
const queue = new Map(); // position -> withdrawal args, until claimed or skipped
const skipped = new Set();
let day = "", today = 0;

async function confirmedCount(blockNums) {
  for (const bn of [...blockNums].sort((a, b) => (a < b ? 1 : -1))) {
    const b = await l3.request({ method: "eth_getBlockByNumber", params: [toHex(bn), false] });
    if (!b?.sendRoot || b.sendRoot === zeroHash) continue;
    const root = await parent.readContract({ address: C.outbox, abi: oAbi, functionName: "roots", args: [b.sendRoot] });
    if (root && root !== zeroHash) return BigInt(b.sendCount);
  }
  return 0n;
}

async function tick() {
  const d = new Date().toISOString().slice(0, 10);
  if (d !== day) { day = d; today = 0; }
  const head = await l3.getBlockNumber();
  for (let from = nextBlock; from <= head; from += 50_000n) {
    const to = from + 49_999n > head ? head : from + 49_999n;
    for (const l of await l3.getLogs({ address: ARBSYS, event: L2ToL1Tx, fromBlock: from, toBlock: to })) {
      const a = { ...l.args, blockNumber: l.blockNumber };
      if (queue.has(a.position) || skipped.has(a.position)) continue;
      const why = eligible(a);
      if (why) { skipped.add(a.position); status.skipped++; log("left for its owner", { position: String(a.position), why }); continue; }
      queue.set(a.position, a);
    }
  }
  nextBlock = head + 1n;
  if (queue.size !== status.pending) log("waiting for the window", { pending: queue.size, positions: [...queue.keys()].map(String) });
  status.pending = queue.size;
  if (!queue.size) return;

  const eth = Number(formatEther(await parent.getBalance({ address: me.address })));
  status.eth = eth;
  if (eth < CFG.minEth) { log("WARNING claimer ETH low, claims paused", { eth }); return; }
  const size = await confirmedCount(new Set([...queue.values()].map((a) => a.blockNumber)));
  for (const [pos, a] of [...queue].sort((x, y) => (x[0] < y[0] ? -1 : 1))) {
    if (pos >= size) continue; // window not over yet
    if (await parent.readContract({ address: C.outbox, abi: oAbi, functionName: "isSpent", args: [pos] })) { queue.delete(pos); continue; } // the owner claimed it
    if (today >= CFG.maxPerDay) { log("daily cap reached", { cap: CFG.maxPerDay }); break; }
    const [, , proof] = await l3.readContract({ address: NODE_IF, abi: proofAbi, functionName: "constructOutboxProof", args: [size, pos] });
    const args = [proof, pos, a.caller, a.destination, a.arbBlockNum, a.ethBlockNum, a.timestamp, a.callvalue, a.data];
    const gas = await parent.estimateContractGas({ address: C.outbox, abi: oAbi, functionName: "executeTransaction", args, account: me.address });
    if (gas > CFG.maxGas) { queue.delete(pos); skipped.add(pos); status.skipped++; log("left for its owner", { position: String(pos), why: `needs ${gas} gas` }); continue; }
    const hash = await wallet.writeContract({ address: C.outbox, abi: oAbi, functionName: "executeTransaction", args, gas: (gas * 12n) / 10n });
    const r = await parent.waitForTransactionReceipt({ hash });
    queue.delete(pos); today++;
    if (r.status === "success") { status.claimed++; status.lastClaim = { at: new Date().toISOString(), position: String(pos), to: a.destination, value: formatEther(a.callvalue), tx: hash }; log("delivered", status.lastClaim); }
    else log("claim reverted", { position: String(pos), tx: hash });
  }
  status.pending = queue.size;
}

async function loop() {
  try { await tick(); status.ok = true; status.lastError = null; }
  catch (e) {
    // name the host that failed, never the full URL (RPC URLs can carry API keys)
    let host = null;
    try { const u = e.url || e.cause?.url; host = u ? new URL(u).host : null; } catch {}
    status.ok = false;
    status.lastError = { at: new Date().toISOString(), message: (e.shortMessage || e.message || String(e)).split("\n")[0], host };
    log("error", status.lastError);
  }
  finally { status.lastTick = new Date().toISOString(); setTimeout(loop, CFG.intervalSec * 1000); }
}

http.createServer((q, r) => { r.writeHead(status.ok ? 200 : 503, { "content-type": "application/json" }); r.end(JSON.stringify(status)); }).listen(8080);
log("claimer up", { network: NETWORK, wallet: me.address, minValue: formatEther(CFG.minValue), maxGas: String(CFG.maxGas), maxPerDay: CFG.maxPerDay });
loop();
