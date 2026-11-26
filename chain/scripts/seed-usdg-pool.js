// The first exchange pool on GME CHAIN mainnet: GME / USDG (Global Dollar, Robinhood Chain's native stablecoin).
// USDG crosses through the canonical token bridge; GME is the chain's gas. The pool is seeded at the price of the
// deepest GME market, the Uniswap v3 GME/USDG pool on Robinhood Chain, and refuses to run when prices disagree.
//
//   node scripts/seed-usdg-pool.js --mainnet --dry      full rehearsal on two local forks, no real funds (default)
//   node scripts/seed-usdg-pool.js --mainnet --bridge   bridge USDG and GME from Robinhood Chain to GME CHAIN
//   node scripts/seed-usdg-pool.js --mainnet --seed     create and seed the pool on GME CHAIN
// SEED_GME sets the GME side (default 40); the USDG side follows from the market price.
import os from "node:os";
import path from "node:path";
import { spawn } from "node:child_process";
import { createPublicClient, createWalletClient, defineChain, http, parseAbi, parseEther, formatEther, formatUnits, getAddress, zeroAddress } from "viem";
import sdk from "@arbitrum/sdk";
import { ethers } from "ethers";
import { NETWORK, S, GME_TOKEN, account, loadDeployment, saveDeployment, confirmMainnet, parentPublicClient } from "./lib.js";

const { Erc20Bridger, EthBridger, registerCustomArbitrumNetwork } = sdk;
if (NETWORK !== "mainnet") throw new Error("Run with --mainnet (add --dry, --bridge or --seed).");
const MODE = process.argv.includes("--seed") ? "seed" : process.argv.includes("--bridge") ? "bridge" : "dry";
const USDG = getAddress("0x5fc5360D0400a0Fd4f2af552ADD042D716F1d168"); // Global Dollar on Robinhood Chain, 6 decimals
const MARKET = getAddress("0xe9713f453adb9245b19559790c96f470a18f2fdf"); // Uniswap v3 GME/USDG 1%: token0 GME, token1 USDG
const SEED_GME = parseEther(process.env.SEED_GME || "40");
const MAX_DRIFT_BPS = 50n; // the pool may sit at most 0.5% from the market price
const L3_RPC = process.env.L3_RPC || "https://rpc.gmechain.xyz";
const ANVIL = process.env.ANVIL_BIN || path.join(os.homedir(), ".foundry", "bin", process.platform === "win32" ? "anvil.exe" : "anvil");
const dep = loadDeployment();
const C = dep.coreContracts, TB = dep.tokenBridge, DEX = dep.dex;
if (!C || !TB || !DEX) throw new Error("deployment.mainnet.json needs core contracts, the token bridge and the exchange.");

const abi = {
  erc20: parseAbi(["function balanceOf(address) view returns (uint256)", "function approve(address,uint256) returns (bool)", "function transfer(address,uint256) returns (bool)", "function decimals() view returns (uint8)", "function symbol() view returns (string)"]),
  v3: parseAbi(["function slot0() view returns (uint160,int24,uint16,uint16,uint16,uint8,bool)"]),
  pricer: parseAbi(["function gmeUsd() view returns (uint256)"]),
  gw: parseAbi(["function getOutboundCalldata(address,address,address,uint256,bytes) view returns (bytes)"]),
  childRouter: parseAbi(["function calculateL2TokenAddress(address) view returns (address)"]),
  factory: parseAbi(["function getPair(address,address) view returns (address)", "function createPair(address,address) returns (address)"]),
  pair: parseAbi(["function getReserves() view returns (uint112,uint112,uint32)", "function token0() view returns (address)", "function mint(address) returns (uint256)", "function balanceOf(address) view returns (uint256)", "function totalSupply() view returns (uint256)"]),
  router: parseAbi([
    "function addLiquidityETH(address,uint256,uint256,uint256,address,uint256) payable returns (uint256,uint256,uint256)",
    "function swapExactETHForTokens(uint256,address[],address,uint256) payable returns (uint256[])",
    "function getAmountsOut(uint256,address[]) view returns (uint256[])",
  ]),
  wgme: parseAbi(["function deposit() payable", "function transfer(address,uint256) returns (bool)"]),
};

