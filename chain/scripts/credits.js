// GME CHAIN gas credits: turns $GMEC staking credits into gas on GME CHAIN.
//
//   GET  /info                   claim size, cost in credits, today's budget, redeemer
//   POST /claim {address, message, signature}
//
// A claim is signed by the wallet (a free message, no transaction) so nobody can spend someone
// else's credits. The service then:
//   1. checks creditsOf(user) on the staking contract (Robinhood Chain),
//   2. records the use on chain: spendCredits(user, cost, ref)  -- anyone can audit every claim,
//   3. sends the gas (native GME, or tGME on testnet) to the user on GME CHAIN.
// If step 3 fails after step 2, the claim is retried every minute until it is delivered.
// Limits: one claim per address per 24 h and a daily budget of gas for everyone together.
//
// Env: NETWORK, REDEEMER_PRIVATE_KEY / REDEEMER_ADDRESS (must be the staking contract's redeemer),
//      PARENT_RPC, L3_RPC, GAS_PER_CLAIM (GME, default 0.0005 mainnet / 0.01 testnet),
//      CREDITS_PER_CLAIM (token-days; required, e.g. 1000), DAILY_BUDGET (GME, default 50 claims' worth), PORT,
//      STATE_FILE (default /data/credits-state.json: last claims, today's spend and undelivered claims survive a restart)
import http from "node:http";
import fs from "node:fs";
import path from "node:path";
import { createPublicClient, createWalletClient, defineChain, http as viemHttp, parseAbi, parseEther, formatEther, isAddress, getAddress, keccak256, toHex, recoverMessageAddress } from "viem";
import { NETWORK, S, parentPublicClient as l2, walletClient, account, loadDeployment } from "./lib.js";

if (!["mainnet", "testnet"].includes(NETWORK)) throw new Error("Run with NETWORK=mainnet or testnet.");
const dep = loadDeployment();
const STAKING = process.env.STAKING_ADDRESS || dep.gmecStaking?.address; // STAKING_ADDRESS: fork rehearsal only
if (!STAKING) throw new Error("No staking contract in the deployment file.");
const L3_RPC = process.env.L3_RPC || (NETWORK === "testnet" ? "https://rpc.testnet.gmechain.xyz" : "https://rpc.gmechain.xyz");
const l3chain = defineChain({ id: S.chainId, name: S.chainName, nativeCurrency: { name: "GME", symbol: "GME", decimals: 18 }, rpcUrls: { default: { http: [L3_RPC] } } });
const l3 = createPublicClient({ chain: l3chain, transport: viemHttp(L3_RPC, { timeout: 60_000 }) });
const me = account("REDEEMER");
const l2w = walletClient("REDEEMER");
const l3w = createWalletClient({ account: me, chain: l3chain, transport: viemHttp(L3_RPC, { timeout: 60_000 }) });

// numbers are plain decimals like 1000 or 0.0005 (no thousands separators)
const num = (name, fallback) => {
  const v = (process.env[name] ?? fallback ?? "").trim();
  if (v === "") return null;
  if (!/^\d+(\.\d{1,18})?$/.test(v) || Number(v) <= 0) throw new Error(`${name}="${v}" is not a positive plain number (write 1000, not 1,000).`);
  return parseEther(v);
};
const GAS = num("GAS_PER_CLAIM", NETWORK === "testnet" ? "0.01" : "0.0005");
const COST = num("CREDITS_PER_CLAIM"); // credits are token-days, 18 decimals; unset = claims closed
const BUDGET = num("DAILY_BUDGET") ?? GAS * 50n;
const DAY = 24 * 3600 * 1000, MAX_AGE = 10 * 60 * 1000;
const PORT = Number(process.env.PORT || 8080);
const stakingAbi = parseAbi([
  "function creditsOf(address) view returns (uint256)",
  "function redeemer() view returns (address)",
  "function spendCredits(address user, uint256 amount, bytes32 ref)",
]);

