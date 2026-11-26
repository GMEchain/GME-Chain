// Live GME price for the whole site, read straight from the market every 15 seconds:
// the Uniswap v3 GME/USDG 1% pool on Robinhood Chain (the deepest GME pool, the same one the price keeper
// samples), converted to USD with the Chainlink USDG/USD feed. Falls back to the mainnet fee pricer once it exists.
// Read-only; works before GME CHAIN launches.
import { PRICE_SOURCE } from "./config.js";

const USDG_USD_FEED = "0x61B7e5650328764B076A108EFF5fa7282a1B9aD2"; // Chainlink USDG / USD
const MIN_LIQUIDITY = 100000000000000000n; // same floor as the keeper
const SEL = { slot0: "0x3850c7bd", liquidity: "0x1a686502", latestRoundData: "0xfeaf968c", gmeUsd: "0x0b76ea39" };
const EVERY_MS = 15_000;

async function batch(calls) {
  const body = JSON.stringify(calls.map(([to, data], id) => ({ jsonrpc: "2.0", id, method: "eth_call", params: [{ to, data }, "latest"] })));
  for (const url of PRICE_SOURCE.rpcs) {
    try {
      const r = await fetch(url, { method: "POST", headers: { "content-type": "application/json" }, body, signal: AbortSignal.timeout(10_000) });
      const out = await r.json();
      if (!Array.isArray(out)) continue;
      const byId = new Map(out.map((x) => [x.id, x]));
      if (calls.every((_, i) => byId.get(i)?.result)) return calls.map((_, i) => byId.get(i).result);
    } catch { /* next RPC */ }
  }
  throw new Error("price RPC unavailable");
}

// int24 tick from the second word of slot0
function tickOf(slot0) {
  let t = BigInt("0x" + slot0.slice(2 + 64, 2 + 128)) & 0xffffffn;
  if (t >= 0x800000n) t -= 0x1000000n;
  return Number(t);
}

async function fromPool() {
  const [slot0, liq, round] = await batch([
    [PRICE_SOURCE.pool, SEL.slot0],
    [PRICE_SOURCE.pool, SEL.liquidity],
    [USDG_USD_FEED, SEL.latestRoundData],
  ]);
  if (BigInt(liq) < MIN_LIQUIDITY) throw new Error("pool not usable");
  // token0 = GME (18 decimals), token1 = USDG (6 decimals): 1.0001^tick = USDG_raw per GME_raw
  const usdgPerGme = 1.0001 ** tickOf(slot0) * 1e12;
  const usdgUsd = Number(BigInt("0x" + round.slice(2 + 64, 2 + 128))) / 1e8; // answer, the 2nd word
  const usd = (usdgUsd > 0.98 && usdgUsd < 1.02 ? usdgUsd : 1) * usdgPerGme;
  if (!(usd > 0 && Number.isFinite(usd))) throw new Error("bad pool price");
  return usd;
}

async function fromPricer() {
  if (!PRICE_SOURCE.pricer) throw new Error("no pricer yet");
  const [h] = await batch([[PRICE_SOURCE.pricer, SEL.gmeUsd]]);
  return Number(BigInt(h)) / 1e18;
}

let gmeUsd = null;
const listeners = new Set();
/** Calls fn(price) now (if known) and on every update. */
export function onGmePrice(fn) { listeners.add(fn); if (gmeUsd !== null) fn(gmeUsd); }

async function tick() {
  let p = null;
  try { p = await fromPool(); } catch { try { p = await fromPricer(); } catch { /* keep the last price */ } }
  if (p === null) return;
  gmeUsd = p;
  const t = `$${p.toFixed(2)}`;
  document.querySelectorAll("[data-app-price], [data-live='gmeusd']").forEach((el) => { el.textContent = t; });
  listeners.forEach((fn) => fn(p));
}
tick().catch((e) => console.warn(e));
setInterval(() => { if (!document.hidden) tick().catch((e) => console.warn(e)); }, EVERY_MS);
document.addEventListener("visibilitychange", () => { if (!document.hidden) tick().catch((e) => console.warn(e)); });
