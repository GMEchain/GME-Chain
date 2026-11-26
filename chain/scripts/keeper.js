// GME CHAIN price keeper.
//
// Keeps GmeFeeTokenPricer.gmeUsd (USD per raw GME, 18 decimals) in line with the market so the
// batch poster is reimbursed fairly in GME for the ETH it spends.
//
// Price source: Uniswap v3 GME/USDG 1% pool on Robinhood Chain (0xe9713f45…2fdf, the deepest GME pool):
// its built-in 30-minute TWAP, sampled every minute, median over a window, x Chainlink USDG/USD.
// Cross-checked against the 0.05% GME/USDG pool and an off-chain quote.
// There is no Chainlink GME feed on Robinhood Chain yet; when one appears, prefer it.
//
// Safety:
//  - median of samples (resists one-block manipulation), minimum pool liquidity
//  - cross-check vs off-chain quote; skip if they disagree by more than MAX_XCHECK_DIFF
//  - freeze while GME is paused, its oracle is paused, or within 1h of a corporate action (effectiveAt)
//  - each update stays inside the pricer's on-chain deviation band
//
// Run: node scripts/keeper.js --mainnet            (sends transactions)
//      DRY_RUN=1 node scripts/keeper.js --mainnet  (logs decisions only)
import http from "node:http";
import { parseAbi, formatEther, parseEther, createPublicClient, createWalletClient, defineChain, http as viemHttp } from "viem";
import { NETWORK, parentPublicClient as client, walletClient, account, loadDeployment, GME_TOKEN } from "./lib.js";
import { createBurnerJob } from "./fee-burner-job.js";

if (NETWORK !== "mainnet") throw new Error("Keeper runs on mainnet only (use --mainnet).");
if (!loadDeployment().feeTokenPricer && !process.env.PRICER_ADDRESS) throw new Error("No fee token pricer yet: run 02-create-rollup.js --mainnet first, or set PRICER_ADDRESS.");

// ---------- configuration ----------
const CFG = {
  pricer: process.env.PRICER_ADDRESS || loadDeployment().feeTokenPricer,
  pool: process.env.GME_POOL || "0xe9713f453adb9245b19559790c96f470a18f2fdf", // Uniswap v3 GME/USDG 1% (token0 GME, token1 USDG)
  checkPool: process.env.GME_CHECK_POOL || "0xe2b46c905e12ab8e2f864e4821a4325884c1b126", // Uniswap v3 GME/USDG 0.05%
  twapSec: Number(process.env.TWAP_SEC || 1800),
  usdg: "0x5fc5360d0400a0fd4f2af552add042d716f1d168",
  usdgUsdFeed: "0x61B7e5650328764B076A108EFF5fa7282a1B9aD2", // Chainlink USDG / USD
  gmeRegistry: "0xe10b6f6b275de231345c20d14ab812db62151b00", // Robinhood stock token registry/beacon
  sampleEveryMs: Number(process.env.SAMPLE_EVERY_MS || 60_000),
  windowSamples: Number(process.env.WINDOW_SAMPLES || 30), // 30 x 1 min
  minSamples: Number(process.env.MIN_SAMPLES || 10),
  minLiquidity: BigInt(process.env.MIN_POOL_LIQUIDITY || "100000000000000000"), // 1e17 virtual L
  updateThreshold: Number(process.env.UPDATE_THRESHOLD || 0.005), // 0.5%
  maxAgeBeforeRefreshSec: Number(process.env.MAX_AGE_SEC || 6 * 3600),
  maxXcheckDiff: Number(process.env.MAX_XCHECK_DIFF || 0.05), // 5%
  corporateActionFreezeSec: 3600,
  dryRun: process.env.DRY_RUN === "1",
  port: Number(process.env.PORT || 8080),
};