// ---------- market price ----------
// USDG units (6 dp) for an amount of GME (18 dp), from the v3 pool's spot price: amount * sqrtP^2 / 2^192.
async function market() {
  const [sqrtP] = await parentPublicClient.readContract({ address: MARKET, abi: abi.v3, functionName: "slot0" });
  const usdgFor = (gme) => (gme * sqrtP * sqrtP) >> 192n;
  const spot = Number(usdgFor(10n ** 18n)) / 1e6;
  const twap = Number(await parentPublicClient.readContract({ address: dep.feeTokenPricer, abi: abi.pricer, functionName: "gmeUsd" })) / 1e18;
  const gap = Math.abs(spot / twap - 1);
  console.log(`GME market: spot $${spot.toFixed(4)} (Uniswap v3 GME/USDG), keeper TWAP $${twap.toFixed(4)}, gap ${(gap * 100).toFixed(2)}%`);
  if (gap > 0.02) throw new Error("Spot and TWAP disagree by more than 2%: the market may be moving or manipulated. Nothing was sent; try again later.");
  return { usdgFor, spot };
}

// ---------- token bridge (Arbitrum SDK, ethers v5) ----------
function network() {
  const P = TB.parentChainContracts, O = TB.orbitChainContracts;
  return registerCustomArbitrumNetwork({
    name: "GME CHAIN", chainId: 12821, parentChainId: 4663, confirmPeriodBlocks: Number(dep.confirmPeriodBlocks),
    ethBridge: { bridge: C.bridge, inbox: C.inbox, sequencerInbox: C.sequencerInbox, outbox: C.outbox, rollup: C.rollup },
    nativeToken: GME_TOKEN, isCustom: true, isTestnet: false, isBold: true,
    tokenBridge: {
      parentGatewayRouter: P.router, childGatewayRouter: O.router, parentErc20Gateway: P.standardGateway, childErc20Gateway: O.standardGateway,
      parentCustomGateway: P.customGateway, childCustomGateway: O.customGateway, parentWethGateway: zeroAddress, childWethGateway: zeroAddress,
      parentWeth: zeroAddress, childWeth: zeroAddress, parentMultiCall: P.multicall, childMultiCall: O.multicall,
    },
  }, { throwIfAlreadyRegistered: false });
}
async function bridgeIn(parentSigner, usdgAmount, gmeAmount, wait) {
  const net = network(), child = new ethers.providers.JsonRpcProvider(L3_RPC);
  const erc20 = new Erc20Bridger(net), eth = new EthBridger(net);
  const fee = parseEther("0.05").toString(); // ceiling for retryable fees paid in GME; real cost is far lower
  console.log(`bridge: approve GME fees, approve ${formatUnits(usdgAmount, 6)} USDG, deposit`);
  await (await erc20.approveGasToken({ erc20ParentAddress: USDG, parentSigner, amount: fee })).wait();
  await (await erc20.approveToken({ erc20ParentAddress: USDG, parentSigner, amount: usdgAmount.toString() })).wait();
  const t1 = await erc20.deposit({ amount: usdgAmount.toString(), erc20ParentAddress: USDG, parentSigner, childProvider: child });
  const r1 = await t1.wait();
  console.log(`  USDG deposit ${r1.transactionHash}`);
  console.log(`bridge: deposit ${formatEther(gmeAmount)} GME as gas`);
  await (await eth.approveGasToken({ parentSigner, amount: gmeAmount.toString() })).wait();
  const t2 = await eth.deposit({ amount: gmeAmount.toString(), parentSigner });
  const r2 = await t2.wait();
  console.log(`  GME deposit ${r2.transactionHash}`);
  if (wait) {
    console.log("waiting for both to arrive on GME CHAIN (about a minute)…");
    const m1 = await r1.waitForChildTransactionReceipt(child); console.log(`  USDG: ${m1.status === 4 || m1.complete ? "arrived" : JSON.stringify(m1.status)}`);
    const m2 = await r2.waitForChildTransactionReceipt(child); console.log(`  GME: ${m2.complete ? "arrived" : JSON.stringify(m2)}`);
  }
}

// ---------- pool on GME CHAIN ----------
const gmeChain = (rpc) => defineChain({ id: 12821, name: "GME CHAIN", network: "gme-chain", nativeCurrency: { name: "GME", symbol: "GME", decimals: 18 }, rpcUrls: { default: { http: [rpc] }, public: { http: [rpc] } } });
const childUsdg = (l3) => l3.readContract({ address: TB.orbitChainContracts.router, abi: abi.childRouter, functionName: "calculateL2TokenAddress", args: [USDG] });

