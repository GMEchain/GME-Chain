// GME CHAIN monitor: checks the chain, operators, keeper and the GME token every interval,
// sends alerts to Telegram and/or Discord when something needs attention, and serves /status.
//
// Env:
//   NETWORK=mainnet, PARENT_RPC (archive RPC for Robinhood Chain), L3_RPC
//   KEEPER_HEALTH_URL (the keeper's /health endpoint; unset = skip the keeper check)
//   TELEGRAM_BOT_TOKEN + TELEGRAM_CHAT_ID and/or DISCORD_WEBHOOK_URL (optional)
import http from "node:http";
import { createPublicClient, http as viemHttp, parseAbi, formatEther, parseEther } from "viem";
import { NETWORK, parentPublicClient as parent, loadDeployment, GME_TOKEN, env } from "./lib.js";

if (NETWORK !== "mainnet") throw new Error("Monitor runs on mainnet only (use --mainnet).");

const dep = loadDeployment();
const C = dep.coreContracts;
const ADDR = {
  // operator wallets: public addresses only, from the environment (never keys)
  batchPoster: env("BATCH_POSTER_ADDRESS"),
  validator: env("VALIDATOR_ADDRESS"),
  keeper: env("KEEPER_ADDRESS"),
  deployer: env("DEPLOYER_ADDRESS"),
  registry: "0xe10b6f6b275de231345c20d14ab812db62151b00",
  ethUsdFeed: "0x78F3556b67E17Df817D51Ef5a990cDaF09E8d3A9",
};
const CFG = {
  l3Rpc: process.env.L3_RPC || "https://rpc.gmechain.xyz",
  keeperHealth: process.env.KEEPER_HEALTH_URL || null, // e.g. http://keeper:8080/health inside docker compose; unset = skip the check
  intervalMs: Number(process.env.MONITOR_INTERVAL_MS || 120_000),
  minEth: {
    batchPoster: parseEther(process.env.MIN_ETH_BATCH_POSTER || "0.003"),
    validator: parseEther(process.env.MIN_ETH_VALIDATOR || "0.002"),
    keeper: parseEther(process.env.MIN_ETH_KEEPER || "0.0005"),
    deployer: parseEther(process.env.MIN_ETH_DEPLOYER || "0.001"),
  },
  unbatchedMaxMin: Number(process.env.UNBATCHED_MAX_MIN || 90),
  pricerMaxAgeH: Number(process.env.PRICER_MAX_AGE_H || 7),
  validatorGraceH: Number(process.env.VALIDATOR_GRACE_H || 3),
  realertEveryMin: Number(process.env.REALERT_EVERY_MIN || 60),
  port: Number(process.env.PORT || 8080),
};

const l3 = createPublicClient({ transport: viemHttp(CFG.l3Rpc, { timeout: 20_000 }) });
const abi = {
  si: parseAbi(["function batchCount() view returns (uint256)"]),
  rollup: parseAbi(["function isStaked(address) view returns (bool)", "function latestStakedAssertion(address) view returns (bytes32)"]),
  pricer: parseAbi(["function gmeUsd() view returns (uint256)", "function gmeUsdUpdatedAt() view returns (uint256)", "function currentRate() view returns (uint256)"]),
  feed: parseAbi(["function latestRoundData() view returns (uint80,int256,uint256,uint256,uint80)"]),
  token: parseAbi(["function paused() view returns (bool)", "function tokenPaused() view returns (bool)", "function oraclePaused() view returns (bool)", "function balanceOf(address) view returns (uint256)"]),
  registry: parseAbi(["function paused() view returns (bool)", "function isBlocked(address) view returns (bool)"]),
};

const startedAt = Date.now();
const state = { lastBatchCount: null, lastBatchChangeAt: Date.now(), l3HeadAtLastBatch: null, active: new Map() };
let lastReport = { ok: null, checks: [], at: null };