const pricerAbi = parseAbi([
  "function gmeUsd() view returns (uint256)",
  "function gmeUsdUpdatedAt() view returns (uint256)",
  "function ethUsd() view returns (uint256)",
  "function maxDeviationBps() view returns (uint256)",
  "function minUpdateInterval() view returns (uint256)",
  "function keeper() view returns (address)",
  "function currentRate() view returns (uint256)",
  "function submitGmePrice(uint256)",
]);
const v3Abi = parseAbi([
  "function token0() view returns (address)",
  "function token1() view returns (address)",
  "function liquidity() view returns (uint128)",
  "function observe(uint32[]) view returns (int56[], uint160[])",
]);
const feedAbi = parseAbi(["function latestRoundData() view returns (uint80,int256,uint256,uint256,uint80)"]);
const tokenAbi = parseAbi([
  "function paused() view returns (bool)",
  "function tokenPaused() view returns (bool)",
  "function oraclePaused() view returns (bool)",
  "function effectiveAt() view returns (uint256)",
  "function uiMultiplier() view returns (uint256)",
  "function newUIMultiplier() view returns (uint256)",
]);
const registryAbi = parseAbi(["function paused() view returns (bool)"]);

const keeper = account("KEEPER");
const wallet = walletClient("KEEPER");
const samples = [];
const status = { ok: false, startedAt: new Date().toISOString(), network: NETWORK, keeper: keeper.address, dryRun: CFG.dryRun };

function log(msg, extra = {}) {
  console.log(JSON.stringify({ t: new Date().toISOString(), msg, ...extra }));
}
const median = (xs) => {
  const s = [...xs].sort((a, b) => a - b);
  const m = Math.floor(s.length / 2);
  return s.length % 2 ? s[m] : (s[m - 1] + s[m]) / 2;
};

// ---------- price reads ----------
// USDG per GME from a v3 pool's time-weighted average tick over the last twapSec seconds.
async function twapUsdgPerGme(pool) {
  const [t0, t1, liquidity, [ticks]] = await Promise.all([
    client.readContract({ address: pool, abi: v3Abi, functionName: "token0" }),
    client.readContract({ address: pool, abi: v3Abi, functionName: "token1" }),
    client.readContract({ address: pool, abi: v3Abi, functionName: "liquidity" }),
    client.readContract({ address: pool, abi: v3Abi, functionName: "observe", args: [[CFG.twapSec, 0]] }),
  ]);
  if (t0.toLowerCase() !== GME_TOKEN.toLowerCase() || t1.toLowerCase() !== CFG.usdg) throw new Error(`pool ${pool} is not GME/USDG`);
  if (liquidity < CFG.minLiquidity) throw new Error(`pool liquidity too low: ${liquidity}`);
  const tick = Number(ticks[1] - ticks[0]) / CFG.twapSec;
  // token0 = GME (18 dp), token1 = USDG (6 dp): 1.0001^tick = USDG_raw per GME_raw
  return 1.0001 ** tick * 10 ** (18 - 6);
}

async function poolPriceUsd() {
  const usdgPerGme = await twapUsdgPerGme(CFG.pool);
  try {
    const check = await twapUsdgPerGme(CFG.checkPool);
    if (Math.abs(usdgPerGme / check - 1) > CFG.maxXcheckDiff) throw new Error(`GME pools disagree: ${usdgPerGme} vs ${check}`);
  } catch (e) {
    if (/disagree/.test(e.message)) throw e; // a thin or missing check pool is not fatal
  }
  const [, answer, , updatedAt] = await client.readContract({ address: CFG.usdgUsdFeed, abi: feedAbi, functionName: "latestRoundData" });
  const usdgUsd = Number(answer) / 1e8;
  const age = Date.now() / 1000 - Number(updatedAt);
  if (!(usdgUsd > 0.98 && usdgUsd < 1.02)) throw new Error(`USDG/USD out of range: ${usdgUsd}`);
  if (age > 26 * 3600) throw new Error(`USDG/USD feed stale: ${Math.round(age / 3600)}h`);
  return usdgPerGme * usdgUsd;
}