// Checks the pair before money goes in: an existing pair must be empty or already at the market price.
async function pairCheck(l3, usdgL3, usdgFor) {
  const pair = await l3.readContract({ address: DEX.factory, abi: abi.factory, functionName: "getPair", args: [DEX.wrappedGme, usdgL3] });
  if (pair === zeroAddress) return { pair, ok: true, note: "no pair yet: this seed sets the first price" };
  const [r0, r1] = await l3.readContract({ address: pair, abi: abi.pair, functionName: "getReserves" });
  const t0 = await l3.readContract({ address: pair, abi: abi.pair, functionName: "token0" });
  const [rg, ru] = t0.toLowerCase() === DEX.wrappedGme.toLowerCase() ? [r0, r1] : [r1, r0];
  const bg = await l3.readContract({ address: DEX.wrappedGme, abi: abi.erc20, functionName: "balanceOf", args: [pair] });
  const bu = await l3.readContract({ address: usdgL3, abi: abi.erc20, functionName: "balanceOf", args: [pair] });
  if (bg !== rg || bu !== ru) return { pair, ok: false, note: "tokens were sent to the pair without minting (a price-setting donation)" };
  if (rg === 0n && ru === 0n) return { pair, ok: true, note: "pair exists but is empty" };
  const want = usdgFor(rg), drift = want > ru ? want - ru : ru - want;
  if (drift * 10000n > want * MAX_DRIFT_BPS) return { pair, ok: false, note: `pair already priced ${(Number(ru) / 1e6 / (Number(rg) / 1e18)).toFixed(4)} USDG per GME, off the market` };
  return { pair, ok: true, note: "pair already at the market price" };
}

async function seed(l3, wallet, me, usdgFor) {
  const usdgL3 = await childUsdg(l3);
  const usdgBal = await l3.readContract({ address: usdgL3, abi: abi.erc20, functionName: "balanceOf", args: [me] });
  const usdgIn = usdgFor(SEED_GME);
  console.log(`seed: ${formatEther(SEED_GME)} GME + ${formatUnits(usdgIn, 6)} USDG (bridged USDG on GME CHAIN: ${usdgL3})`);
  if (usdgBal < usdgIn) throw new Error(`Not enough bridged USDG on GME CHAIN: have ${formatUnits(usdgBal, 6)}, need ${formatUnits(usdgIn, 6)}. Nothing was sent.`);
  const pc = await pairCheck(l3, usdgL3, usdgFor);
  console.log(`  pair check: ${pc.note}`);
  if (!pc.ok) throw new Error("Pair check failed. Nothing was sent.");
  const min = (x) => (x * (10000n - MAX_DRIFT_BPS)) / 10000n;
  const send = async (req) => { const h = await wallet.writeContract(req); const r = await l3.waitForTransactionReceipt({ hash: h }); if (r.status !== "success") throw new Error(`reverted: ${h}`); return h; };
  await send({ address: usdgL3, abi: abi.erc20, functionName: "approve", args: [DEX.router, usdgIn] });
  const deadline = BigInt(Math.floor(Date.now() / 1000) + 600);
  const tx = await send({ address: DEX.router, abi: abi.router, functionName: "addLiquidityETH", args: [usdgL3, usdgIn, min(usdgIn), min(SEED_GME), me, deadline], value: SEED_GME });
  const pair = await l3.readContract({ address: DEX.factory, abi: abi.factory, functionName: "getPair", args: [DEX.wrappedGme, usdgL3] });
  const after = await pairCheck(l3, usdgL3, usdgFor);
  const lp = await l3.readContract({ address: pair, abi: abi.pair, functionName: "balanceOf", args: [me] });
  console.log(`  seeded ${pair} in ${tx}; ${after.note}; LP tokens ${formatEther(lp)} held by ${me}`);
  if (!after.ok) throw new Error("Pool is off the market price after seeding. Check it before anyone trades.");
  return { pair, usdgL3, tx, lp };
}

// ---------- forks ----------
async function fork(url, port, chainId) {
  const p = spawn(ANVIL, ["--fork-url", url, "--port", String(port), "--chain-id", String(chainId), "--silent", "--no-rate-limit"], { stdio: "ignore" });
  const rpc = `http://127.0.0.1:${port}`;
  for (let i = 0; i < 120; i++) {
    try { await fetch(rpc, { method: "POST", headers: { "content-type": "application/json" }, body: '{"jsonrpc":"2.0","id":1,"method":"eth_chainId","params":[]}' }); return { p, rpc }; } catch { await new Promise((r) => setTimeout(r, 500)); }
  }
  throw new Error(`fork of ${url} did not start`);
}
const call = (rpc, method, params) => fetch(rpc, { method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify({ jsonrpc: "2.0", id: 1, method, params }) }).then((r) => r.json()).then((j) => { if (j.error) throw new Error(`${method}: ${j.error.message}`); return j.result; });

