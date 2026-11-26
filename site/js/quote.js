// Read-only helpers for Robinhood Chain (no wallet, no viem): batched eth_call over the public RPCs, the best
// Uniswap v3 ETH -> GME quote (QuoterV2), and the GME token's total supply. Used by the home page and the
// pre-launch panels.
import { PROFILES, UNISWAP } from "./config.js";

export const GME = PROFILES.mainnet.ADDR.gme;
const RPCS = PROFILES.mainnet.L2.rpcs;

export async function rpcBatch(calls, rpcs = RPCS) {
  const body = JSON.stringify(calls.map(([to, data], id) => ({ jsonrpc: "2.0", id, method: "eth_call", params: [{ to, data }, "latest"] })));
  for (const url of rpcs) {
    try {
      const r = await fetch(url, { method: "POST", headers: { "content-type": "application/json" }, body, signal: AbortSignal.timeout(10_000) });
      const out = await r.json();
      if (!Array.isArray(out)) continue;
      const byId = new Map(out.map((x) => [x.id, x]));
      if (calls.every((_, i) => byId.get(i)?.result)) return calls.map((_, i) => byId.get(i).result);
    } catch { /* next RPC */ }
  }
  throw new Error("Robinhood Chain RPC unavailable");
}

const hex = (n, bytes) => n.toString(16).padStart(bytes * 2, "0");
const addr = (a) => a.toLowerCase().replace("0x", "");
// Uniswap v3 path: token, (fee, token)...
function pathOf(route, from, to) {
  const tokens = route.via ? [from, UNISWAP[route.via], to] : [from, to];
  let p = addr(tokens[0]);
  route.hops.forEach((fee, i) => { p += hex(fee, 3) + addr(tokens[i + 1]); });
  return p;
}
// QuoterV2.quoteExactInput(bytes path, uint256 amountIn): selector cdca1753
function quoteCall(path, amount) {
  const len = path.length / 2;
  const padded = path.padEnd(Math.ceil(len / 32) * 64, "0");
  return "0xcdca1753" + hex(64n, 32) + hex(amount, 32) + hex(BigInt(len), 32) + padded;
}

/** Best GME output for `amountWei` of ETH over the configured routes: { out, route }. */
export async function bestEthToGme(amountWei) {
  const routes = UNISWAP.routes;
  const res = await Promise.allSettled(routes.map((r) => rpcBatch([[UNISWAP.quoterV2, quoteCall(pathOf(r, UNISWAP.weth, GME), amountWei)]])));
  let best = null;
  res.forEach((x, i) => {
    if (x.status !== "fulfilled") return;
    const out = BigInt("0x" + x.value[0].slice(2, 66));
    if (!best || out > best.out) best = { out, route: routes[i] };
  });
  if (!best) throw new Error("no route");
  return best;
}

/** Total GME on Robinhood Chain, in wei. */
export async function gmeSupply() {
  const [h] = await rpcBatch([[GME, "0x18160ddd"]]);
  return BigInt(h);
}

/** "0.05" -> 50000000000000000n; null when the text is not a positive amount. */
export function parseEth(text) {
  const t = String(text).replace(",", ".").trim();
  if (!/^\d*\.?\d*$/.test(t) || t === "" || t === ".") return null;
  const [i, f = ""] = t.split(".");
  const wei = BigInt(i || "0") * 10n ** 18n + BigInt((f + "0".repeat(18)).slice(0, 18) || "0");
  return wei > 0n ? wei : null;
}

export const fmtUnits = (wei, dp = 4) => (Number(wei) / 1e18).toLocaleString("en-US", { maximumFractionDigits: dp });