async function offchainPriceUsd() {
  try {
    const r = await fetch("https://api.coinpaprika.com/v1/tickers/gme-gamestop-robinhood-tokenized-stock", { signal: AbortSignal.timeout(10_000) });
    if (!r.ok) return null;
    const p = (await r.json())?.quotes?.USD?.price;
    return typeof p === "number" && p > 0 ? p : null;
  } catch {
    return null;
  }
}

async function freezeReason() {
  const [paused, tokenPaused, oraclePaused, effectiveAt, ui, newUi, regPaused] = await Promise.all([
    client.readContract({ address: GME_TOKEN, abi: tokenAbi, functionName: "paused" }),
    client.readContract({ address: GME_TOKEN, abi: tokenAbi, functionName: "tokenPaused" }),
    client.readContract({ address: GME_TOKEN, abi: tokenAbi, functionName: "oraclePaused" }),
    client.readContract({ address: GME_TOKEN, abi: tokenAbi, functionName: "effectiveAt" }),
    client.readContract({ address: GME_TOKEN, abi: tokenAbi, functionName: "uiMultiplier" }),
    client.readContract({ address: GME_TOKEN, abi: tokenAbi, functionName: "newUIMultiplier" }),
    client.readContract({ address: CFG.gmeRegistry, abi: registryAbi, functionName: "paused" }),
  ]);
  if (paused || tokenPaused || regPaused) return "GME transfers paused by issuer";
  if (oraclePaused) return "GME oracle paused by issuer";
  const now = Date.now() / 1000;
  const eff = Number(effectiveAt);
  if (eff > 0 && Math.abs(now - eff) < CFG.corporateActionFreezeSec) return `corporate action window (effectiveAt ${eff})`;
  if (ui !== newUi && eff > now) return `pending multiplier change at ${eff}`;
  return null;
}

// ---------- main loop ----------
async function tick() {
  try {
    const p = await poolPriceUsd();
    samples.push(p);
    while (samples.length > CFG.windowSamples) samples.shift();
    status.lastPoolPrice = p;
    status.samples = samples.length;

    if (samples.length < CFG.minSamples) {
      log("collecting samples", { have: samples.length, need: CFG.minSamples, price: p });
      status.ok = true;
      return;
    }

    const target = median(samples);
    status.medianPrice = target;

    const frozen = await freezeReason();
    if (frozen) {
      status.frozen = frozen;
      log("frozen, no update", { reason: frozen });
      return;
    }
    status.frozen = null;

    const off = await offchainPriceUsd();
    status.offchainPrice = off;
    if (off !== null && Math.abs(target / off - 1) > CFG.maxXcheckDiff) {
      status.ok = false;
      log("cross-check failed, no update", { median: target, offchain: off });
      return;
    }

    const [cur, updatedAt, maxDevBps, minInterval, onchainKeeper] = await Promise.all([
      client.readContract({ address: CFG.pricer, abi: pricerAbi, functionName: "gmeUsd" }),
      client.readContract({ address: CFG.pricer, abi: pricerAbi, functionName: "gmeUsdUpdatedAt" }),
      client.readContract({ address: CFG.pricer, abi: pricerAbi, functionName: "maxDeviationBps" }),
      client.readContract({ address: CFG.pricer, abi: pricerAbi, functionName: "minUpdateInterval" }),
      client.readContract({ address: CFG.pricer, abi: pricerAbi, functionName: "keeper" }),
    ]);
    if (onchainKeeper.toLowerCase() !== keeper.address.toLowerCase()) throw new Error(`pricer keeper is ${onchainKeeper}, not ${keeper.address}`);

    const curUsd = Number(formatEther(cur));
    status.onchainPrice = curUsd;
    const age = Date.now() / 1000 - Number(updatedAt);
    const drift = Math.abs(target / curUsd - 1);
    if (drift < CFG.updateThreshold && age < CFG.maxAgeBeforeRefreshSec) {
      status.ok = true;
      log("no update needed", { onchain: curUsd, median: target, drift: +(drift * 100).toFixed(3) });
      return;
    }
    if (age < Number(minInterval)) return;

    // Stay inside the on-chain band with a safety margin of 0.5%.
    const band = Math.max(0, Number(maxDevBps) / 10_000 - 0.005);
    const next = Math.min(Math.max(target, curUsd * (1 - band)), curUsd * (1 + band));
    const nextWei = parseEther(next.toFixed(8));

    if (CFG.dryRun) {
      log("DRY RUN would submit", { from: curUsd, to: next, target });
      status.ok = true;
      return;
    }
    const hash = await wallet.writeContract({ address: CFG.pricer, abi: pricerAbi, functionName: "submitGmePrice", args: [nextWei] });
    const r = await client.waitForTransactionReceipt({ hash });
    const rate = await client.readContract({ address: CFG.pricer, abi: pricerAbi, functionName: "currentRate" });
    status.ok = r.status === "success";
    status.lastUpdate = { at: new Date().toISOString(), from: curUsd, to: next, tx: hash, gmePerEth: Number(formatEther(rate)) };
    log("submitted", status.lastUpdate);
  } catch (e) {
    status.ok = false;
    status.lastError = { at: new Date().toISOString(), message: e.shortMessage || e.message };
    log("error", status.lastError);
  } finally {
    status.lastTick = new Date().toISOString();
    try {
      status.keeperEth = Number(formatEther(await client.getBalance({ address: keeper.address })));
      if (status.keeperEth < 0.0005) log("WARNING keeper ETH low", { eth: status.keeperEth });
    } catch {}
  }
}