async function rehearse() {
  const me = getAddress(process.env.DEPLOYER_ADDRESS);
  const { usdgFor, spot } = await market();
  const usdgNeeded = (usdgFor(SEED_GME) * 101n) / 100n; // 1% extra so a small price move does not block the seed
  console.log(`\nRehearsal: ${formatEther(SEED_GME)} GME + ${formatUnits(usdgNeeded, 6)} USDG (~$${(Number(formatEther(SEED_GME)) * spot * 2).toFixed(0)} pool)\n`);
  const f2 = await fork(S.rpc, 8551, 4663), f3 = await fork(L3_RPC, 8552, 12821);
  try {
    // --- Robinhood Chain fork: give the deployer USDG and GME from the market pool, then bridge through the real gateways
    for (const [token, amt] of [[USDG, usdgNeeded], [GME_TOKEN, SEED_GME + parseEther("1")]]) {
      await call(f2.rpc, "anvil_impersonateAccount", [MARKET]);
      await call(f2.rpc, "anvil_setBalance", [MARKET, "0xDE0B6B3A7640000"]);
      const data = (await import("viem")).encodeFunctionData({ abi: abi.erc20, functionName: "transfer", args: [me, amt] });
      await call(f2.rpc, "eth_sendTransaction", [{ from: MARKET, to: token, data }]);
    }
    await call(f2.rpc, "anvil_impersonateAccount", [me]);
    const p2 = new ethers.providers.JsonRpcProvider(f2.rpc);
    await bridgeIn(p2.getSigner(me), usdgNeeded, SEED_GME + parseEther("0.01"), false);
    console.log("  parent side OK: both deposits accepted by the real inbox and gateway on the fork");

    // --- GME CHAIN fork: deliver the deposits exactly as the chain would (gateway message from the aliased parent gateway)
    const l2 = createPublicClient({ transport: http(f2.rpc) });
    const l3 = createPublicClient({ chain: gmeChain(f3.rpc), transport: http(f3.rpc) });
    const deliver = async (to, amount) => {
      const msg = await l2.readContract({ address: TB.parentChainContracts.standardGateway, abi: abi.gw, functionName: "getOutboundCalldata", args: [USDG, me, to, amount, "0x"] });
      const alias = getAddress("0x" + ((BigInt(TB.parentChainContracts.standardGateway) + 0x1111000000000000000000000000000000001111n) % (1n << 160n)).toString(16).padStart(40, "0"));
      await call(f3.rpc, "anvil_impersonateAccount", [alias]); await call(f3.rpc, "anvil_setBalance", [alias, "0xDE0B6B3A7640000"]);
      const h = await call(f3.rpc, "eth_sendTransaction", [{ from: alias, to: TB.orbitChainContracts.standardGateway, data: msg, gas: "0x2DC6C0" }]);
      const r = await l3.waitForTransactionReceipt({ hash: h }); if (r.status !== "success") throw new Error("bridged USDG delivery reverted on the fork");
    };
    await deliver(me, usdgNeeded);
    await call(f3.rpc, "anvil_setBalance", [me, "0x" + (SEED_GME + parseEther("5")).toString(16)]); // pool + a test swap + gas
    const usdgL3 = await childUsdg(l3);
    const sym = await l3.readContract({ address: usdgL3, abi: abi.erc20, functionName: "symbol" });
    const dec = await l3.readContract({ address: usdgL3, abi: abi.erc20, functionName: "decimals" });
    console.log(`  child side OK: bridged ${sym} (${dec} decimals) minted at ${usdgL3}`);

    // --- attack first: someone creates the pair and sets a bad price before us. The seed must refuse.
    const snap = await call(f3.rpc, "evm_snapshot", []);
    const attacker = "0x000000000000000000000000000000000000bad1";
    await deliver(attacker, 1_000_000n); // 1 USDG
    await call(f3.rpc, "anvil_impersonateAccount", [attacker]); await call(f3.rpc, "anvil_setBalance", [attacker, "0xDE0B6B3A7640000"]);
    const aw = createWalletClient({ chain: gmeChain(f3.rpc), transport: http(f3.rpc), account: attacker });
    const go = async (req) => l3.waitForTransactionReceipt({ hash: await aw.writeContract(req) });
    await go({ address: DEX.factory, abi: abi.factory, functionName: "createPair", args: [DEX.wrappedGme, usdgL3] });
    const evil = await l3.readContract({ address: DEX.factory, abi: abi.factory, functionName: "getPair", args: [DEX.wrappedGme, usdgL3] });
    await go({ address: DEX.wrappedGme, abi: abi.wgme, functionName: "deposit", value: parseEther("0.1") });
    await go({ address: DEX.wrappedGme, abi: abi.wgme, functionName: "transfer", args: [evil, parseEther("0.1")] });
    await go({ address: usdgL3, abi: abi.erc20, functionName: "transfer", args: [evil, 1_000_000n] }); // 1 USDG for 0.1 GME = $10 per GME, far off
    await go({ address: evil, abi: abi.pair, functionName: "mint", args: [attacker] });
    await call(f3.rpc, "anvil_impersonateAccount", [me]);
    const w3 = createWalletClient({ chain: gmeChain(f3.rpc), transport: http(f3.rpc), account: me });
    const blocked = await seed(l3, w3, me, usdgFor).then(() => false, (e) => /Pair check failed/.test(e.message));
    console.log(`  attack test: pre-priced pair ${blocked ? "REFUSED, nothing sent (good)" : "NOT refused (bad)"}`);
    if (!blocked) throw new Error("the pair check did not stop a pre-priced pair");
    await call(f3.rpc, "evm_revert", [snap]);

    // --- the real seed, then a user swap
    await call(f3.rpc, "anvil_impersonateAccount", [me]);
    const res = await seed(l3, w3, me, usdgFor);
    const path2 = [DEX.wrappedGme, usdgL3], oneGme = parseEther("1");
    const [, out] = await l3.readContract({ address: DEX.router, abi: abi.router, functionName: "getAmountsOut", args: [oneGme, path2] });
    console.log(`  swap quote: 1 GME -> ${formatUnits(out, 6)} USDG on GME CHAIN (market $${spot.toFixed(2)}, includes 0.3% fee and price impact)`);
    const swapHash = await w3.writeContract({ address: DEX.router, abi: abi.router, functionName: "swapExactETHForTokens", args: [(out * 99n) / 100n, path2, me, BigInt(Math.floor(Date.now() / 1000) + 600)], value: oneGme });
    const sr = await l3.waitForTransactionReceipt({ hash: swapHash });
    console.log(`  user swap: ${sr.status === "success" ? "OK" : "FAILED"}`);
    if (sr.status !== "success") throw new Error("swap failed on the fork");
    console.log(`\nREHEARSAL PASSED. On mainnet the deployer needs on Robinhood Chain: ${formatUnits(usdgNeeded, 6)} USDG, ${formatEther(SEED_GME + parseEther("0.06"))} GME (pool + gas + bridge fees) and a little ETH.`);
    return res;
  } finally { f2.p.kill(); f3.p.kill(); }
}

