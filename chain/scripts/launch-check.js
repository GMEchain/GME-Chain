// Mainnet launch readiness, read-only: no keys are loaded and nothing is sent.
//   node scripts/launch-check.js --mainnet
// Prints PASS / WARN / FAIL per check and exits 1 when anything fails.
import fs from "node:fs";
import path from "node:path";
import { createPublicClient, http, parseAbi, formatEther, formatUnits, defineChain } from "viem";
import { ROOT, NETWORK, parentPublicClient as parent, loadDeployment, GME_TOKEN, CHAINLINK_ETH_USD_MAINNET } from "./lib.js";

if (NETWORK !== "mainnet") throw new Error("Run with --mainnet.");
const dep = loadDeployment();
const C = dep.coreContracts;
const L3_RPC = process.env.L3_RPC || "https://rpc.gmechain.xyz";
const l3 = createPublicClient({ chain: defineChain({ id: 12821, name: "GME CHAIN", nativeCurrency: { name: "GME", symbol: "GME", decimals: 18 }, rpcUrls: { default: { http: [L3_RPC] } } }), transport: http(L3_RPC) });
const addr = (k) => process.env[k] || null; // public addresses only

const rows = [];
const out = (lvl, name, detail = "") => { rows.push(lvl); console.log(`${lvl.padEnd(4)}  ${name}${detail ? `  (${detail})` : ""}`); };
const check = async (name, fn) => { try { const [lvl, detail] = await fn(); out(lvl, name, detail); } catch (e) { out("FAIL", name, (e.shortMessage || e.message || String(e)).split("\n")[0].slice(0, 140)); } };
const read = (address, sig, fn, args = []) => parent.readContract({ address, abi: parseAbi([sig]), functionName: fn, args });
const ageMin = (ts) => (Date.now() / 1000 - Number(ts)) / 60;

console.log(`GME CHAIN mainnet launch check · ${new Date().toISOString()}\n`);

// ---------- GME CHAIN itself ----------
await check("GME CHAIN RPC answers as chain 12821", async () => {
  const id = await l3.getChainId();
  return [id === 12821 ? "PASS" : "FAIL", `${L3_RPC} → ${id}`];
});
await check("GME CHAIN produces blocks", async () => {
  const b = await l3.getBlock();
  return ["PASS", `block ${b.number}, last ${ageMin(b.timestamp).toFixed(0)} min ago (blocks are made only when there are transactions)`];
});
await check("Exchange (Uniswap V2) deployed on GME CHAIN", async () => {
  const code = await l3.getBytecode({ address: dep.dex.router });
  const pairs = await l3.readContract({ address: dep.dex.factory, abi: parseAbi(["function allPairsLength() view returns (uint256)"]), functionName: "allPairsLength" });
  if (!code || code === "0x") return ["FAIL", "router has no code"];
  return [pairs > 0n ? "PASS" : "WARN", pairs > 0n ? `${pairs} pool(s)` : "no pools yet: the swap page has nothing to trade until liquidity is added"];
});

// ---------- rollup on Robinhood Chain ----------
await check("Rollup contract on Robinhood Chain", async () => {
  const code = await parent.getBytecode({ address: C.rollup });
  return [code && code !== "0x" ? "PASS" : "FAIL", C.rollup];
});
await check("Batches posted", async () => {
  const n = await read(C.sequencerInbox, "function batchCount() view returns (uint256)", "batchCount");
  return [n > 1n ? "PASS" : "WARN", `${n} batches`];
});
await check("Validator staked", async () => {
  const v = addr("VALIDATOR_ADDRESS");
  if (!v) return ["WARN", "VALIDATOR_ADDRESS not set"];
  const staked = await read(C.rollup, "function isStaked(address) view returns (bool)", "isStaked", [v]);
  return [staked ? "PASS" : "FAIL", `${v} ${staked ? "is staked" : "is NOT staked"}`];
});
await check("Validator allowlist", async () => {
  const off = await read(C.rollup, "function validatorWhitelistDisabled() view returns (bool)", "validatorWhitelistDisabled");
  return ["PASS", off ? "open: anyone can validate" : "on: only our validator (as stated in TRANSPARENCY.md)"];
});
await check("Rollup owner", async () => {
  const o = await read(C.rollup, "function owner() view returns (address)", "owner");
  return ["WARN", `${o}: plan says move ownership to a multisig before or soon after launch`];
});
await check("GME locked in the bridge", async () => {
  const b = await read(GME_TOKEN, "function balanceOf(address) view returns (uint256)", "balanceOf", [C.bridge]);
  return ["PASS", `${Number(formatEther(b)).toLocaleString("en-US", { maximumFractionDigits: 4 })} GME`];
});

