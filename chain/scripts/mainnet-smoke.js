// Mainnet smoke test: what a user does on day one, with small real amounts, using the same calls as the website.
//   node scripts/mainnet-smoke.js --mainnet --dry    rehearse on forks of Robinhood Chain and GME CHAIN (default)
//   node scripts/mainnet-smoke.js --mainnet --send   run it for real from the deployer, after one confirmation
// Steps:
//   1. bridge 0.001 ETH -> GME gas through GmeGasRouter (best Uniswap v3 route, 1% price limit) and wait for it
//   2. swap 0.01 GME -> USDG on the GME CHAIN exchange
//   3. send a plain 0.001 GME transfer
//   4. start a 0.01 GME withdrawal back to Robinhood Chain (claimable and delivered after the challenge window)
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { spawn } from "node:child_process";
import { createPublicClient, createWalletClient, defineChain, http, parseAbi, parseEther, formatEther, formatUnits, concat, pad, toHex, getAddress } from "viem";
import { ROOT, NETWORK, S, GME_TOKEN, parentChain, parentPublicClient, walletClient, account, loadDeployment, confirmMainnet } from "./lib.js";

if (NETWORK !== "mainnet") throw new Error("Run with --mainnet (add --dry or --send).");
const SEND = process.argv.includes("--send");
const dep = loadDeployment(), DEX = dep.dex;
if (!dep.gasRouter || !DEX?.usdg) throw new Error("Needs the gas router and the GME/USDG pool in deployment.mainnet.json.");
const L3_RPC = process.env.L3_RPC || "https://rpc.gmechain.xyz";
const AMT = { bridgeEth: parseEther("0.001"), swapGme: parseEther("0.01"), sendGme: parseEther("0.001"), withdrawGme: parseEther("0.01") };
const UNI = { quoter: "0x33e885ed0ec9bf04ecfb19341582aadcb4c8a9e7", weth: getAddress(dep.stakeToken), usdg: getAddress("0x5fc5360D0400a0Fd4f2af552ADD042D716F1d168") };
const ROUTES = [{ name: "WETH/GME 0.05%", tokens: [UNI.weth, GME_TOKEN], fees: [500] }, { name: "WETH/USDG 0.05% -> GME/USDG 1%", tokens: [UNI.weth, UNI.usdg, GME_TOKEN], fees: [500, 10000] }];
const DEPOSIT_GAS = 300000n, SLIPPAGE_BPS = 100n; // same as site/js/bridge.js
const abi = {
  quoter: parseAbi(["function quoteExactInput(bytes path, uint256 amountIn) view returns (uint256 amountOut, uint160[], uint32[], uint256)"]),
  router: parseAbi(["function depositEth(bytes path, uint256 minGmeOut, address to, uint256 gasLimit, uint256 maxFeePerGas) payable returns (uint256)"]),
  dex: parseAbi(["function getAmountsOut(uint256,address[]) view returns (uint256[])", "function swapExactETHForTokens(uint256,address[],address,uint256) payable returns (uint256[])"]),
  erc20: parseAbi(["function balanceOf(address) view returns (uint256)"]),
  arbsys: parseAbi(["function withdrawEth(address destination) payable returns (uint256)"]),
};
const gmeChain = (rpc) => defineChain({ id: 12821, name: "GME CHAIN", network: "gme-chain", nativeCurrency: { name: "GME", symbol: "GME", decimals: 18 }, rpcUrls: { default: { http: [rpc] }, public: { http: [rpc] } } });
const pathOf = (r) => concat(r.tokens.flatMap((t, i) => (i < r.fees.length ? [t, pad(toHex(r.fees[i]), { size: 3 })] : [t])));
const minOut = (x) => (x * (10000n - SLIPPAGE_BPS)) / 10000n;