// ---------- alert delivery ----------
async function notify(text) {
  const jobs = [];
  if (process.env.TELEGRAM_BOT_TOKEN && process.env.TELEGRAM_CHAT_ID) {
    jobs.push(
      fetch(`https://api.telegram.org/bot${process.env.TELEGRAM_BOT_TOKEN}/sendMessage`, {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({ chat_id: process.env.TELEGRAM_CHAT_ID, text, disable_web_page_preview: true }),
      }),
    );
  }
  if (process.env.DISCORD_WEBHOOK_URL) {
    jobs.push(fetch(process.env.DISCORD_WEBHOOK_URL, { method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify({ content: text }) }));
  }
  const res = await Promise.allSettled(jobs);
  res.filter((r) => r.status === "rejected").forEach((r) => console.log(JSON.stringify({ msg: "alert delivery failed", err: String(r.reason) })));
}

// Alert on new problems, re-alert while they persist, announce recovery.
async function reconcile(checks) {
  const now = Date.now();
  for (const c of checks) {
    const prev = state.active.get(c.id);
    if (!c.ok) {
      if (!prev || now - prev.lastSent > CFG.realertEveryMin * 60_000) {
        await notify(`🔴 GME CHAIN: ${c.name}\n${c.detail}`);
        state.active.set(c.id, { since: prev?.since ?? now, lastSent: now });
      }
    } else if (prev) {
      await notify(`✅ GME CHAIN recovered: ${c.name}\n${c.detail}`);
      state.active.delete(c.id);
    }
  }
}