// ---------- main ----------
if (MODE === "dry") await rehearse();
else if (MODE === "bridge") {
  const { usdgFor } = await market();
  const usdgNeeded = (usdgFor(SEED_GME) * 101n) / 100n;
  await confirmMainnet(`Bridge ${formatUnits(usdgNeeded, 6)} USDG and ${formatEther(SEED_GME + parseEther("0.01"))} GME to GME CHAIN`);
  const signer = new ethers.Wallet(process.env.DEPLOYER_PRIVATE_KEY, new ethers.providers.JsonRpcProvider(S.rpc));
  if (signer.address.toLowerCase() !== process.env.DEPLOYER_ADDRESS.toLowerCase()) throw new Error("Deployer key does not match DEPLOYER_ADDRESS. Nothing was sent.");
  await bridgeIn(signer, usdgNeeded, SEED_GME + parseEther("0.01"), true);
} else {
  const { usdgFor } = await market();
  await confirmMainnet(`Create and seed the GME/USDG pool on GME CHAIN with ${formatEther(SEED_GME)} GME`);
  const acct = account("DEPLOYER");
  const l3 = createPublicClient({ chain: gmeChain(L3_RPC), transport: http(L3_RPC) });
  const w3 = createWalletClient({ chain: gmeChain(L3_RPC), transport: http(L3_RPC), account: acct });
  const res = await seed(l3, w3, acct.address, usdgFor);
  saveDeployment({ dex: { ...loadDeployment().dex, usdg: res.usdgL3, usdgPair: res.pair, usdgSeedTx: res.tx, usdgSeedGme: formatEther(SEED_GME), lpHolder: acct.address } });
}