async function run({ l2, w2, l3, w3, me, deliver, simulateWithdraw }) {
  const results = [];
  const step = (name, detail) => { results.push(name); console.log(`  PASS  ${name}${detail ? `  (${detail})` : ""}`); };

  // 1. bridge ETH -> GME gas
  let best = null;
  for (const r of ROUTES) {
    const q = await l2.readContract({ address: UNI.quoter, abi: abi.quoter, functionName: "quoteExactInput", args: [pathOf(r), AMT.bridgeEth] }).catch(() => null);
    if (q && (!best || q[0] > best.out)) best = { ...r, out: q[0] };
  }
  if (!best) throw new Error("no Uniswap route from ETH to GME");
  const fee = (await l3.getGasPrice()) * 2n;
  const floor = minOut(best.out);
  if (floor <= DEPOSIT_GAS * fee) throw new Error("bridge amount too small for the ticket fee");
  const before = await l3.getBalance({ address: me });
  const h1 = await w2.writeContract({ address: dep.gasRouter, abi: abi.router, functionName: "depositEth", args: [pathOf(best), floor, me, DEPOSIT_GAS, fee], value: AMT.bridgeEth });
  const r1 = await l2.waitForTransactionReceipt({ hash: h1 });
  if (r1.status !== "success") throw new Error(`bridge transaction reverted: ${h1}`);
  step("bridge sent on Robinhood Chain", `${formatEther(AMT.bridgeEth)} ETH -> ~${Number(formatEther(best.out)).toFixed(4)} GME via ${best.name}, tx ${h1}`);
  await deliver(best.out - DEPOSIT_GAS * fee);
  let arrived = 0n;
  for (let i = 0; i < 60 && arrived === 0n; i++) {
    const now = await l3.getBalance({ address: me });
    if (now > before) arrived = now - before; else await new Promise((r) => setTimeout(r, 10000));
  }
  if (!arrived) throw new Error("the bridged GME did not arrive on GME CHAIN within 10 minutes");
  step("GME arrived on GME CHAIN as gas", `+${Number(formatEther(arrived)).toFixed(6)} GME`);

  // 2. swap GME -> USDG
  const pathDex = [DEX.wrappedGme, DEX.usdg];
  const [, quoted] = await l3.readContract({ address: DEX.router, abi: abi.dex, functionName: "getAmountsOut", args: [AMT.swapGme, pathDex] });
  const u0 = await l3.readContract({ address: DEX.usdg, abi: abi.erc20, functionName: "balanceOf", args: [me] });
  const h2 = await w3.writeContract({ address: DEX.router, abi: abi.dex, functionName: "swapExactETHForTokens", args: [minOut(quoted), pathDex, me, BigInt(Math.floor(Date.now() / 1000) + 600)], value: AMT.swapGme });
  if ((await l3.waitForTransactionReceipt({ hash: h2 })).status !== "success") throw new Error(`swap reverted: ${h2}`);
  const got = (await l3.readContract({ address: DEX.usdg, abi: abi.erc20, functionName: "balanceOf", args: [me] })) - u0;
  step("swap on the exchange", `${formatEther(AMT.swapGme)} GME -> ${formatUnits(got, 6)} USDG, tx ${h2}`);

  // 3. plain transfer
  const h3 = await w3.sendTransaction({ to: me, value: AMT.sendGme });
  const r3 = await l3.waitForTransactionReceipt({ hash: h3 });
  if (r3.status !== "success") throw new Error(`transfer failed: ${h3}`);
  step("GME transfer", `gas paid ${formatEther(r3.gasUsed * r3.effectiveGasPrice)} GME, tx ${h3}`);

  // 4. start a withdrawal
  if (simulateWithdraw) { step("withdrawal start simulated against the real ArbSys on GME CHAIN", await simulateWithdraw()); return results.length; }
  const h4 = await w3.writeContract({ address: "0x0000000000000000000000000000000000000064", abi: abi.arbsys, functionName: "withdrawEth", args: [me], value: AMT.withdrawGme });
  if ((await l3.waitForTransactionReceipt({ hash: h4 })).status !== "success") throw new Error(`withdrawal failed: ${h4}`);
  step("withdrawal started", `${formatEther(AMT.withdrawGme)} GME back to Robinhood Chain, delivered after the window, tx ${h4}`);
  return results.length;
}