const byAddr = new Map(); // address -> last claim time
let day = new Date().toISOString().slice(0, 10), spentToday = 0n;
const pending = []; // claims recorded on chain but not yet delivered
const STATE_FILE = process.env.STATE_FILE || "/data/credits-state.json";
try {
  const st = JSON.parse(fs.readFileSync(STATE_FILE, "utf8"));
  for (const [a, t] of st.byAddr || []) byAddr.set(a, t);
  if (st.day === day) spentToday = BigInt(st.spentToday || "0");
  pending.push(...(st.pending || []));
} catch (e) { if (e.code !== "ENOENT") console.error("could not read", STATE_FILE, e.message); }
const save = () => {
  try {
    fs.mkdirSync(path.dirname(STATE_FILE), { recursive: true });
    for (const [a, t] of byAddr) if (Date.now() - t > 24 * 3600 * 1000) byAddr.delete(a);
    const tmp = `${STATE_FILE}.tmp`;
    fs.writeFileSync(tmp, JSON.stringify({ day, spentToday: spentToday.toString(), byAddr: [...byAddr], pending }));
    fs.renameSync(tmp, STATE_FILE);
  } catch (e) { console.error("could not save", STATE_FILE, e.message); }
};
let queue = Promise.resolve(); // one claim at a time so nonces never collide

const log = (msg, extra = {}) => console.log(JSON.stringify({ t: new Date().toISOString(), msg, ...extra }));
const json = (res, code, body) => { res.writeHead(code, { "content-type": "application/json", "cache-control": "no-store" }); res.end(JSON.stringify(body)); };
const rollDay = () => { const d = new Date().toISOString().slice(0, 10); if (d !== day) { day = d; spentToday = 0n; } };

/** The exact text the website asks the wallet to sign. */
export const claimMessage = (address, issued) => `GME CHAIN gas claim\nAddress: ${address}\nChain: ${S.chainId}\nIssued: ${issued}`;

async function deliver(p) {
  const h = await l3w.sendTransaction({ to: p.address, value: GAS });
  const r = await l3.waitForTransactionReceipt({ hash: h });
  if (r.status !== "success") throw new Error(`gas transfer reverted ${h}`);
  return h;
}

async function claim(address) {
  rollDay();
  if (!COST) throw Object.assign(new Error("Gas claims are not open yet."), { code: 503 });
  if (spentToday + GAS > BUDGET) throw Object.assign(new Error("Today's gas budget is used up. Try again tomorrow."), { code: 429 });
  const last = byAddr.get(address) || 0;
  if (Date.now() - last < DAY) throw Object.assign(new Error("This wallet already claimed gas today."), { code: 429, retryAt: new Date(last + DAY).toISOString() });
  const [credits, redeemer, gasLeft] = await Promise.all([
    l2.readContract({ address: STAKING, abi: stakingAbi, functionName: "creditsOf", args: [address] }),
    l2.readContract({ address: STAKING, abi: stakingAbi, functionName: "redeemer" }),
    l3.getBalance({ address: me.address }),
  ]);
  if (redeemer.toLowerCase() !== me.address.toLowerCase()) throw Object.assign(new Error("Gas claims are not open yet."), { code: 503 });
  if (credits < COST) throw Object.assign(new Error(`You have ${formatEther(credits)} credits; a claim needs ${formatEther(COST)}. Keep staking to earn more.`), { code: 402 });
  if (gasLeft < GAS * 2n) throw Object.assign(new Error("The gas pool is being refilled. Try again later."), { code: 503 });

  const ref = keccak256(toHex(`${address}:${Date.now()}`));
  let sh;
  try {
    sh = await l2w.writeContract({ address: STAKING, abi: stakingAbi, functionName: "spendCredits", args: [address, COST, ref] });
    const sr = await l2.waitForTransactionReceipt({ hash: sh, timeout: 120_000 });
    if (sr.status !== "success") throw new Error(`spendCredits reverted ${sh}`);
  } catch (e) {
    log("spendCredits failed", { address, err: e.shortMessage || e.message, tx: sh || null });
    throw Object.assign(new Error("Recording the claim failed, so no credits were used. Try again in a minute."), { code: 502 });
  }
  // the daily limits count only claims whose credits were really spent
  byAddr.set(address, Date.now());
  spentToday += GAS;
  const p = { address, ref, spendTx: sh };
  pending.push(p); // saved before the gas is sent, so a restart cannot lose a claim whose credits were spent
  save();
  try {
    p.gasTx = await deliver(p);
    pending.splice(pending.indexOf(p), 1);
    save();
  } catch (e) {
    log("delivery failed, queued for retry", { address, ref, err: e.shortMessage || e.message });
  }
  log("claim", { address, credits: formatEther(COST), gas: formatEther(GAS), spendTx: sh, gasTx: p.gasTx || null });
  return { address, credits: formatEther(COST), gas: formatEther(GAS), spendTx: sh, gasTx: p.gasTx || null, queued: !p.gasTx };
}