http
  .createServer((req, res) => {
    const healthy = status.ok && status.lastTick && Date.now() - Date.parse(status.lastTick) < 5 * CFG.sampleEveryMs;
    res.writeHead(req.url === "/health" && !healthy ? 503 : 200, { "content-type": "application/json" });
    res.end(JSON.stringify({ healthy, ...status }, null, 2));
  })
  .listen(CFG.port, () => log("keeper started", { pricer: CFG.pricer, pool: CFG.pool, keeper: keeper.address, dryRun: CFG.dryRun, port: CFG.port }));

await tick();
setInterval(tick, CFG.sampleEveryMs);

// ---------- exchange fee burn (GME CHAIN) ----------
// Dormant until a FeeBurner is deployed (scripts/11-fee-burner.js). Then, every BURN_EVERY_MS (default 6 h), it turns
// what the FeeBurner holds (the exchange's protocol fee and half of each launchpad fee, both paid by traders) into
// burned $GMEC (scripts/fee-burner-job.js). It runs apart from the price loop: an error here is reported under
// "burner" and never affects the price updates or /health.
const dep = loadDeployment();
if (dep.feeBurner?.address && !CFG.dryRun && process.env.BURNER_DISABLED !== "1") {
  const L3_RPC = process.env.L3_RPC || "https://rpc.gmechain.xyz";
  const l3 = defineChain({ id: 12821, name: "GME CHAIN", nativeCurrency: { name: "GME", symbol: "GME", decimals: 18 }, rpcUrls: { default: { http: [L3_RPC] } } });
  const l3pub = createPublicClient({ chain: l3, transport: viemHttp(L3_RPC, { timeout: 60_000 }) });
  const l3wallet = createWalletClient({ account: keeper, chain: l3, transport: viemHttp(L3_RPC, { timeout: 60_000 }) });
  const job = createBurnerJob({
    pub: l3pub,
    wallet: l3wallet,
    addr: { burner: dep.feeBurner.address, factory: dep.dex.factory, router: dep.dex.router, gmec: dep.feeBurner.gmec, want: dep.dex.wrappedGme },
    log,
  });
  status.burner = job.status;
  let burning = false;
  const burn = async () => {
    if (burning) return;
    burning = true;
    try { await job.run(); } catch (e) { log("fee burn run failed", { error: String(e?.shortMessage || e?.message || e) }); } finally { burning = false; }
  };
  const every = Number(process.env.BURN_EVERY_MS || 6 * 3600_000);
  setTimeout(burn, 120_000);
  setInterval(burn, every);
  log("fee burn job on", { burner: dep.feeBurner.address, everyMs: every });
}