if (SEND) {
  const acct = account("DEPLOYER");
  await confirmMainnet("Smoke test: bridge 0.001 ETH, swap 0.01 GME, send 0.001 GME, withdraw 0.01 GME");
  const l3 = createPublicClient({ chain: gmeChain(L3_RPC), transport: http(L3_RPC) });
  const n = await run({ l2: parentPublicClient, w2: walletClient("DEPLOYER"), l3, w3: createWalletClient({ chain: gmeChain(L3_RPC), transport: http(L3_RPC), account: acct }), me: acct.address, deliver: async () => {} });
  console.log(`\nMAINNET SMOKE TEST PASSED (${n} steps). The withdrawal is delivered after the challenge window.`);
} else {
  const ANVIL = process.env.ANVIL_BIN || path.join(os.homedir(), ".foundry", "bin", process.platform === "win32" ? "anvil.exe" : "anvil");
  const forks = [];
  const fork = async (url, port, id) => {
    const p = spawn(ANVIL, ["--fork-url", url, "--port", String(port), "--chain-id", String(id), "--silent", "--no-rate-limit"], { stdio: "ignore" }); forks.push(p);
    const rpc = `http://127.0.0.1:${port}`;
    for (let i = 0; i < 120; i++) { try { await fetch(rpc, { method: "POST", headers: { "content-type": "application/json" }, body: '{"jsonrpc":"2.0","id":1,"method":"eth_chainId","params":[]}' }); return rpc; } catch { await new Promise((r) => setTimeout(r, 500)); } }
    throw new Error(`fork of ${url} did not start`);
  };
  const call = (rpc, method, params) => fetch(rpc, { method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify({ jsonrpc: "2.0", id: 1, method, params }) }).then((r) => r.json()).then((j) => { if (j.error) throw new Error(j.error.message); return j.result; });
  try {
    const me = getAddress(process.env.DEPLOYER_ADDRESS);
    const rpc2 = await fork(S.rpc, 8555, 4663), rpc3 = await fork(L3_RPC, 8556, 12821);
    // Arbitrum precompiles are not in anvil: the same mocks the end-to-end tests use
    const art = (f, c) => JSON.parse(fs.readFileSync(path.join(ROOT, "out", f, `${c}.json`), "utf8")).deployedBytecode.object;
    for (const rpc of [rpc2, rpc3]) {
      await call(rpc, "anvil_setCode", ["0x0000000000000000000000000000000000000064", art("ArbSysMock.sol", "ArbSysMock")]);
      await call(rpc, "anvil_setCode", ["0x000000000000000000000000000000000000006C", art("ArbGasInfoMock.sol", "ArbGasInfoMock")]);
      await call(rpc, "anvil_impersonateAccount", [me]);
    }
    const l2 = createPublicClient({ chain: parentChain, transport: http(rpc2) }), l3 = createPublicClient({ chain: gmeChain(rpc3), transport: http(rpc3) });
    console.log("Rehearsal with the deployer's real balances on forks of Robinhood Chain and GME CHAIN:");
    const deliver = async (amount) => { const b = await l3.getBalance({ address: me }); await call(rpc3, "anvil_setBalance", [me, toHex(b + amount)]); }; // the sequencer's part
    // anvil has no ArbSys, so the withdrawal call is checked read-only against the live chain's real precompile
    const real3 = createPublicClient({ chain: gmeChain(L3_RPC), transport: http(L3_RPC) });
    const simulateWithdraw = async () => {
      const args = { address: "0x0000000000000000000000000000000000000064", abi: abi.arbsys, functionName: "withdrawEth", args: [me], value: AMT.withdrawGme, account: me };
      const { result } = await real3.simulateContract(args);
      const gas = await real3.estimateContractGas(args);
      return `eth_call returns withdrawal id ${result}, estimated gas ${gas}; nothing sent`;
    };
    const n = await run({ l2, w2: createWalletClient({ chain: parentChain, transport: http(rpc2), account: me }), l3, w3: createWalletClient({ chain: gmeChain(rpc3), transport: http(rpc3), account: me }), me, deliver, simulateWithdraw });
    console.log(`\nREHEARSAL PASSED (${n} steps). Run it for real with: node scripts/mainnet-smoke.js --mainnet --send`);
  } finally { forks.forEach((p) => p.kill()); }
}
