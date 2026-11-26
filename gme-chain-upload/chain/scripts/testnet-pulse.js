// Testnet only: keeps GME CHAIN Testnet visibly alive with small, real test transactions from one public "pulse"
// wallet, so the explorer always has fresh blocks to show. Every 1 to 4 minutes it does one of:
//   - send 0.01 to 2 tGME to a fresh address
//   - swap a little tGME for tUSD on the testnet exchange, or back
//   - wrap or unwrap a little tGME
// The wallet and what it does are disclosed in the docs. Test tokens have no value.
// Env: NETWORK=testnet, PULSE_PRIVATE_KEY, PULSE_ADDRESS, L3_RPC (default https://rpc.testnet.gmechain.xyz)
import http from "node:http";
import { parseEther, formatEther, parseAbi, createPublicClient, createWalletClient, http as viemHttp, defineChain } from "viem";
import { generatePrivateKey, privateKeyToAccount } from "viem/accounts";
import { NETWORK, S, account, loadDeployment } from "./lib.js";

if (NETWORK !== "testnet") throw new Error("The pulse runs on testnet only.");
const dex = loadDeployment().dex || {};
if (!dex.router || !dex.wrappedGme || !dex.testUsd) throw new Error("No testnet exchange in deployment.testnet.json (run 05-dex.js).");
const rpc = process.env.L3_RPC || "https://rpc.testnet.gmechain.xyz";
const chain = defineChain({ id: S.chainId, name: S.chainName, nativeCurrency: { name: "tGME", symbol: "tGME", decimals: 18 }, rpcUrls: { default: { http: [rpc] } } });
const me = account("PULSE");
const pub = createPublicClient({ chain, transport: viemHttp(rpc, { timeout: 20_000 }) });
const w = createWalletClient({ chain, account: me, transport: viemHttp(rpc, { timeout: 20_000 }) });

const router = parseAbi([
  "function swapExactETHForTokens(uint256 amountOutMin, address[] path, address to, uint256 deadline) payable returns (uint256[])",
  "function swapExactTokensForETH(uint256 amountIn, uint256 amountOutMin, address[] path, address to, uint256 deadline) returns (uint256[])",
]);
const erc20 = parseAbi(["function balanceOf(address) view returns (uint256)", "function approve(address,uint256) returns (bool)", "function allowance(address,address) view returns (uint256)"]);
const weth = parseAbi(["function deposit() payable", "function withdraw(uint256)"]);
const rnd = (lo, hi) => lo + Math.random() * (hi - lo);
const amt = (lo, hi) => parseEther(rnd(lo, hi).toFixed(4));
const deadline = () => BigInt(Math.floor(Date.now() / 1000) + 600);
const log = (o) => console.log(JSON.stringify({ t: new Date().toISOString(), ...o }));

const actions = {
  async transfer() {
    const to = privateKeyToAccount(generatePrivateKey()).address;
    return w.sendTransaction({ to, value: amt(0.01, 2) });
  },
  async buyUsd() {
    return w.writeContract({ address: dex.router, abi: router, functionName: "swapExactETHForTokens", args: [0n, [dex.wrappedGme, dex.testUsd], me.address, deadline()], value: amt(0.05, 1.5) });
  },
  async sellUsd() {
    const bal = await pub.readContract({ address: dex.testUsd, abi: erc20, functionName: "balanceOf", args: [me.address] });
    if (bal < parseEther("5")) return actions.buyUsd();
    const amountIn = bal / 4n;
    const allowed = await pub.readContract({ address: dex.testUsd, abi: erc20, functionName: "allowance", args: [me.address, dex.router] });
    if (allowed < amountIn) await pub.waitForTransactionReceipt({ hash: await w.writeContract({ address: dex.testUsd, abi: erc20, functionName: "approve", args: [dex.router, amountIn] }) });
    return w.writeContract({ address: dex.router, abi: router, functionName: "swapExactTokensForETH", args: [amountIn, 0n, [dex.testUsd, dex.wrappedGme], me.address, deadline()] });
  },
  async wrap() { return w.writeContract({ address: dex.wrappedGme, abi: weth, functionName: "deposit", value: amt(0.01, 0.5) }); },
  async unwrap() {
    const bal = await pub.readContract({ address: dex.wrappedGme, abi: erc20, functionName: "balanceOf", args: [me.address] });
    if (bal === 0n) return actions.wrap();
    return w.writeContract({ address: dex.wrappedGme, abi: weth, functionName: "withdraw", args: [bal] });
  },
};
const plan = ["transfer", "transfer", "transfer", "buyUsd", "sellUsd", "wrap", "unwrap"];

let last = { ok: null, at: null, action: null };
async function tick() {
  const name = plan[Math.floor(Math.random() * plan.length)];
  try {
    const bal = await pub.getBalance({ address: me.address });
    if (bal < parseEther("5")) { log({ msg: "pulse wallet low, skipping", balance: formatEther(bal) }); return; }
    const hash = await actions[name]();
    const r = await pub.waitForTransactionReceipt({ hash, timeout: 60_000 });
    last = { ok: r.status === "success", at: new Date().toISOString(), action: name };
    log({ action: name, status: r.status, block: Number(r.blockNumber), hash });
  } catch (e) {
    last = { ok: false, at: new Date().toISOString(), action: name };
    log({ action: name, error: String(e.shortMessage || e.message).slice(0, 200) });
  }
}
(async function loop() { await tick(); setTimeout(loop, rnd(60, 240) * 1000); })();

http.createServer((req, res) => {
  res.writeHead(200, { "content-type": "application/json" });
  res.end(JSON.stringify({ pulse: me.address, ...last }));
}).listen(Number(process.env.PORT || 8080), "::", () => log({ msg: "pulse up", wallet: me.address, rpc }));