setInterval(() => {
  if (!pending.length) return;
  queue = queue.then(async () => {
    for (const p of [...pending]) {
      try { p.gasTx = await deliver(p); pending.splice(pending.indexOf(p), 1); save(); log("delivered after retry", { address: p.address, gasTx: p.gasTx }); }
      catch (e) { log("retry failed", { address: p.address, err: e.shortMessage || e.message }); }
    }
  }).catch(() => {});
}, 60_000);

http.createServer(async (req, res) => {
  try {
    if (req.method === "GET" && (req.url.startsWith("/info") || req.url.startsWith("/health"))) {
      rollDay();
      const [redeemer, gasLeft] = await Promise.all([
        l2.readContract({ address: STAKING, abi: stakingAbi, functionName: "redeemer" }).catch(() => null),
        l3.getBalance({ address: me.address }).catch(() => 0n),
      ]);
      const open = !!COST && redeemer?.toLowerCase() === me.address.toLowerCase() && gasLeft >= GAS * 2n; // same rule as a claim; the pot is filled from launchpad fee income only
      return json(res, 200, { ok: true, open, network: NETWORK, staking: STAKING, redeemer: me.address, gasPerClaim: formatEther(GAS), creditsPerClaim: COST ? formatEther(COST) : null, budgetLeftToday: formatEther(BUDGET > spentToday ? BUDGET - spentToday : 0n), poolGas: formatEther(gasLeft), pending: pending.length });
    }
    if (req.method !== "POST" || !req.url.startsWith("/claim")) return json(res, 404, { error: "not found" });
    let body = "";
    for await (const chunk of req) { body += chunk; if (body.length > 4000) return json(res, 413, { error: "too large" }); }
    let b;
    try { b = JSON.parse(body); } catch { return json(res, 400, { error: "Send JSON." }); }
    if (!isAddress(b.address || "") || typeof b.message !== "string" || typeof b.signature !== "string") return json(res, 400, { error: "Missing address, message or signature." });
    const address = getAddress(b.address);
    const m = /^GME CHAIN gas claim\nAddress: (0x[0-9a-fA-F]{40})\nChain: (\d+)\nIssued: (.+)$/.exec(b.message);
    if (!m || getAddress(m[1]) !== address || Number(m[2]) !== S.chainId) return json(res, 400, { error: "The signed message does not match." });
    const issued = Date.parse(m[3]);
    if (!issued || Math.abs(Date.now() - issued) > MAX_AGE) return json(res, 400, { error: "The signature expired. Try again." });
    // works for regular wallets and for smart accounts (ERC-1271 / EIP-7702) on Robinhood Chain
    let valid = await l2.verifyMessage({ address, message: b.message, signature: b.signature }).catch(() => false);
    // an EIP-7702 smart account is still controlled by its own key: accept a plain signature from that key
    if (!valid && /^0x[0-9a-fA-F]{130}$/.test(b.signature)) valid = (await recoverMessageAddress({ message: b.message, signature: b.signature }).catch(() => null)) === address;
    if (!valid) return json(res, 401, { error: "The signature does not belong to this wallet." });
    let out;
    queue = queue.then(async () => { out = await claim(address); }).catch((e) => { out = { error: e.message, code: e.code || 500, retryAt: e.retryAt }; });
    await queue;
    if (out.error) return json(res, out.code, { error: out.error, retryAt: out.retryAt });
    return json(res, 200, out);
  } catch (e) {
    log("error", { err: e.message });
    return json(res, 500, { error: "Something went wrong. Try again in a minute." });
  }
}).listen(PORT, () => log("credits service started", { network: NETWORK, staking: STAKING, redeemer: me.address, gasPerClaim: formatEther(GAS), creditsPerClaim: COST ? formatEther(COST) : null }));