// ---------- checks ----------
async function runChecks() {
  const checks = [];
  const add = (id, name, ok, detail) => checks.push({ id, name, ok: !!ok, detail: String(detail) });
  const safe = async (id, name, fn) => {
    try {
      await fn();
    } catch (e) {
      add(id, name, false, `check failed: ${e.shortMessage || e.message}`);
    }
  };

  // node / RPC
  let l3Head = null;
  await safe("l3-rpc", "GME CHAIN RPC", async () => {
    const [id, head] = await Promise.all([l3.getChainId(), l3.getBlockNumber()]);
    l3Head = head;
    add("l3-rpc", "GME CHAIN RPC", id === dep.chainId, `chain ${id}, block ${head}`);
  });

  // batch poster progress
  await safe("batches", "Batch posting", async () => {
    const bc = await parent.readContract({ address: C.sequencerInbox, abi: abi.si, functionName: "batchCount" });
    if (state.lastBatchCount === null || bc !== state.lastBatchCount) {
      state.lastBatchCount = bc;
      state.lastBatchChangeAt = Date.now();
      state.l3HeadAtLastBatch = l3Head;
    }
    const mins = (Date.now() - state.lastBatchChangeAt) / 60_000;
    const pending = l3Head !== null && state.l3HeadAtLastBatch !== null && l3Head > state.l3HeadAtLastBatch;
    add("batches", "Batch posting", !(pending && mins > CFG.unbatchedMaxMin), `batchCount ${bc}, last change ${mins.toFixed(0)} min ago${pending ? ", new L3 blocks waiting" : ""}`);
  });

  // operator ETH balances
  for (const [role, min] of Object.entries(CFG.minEth)) {
    await safe(`eth-${role}`, `${role} ETH balance`, async () => {
      const bal = await parent.getBalance({ address: ADDR[role] });
      add(`eth-${role}`, `${role} ETH balance`, bal >= min, `${formatEther(bal)} ETH (min ${formatEther(min)})`);
    });
  }

  // validator
  await safe("validator", "Validator staked", async () => {
    const staked = await parent.readContract({ address: C.rollup, abi: abi.rollup, functionName: "isStaked", args: [ADDR.validator] });
    const inGrace = (Date.now() - startedAt) / 3_600_000 < CFG.validatorGraceH;
    add("validator", "Validator staked", staked || inGrace, staked ? "staked" : `not staked yet${inGrace ? " (grace period)" : ""}`);
  });

  // keeper + pricer
  if (CFG.keeperHealth) await safe("keeper", "Keeper health", async () => {
    const r = await fetch(CFG.keeperHealth, { signal: AbortSignal.timeout(10_000) });
    const j = await r.json().catch(() => ({}));
    add("keeper", "Keeper health", r.ok, `HTTP ${r.status}${j.lastError ? `, last error: ${j.lastError.message}` : ""}${j.frozen ? `, frozen: ${j.frozen}` : ""}`);
  });
  await safe("pricer", "Pricer freshness", async () => {
    const [p, at, rate] = await Promise.all([
      parent.readContract({ address: dep.feeTokenPricer, abi: abi.pricer, functionName: "gmeUsd" }),
      parent.readContract({ address: dep.feeTokenPricer, abi: abi.pricer, functionName: "gmeUsdUpdatedAt" }),
      parent.readContract({ address: dep.feeTokenPricer, abi: abi.pricer, functionName: "currentRate" }),
    ]);
    const ageH = (Date.now() / 1000 - Number(at)) / 3600;
    add("pricer", "Pricer freshness", ageH < CFG.pricerMaxAgeH, `GME $${Number(formatEther(p)).toFixed(2)}, ${Number(formatEther(rate)).toFixed(2)} GME/ETH, updated ${ageH.toFixed(1)}h ago`);
  });
  await safe("eth-feed", "Chainlink ETH/USD", async () => {
    const [, ans, , upd] = await parent.readContract({ address: ADDR.ethUsdFeed, abi: abi.feed, functionName: "latestRoundData" });
    const ageH = (Date.now() / 1000 - Number(upd)) / 3600;
    add("eth-feed", "Chainlink ETH/USD", ans > 0n && ageH < 26, `$${(Number(ans) / 1e8).toFixed(2)}, ${ageH.toFixed(1)}h old`);
  });

  // GME issuer controls
  await safe("gme-paused", "GME not paused", async () => {
    const [p, tp, op, rp] = await Promise.all([
      parent.readContract({ address: GME_TOKEN, abi: abi.token, functionName: "paused" }),
      parent.readContract({ address: GME_TOKEN, abi: abi.token, functionName: "tokenPaused" }),
      parent.readContract({ address: GME_TOKEN, abi: abi.token, functionName: "oraclePaused" }),
      parent.readContract({ address: ADDR.registry, abi: abi.registry, functionName: "paused" }),
    ]);
    add("gme-paused", "GME not paused", !(p || tp || rp), `token ${p || tp}, registry ${rp}, oracle ${op}`);
  });
  await safe("bridge-blocked", "Bridge escrow not blocked", async () => {
    const [blocked, escrow] = await Promise.all([
      parent.readContract({ address: ADDR.registry, abi: abi.registry, functionName: "isBlocked", args: [C.bridge] }),
      parent.readContract({ address: GME_TOKEN, abi: abi.token, functionName: "balanceOf", args: [C.bridge] }),
    ]);
    add("bridge-blocked", "Bridge escrow not blocked", !blocked, `blocked ${blocked}, escrow ${formatEther(escrow)} GME`);
  });

  return checks;
}

async function tick() {
  const checks = await runChecks();
  lastReport = { ok: checks.every((c) => c.ok), checks, at: new Date().toISOString() };
  console.log(JSON.stringify({ t: lastReport.at, ok: lastReport.ok, failing: checks.filter((c) => !c.ok).map((c) => `${c.name}: ${c.detail}`) }));
  await reconcile(checks);
}

http
  .createServer((req, res) => {
    res.writeHead(200, { "content-type": "application/json" });
    res.end(JSON.stringify(lastReport, null, 2));
  })
  .listen(CFG.port, () => console.log(JSON.stringify({ msg: "monitor started", alerts: { telegram: !!process.env.TELEGRAM_BOT_TOKEN, discord: !!process.env.DISCORD_WEBHOOK_URL } })));

await notify("🟢 GME CHAIN monitor started");
await tick();
setInterval(() => tick().catch((e) => console.log(JSON.stringify({ msg: "tick error", err: e.message }))), CFG.intervalMs);