// ---------- operators pay ETH gas on Robinhood Chain ----------
const MIN = { BATCH_POSTER: 0.003, VALIDATOR: 0.002, KEEPER: 0.001, DEPLOYER: 0 };
for (const role of Object.keys(MIN)) {
  await check(`${role.toLowerCase().replace("_", " ")} ETH balance`, async () => {
    const a = addr(`${role}_ADDRESS`);
    if (!a) return ["WARN", `${role}_ADDRESS not set`];
    const eth = Number(formatEther(await parent.getBalance({ address: a })));
    return [eth >= MIN[role] ? "PASS" : "WARN", `${eth.toFixed(6)} ETH${MIN[role] ? `, want ≥ ${MIN[role]}` : ""}`];
  });
}

// ---------- gas price: keeper + Chainlink ----------
await check("Fee pricer: keeper price is fresh", async () => {
  const t = await read(dep.feeTokenPricer, "function gmeUsdUpdatedAt() view returns (uint256)", "gmeUsdUpdatedAt");
  const p = await read(dep.feeTokenPricer, "function gmeUsd() view returns (uint256)", "gmeUsd");
  const m = ageMin(t);
  return [m < 6.5 * 60 ? "PASS" : "FAIL", `GME $${Number(formatUnits(p, 18)).toFixed(2)}, updated ${m.toFixed(0)} min ago (keeper refreshes at least every 6 h)`];
});
await check("Fee pricer: limits", async () => {
  const bps = await read(dep.feeTokenPricer, "function maxDeviationBps() view returns (uint256)", "maxDeviationBps");
  const iv = await read(dep.feeTokenPricer, "function minUpdateInterval() view returns (uint256)", "minUpdateInterval");
  const tight = bps <= 300n && iv >= 600n;
  return [tight ? "PASS" : "WARN", `max move ${Number(bps) / 100}% per update, every ≥ ${iv} s${tight ? "" : "; review suggests ≤ 2-3% and ≥ 10-60 min"}`];
});
await check("Chainlink ETH/USD feed", async () => {
  const r = await read(CHAINLINK_ETH_USD_MAINNET, "function latestRoundData() view returns (uint80, int256, uint256, uint256, uint80)", "latestRoundData");
  const m = ageMin(r[3]);
  // The feed only updates on ~0.5% moves (24 h heartbeat). When it is older than 2 h the pricer keeps its last good ETH price.
  return [m < 24 * 60 + 30 ? "PASS" : "WARN", `$${(Number(r[1]) / 1e8).toFixed(2)}, ${m.toFixed(0)} min old${m >= 115 ? "; pricer keeps its last good ETH price until the next update" : ""}`];
});

// ---------- ETH bridge (gas router) ----------
await check("Gas router wired to inbox, WETH and GME", async () => {
  const abi = parseAbi(["function inbox() view returns (address)", "function weth() view returns (address)", "function gme() view returns (address)"]);
  const [inbox, weth, gme] = await Promise.all(["inbox", "weth", "gme"].map((f) => parent.readContract({ address: dep.gasRouter, abi, functionName: f })));
  const ok = inbox.toLowerCase() === C.inbox.toLowerCase() && weth.toLowerCase() === dep.stakeToken.toLowerCase() && gme.toLowerCase() === GME_TOKEN.toLowerCase();
  return [ok ? "PASS" : "FAIL", dep.gasRouter];
});
await check("Uniswap v3 WETH/GME pool has liquidity", async () => {
  const pool = "0xc6bcc95043dc48c204bb2d57fb264a10efe0a607";
  const liq = await read(pool, "function liquidity() view returns (uint128)", "liquidity");
  return [liq > 0n ? "PASS" : "FAIL", `${pool} liquidity ${liq}`];
});

// ---------- website ----------
await check("Website config matches the deployment", async () => {
  const cfg = fs.readFileSync(path.join(ROOT, "..", "site", "js", "config.js"), "utf8");
  const at = cfg.indexOf("\n  mainnet: {"), main = cfg.slice(at, cfg.indexOf("\n  },", at));
  const want = { inbox: C.inbox, bridge: C.bridge, outbox: C.outbox, rollup: C.rollup, sequencerInbox: C.sequencerInbox, pricer: dep.feeTokenPricer, gasRouter: dep.gasRouter, router: dep.dex.router, factory: dep.dex.factory, wrappedGme: dep.dex.wrappedGme };
  const bad = Object.entries(want).filter(([k, v]) => !new RegExp(`${k}: "${v}"`, "i").test(main)).map(([k]) => k);
  return [bad.length ? "FAIL" : "PASS", bad.length ? `mismatch: ${bad.join(", ")}` : "all mainnet addresses match"];
});
await check("Mainnet switch", async () => {
  const cfg = fs.readFileSync(path.join(ROOT, "..", "site", "js", "config.js"), "utf8");
  const open = /export const MAINNET_OPEN = true;/.test(cfg);
  return ["PASS", open ? "OPEN: the site shows mainnet" : "closed (pre-launch): flip MAINNET_OPEN at launch"];
});

const f = rows.filter((r) => r === "FAIL").length, w = rows.filter((r) => r === "WARN").length;
console.log(`\n${rows.length - f - w} pass, ${w} warn, ${f} fail`);
process.exit(f ? 1 : 0);
