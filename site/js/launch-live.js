// Launchpad: live chart, trades and holders for the selected token, read straight from GME CHAIN.
// Curve trades come from the launchpad's Trade events; after graduation, trades on the exchange pool come from
// the pair's Swap events; holders are rebuilt from the token's Transfer events. Only new blocks are fetched on
// each refresh. Everything written into the page goes through textContent (no HTML from the chain).
import { LAUNCHPAD, ACTIVE } from "./config.js";
import { viem, l3, fmt, short } from "./wallet.js";

const { parseAbiItem, parseAbi, getAddress } = viem;
const $ = (s, r = document) => r.querySelector(s);
const el = (tag, cls, text) => { const e = document.createElement(tag); if (cls) e.className = cls; if (text !== undefined) e.textContent = text; return e; };
const SYM = LAUNCHPAD.quoteSymbol === "GMEC" ? "$GMEC" : LAUNCHPAD.quoteSymbol;
const EXPLORER = ACTIVE === "mainnet" ? "/explorer" : "/explorer/testnet";
const PAD = LAUNCHPAD.address ? getAddress(LAUNCHPAD.address) : null;
const DEAD = "0x000000000000000000000000000000000000dEaD";
const ZERO = "0x0000000000000000000000000000000000000000";
const SUPPLY = 1_000_000_000;
const CURVE = 800_000_000n * 10n ** 18n;
const REFRESH_MS = 6000;

const TradeEv = parseAbiItem("event Trade(address indexed token, address indexed trader, bool isBuy, uint256 quoteAmount, uint256 tokenAmount, uint256 fee, uint256 vQuote, uint256 vToken)");
const SwapEv = parseAbiItem("event Swap(address indexed sender, uint256 amount0In, uint256 amount1In, uint256 amount0Out, uint256 amount1Out, address indexed to)");
const TransferEv = parseAbiItem("event Transfer(address indexed from, address indexed to, uint256 value)");
const pairAbi = parseAbi(["function token0() view returns (address)"]);

const num = (wei) => Number(wei) / 1e18;
// plain decimals people can read (0.0000625), scientific notation only for truly tiny prices
const fmtPrice = (p) => (!p ? "0" : p < 1e-9 ? p.toExponential(3) : p.toLocaleString("en-US", { maximumSignificantDigits: 4, maximumFractionDigits: 12 }));
const ago = (ts) => { const s = Math.max(0, Math.floor(Date.now() / 1000 - ts)); return s < 60 ? `${s}s ago` : s < 3600 ? `${Math.floor(s / 60)}m ago` : s < 86400 ? `${Math.floor(s / 3600)}h ago` : `${Math.floor(s / 86400)}d ago`; };

const card = $("[data-lp-live]");
const stores = new Map(); // token address -> collected data
const blockTime = new Map(); // block number -> unix time
let current = null, tab = "trades", timer = null, busy = false;

async function times(blocks) {
  const missing = [...new Set(blocks)].filter((b) => !blockTime.has(b));
  for (let i = 0; i < missing.length; i += 20) {
    const part = missing.slice(i, i + 20);
    const got = await Promise.all(part.map((b) => l3.getBlock({ blockNumber: b }).catch(() => null)));
    got.forEach((blk, j) => { if (blk) blockTime.set(part[j], Number(blk.timestamp)); });
  }
}

function storeFor(t) {
  if (!stores.has(t.address)) stores.set(t.address, { trades: [], balances: new Map(), next: BigInt(LAUNCHPAD.fromBlock || 0), token0IsToken: null });
  return stores.get(t.address);
}

async function collect(t) {
  const s = storeFor(t);
  const head = await l3.getBlockNumber();
  if (head < s.next) return s;
  const range = { fromBlock: s.next, toBlock: head };
  const pair = t.pair && t.pair !== ZERO ? getAddress(t.pair) : null;
  const [curve, transfers, swaps] = await Promise.all([
    l3.getLogs({ address: PAD, event: TradeEv, args: { token: t.address }, ...range }),
    l3.getLogs({ address: t.address, event: TransferEv, ...range }),
    t.graduated && pair ? l3.getLogs({ address: pair, event: SwapEv, ...range }) : Promise.resolve([]),
  ]);
  if (swaps.length && s.token0IsToken === null) {
    const t0 = await l3.readContract({ address: pair, abi: pairAbi, functionName: "token0" });
    s.token0IsToken = t0.toLowerCase() === t.address.toLowerCase();
  }
  await times([...curve, ...swaps].map((l) => l.blockNumber));
  for (const l of curve) {
    const a = l.args;
    s.trades.push({ key: `${l.transactionHash}:${l.logIndex}`, block: l.blockNumber, idx: l.logIndex, time: blockTime.get(l.blockNumber) || 0, tx: l.transactionHash,
      buy: a.isBuy, quote: a.quoteAmount, amount: a.tokenAmount, price: num(a.vQuote) / num(a.vToken), trader: a.trader, venue: "curve" });
  }
  for (const l of swaps) {
    const a = l.args, t0 = s.token0IsToken;
    const tokIn = t0 ? a.amount0In : a.amount1In, tokOut = t0 ? a.amount0Out : a.amount1Out;
    const qIn = t0 ? a.amount1In : a.amount0In, qOut = t0 ? a.amount1Out : a.amount0Out;
    const buy = tokOut > 0n;
    const amount = buy ? tokOut : tokIn, quote = buy ? qIn : qOut;
    if (amount === 0n) continue;
    s.trades.push({ key: `${l.transactionHash}:${l.logIndex}`, block: l.blockNumber, idx: l.logIndex, time: blockTime.get(l.blockNumber) || 0, tx: l.transactionHash,
      buy, quote, amount, price: num(quote) / num(amount), trader: a.to, venue: "pool" });
  }
  s.trades.sort((x, y) => (x.block === y.block ? x.idx - y.idx : x.block < y.block ? -1 : 1));
  for (const l of transfers) {
    const { from, to, value } = l.args;
    if (from !== ZERO) s.balances.set(from, (s.balances.get(from) || 0n) - value);
    s.balances.set(to, (s.balances.get(to) || 0n) + value);
  }
  s.next = head + 1n;
  return s;
}

// ---------------------------------------------------------------- chart
function drawChart(t, s) {
  const svg = $("[data-live-chart]", card);
  const W = 600, H = 220, P = { l: 8, r: 8, t: 14, b: 22 };
  svg.replaceChildren();
  const startPrice = num(t.target) / (4 * num(CURVE)); // the curve's first price
  const pts = [{ time: t.createdAt || (s.trades[0]?.time ?? 0), price: startPrice }, ...s.trades.map((x) => ({ time: x.time, price: x.price }))];
  const last = pts[pts.length - 1].price;
  const change = startPrice ? ((last - startPrice) / startPrice) * 100 : 0;
  $("[data-live-price]", card).textContent = `${fmtPrice(last)} ${SYM}`;
  const ch = $("[data-live-change]", card);
  ch.textContent = `${change >= 0 ? "+" : ""}${change.toFixed(2)}% since launch`;
  ch.dataset.kind = change >= 0 ? "ok" : "bad";
  const prices = pts.map((p) => p.price);
  const hi = Math.max(...prices), lo = Math.min(...prices);
  $("[data-live-hl]", card).textContent = `High ${fmtPrice(hi)} · Low ${fmtPrice(lo)} · ${s.trades.length} trade${s.trades.length === 1 ? "" : "s"}`;
  const t0 = pts[0].time, t1 = Math.max(pts[pts.length - 1].time, t0 + 1);
  const span = hi - lo || hi * 0.1 || 1;
  const yMin = lo - span * 0.12, yMax = hi + span * 0.12;
  const x = (p, i) => (t1 > t0 ? P.l + ((p.time - t0) / (t1 - t0)) * (W - P.l - P.r) : P.l + (i / Math.max(1, pts.length - 1)) * (W - P.l - P.r));
  const y = (v) => P.t + (1 - (v - yMin) / (yMax - yMin)) * (H - P.t - P.b);
  const NS = "http://www.w3.org/2000/svg";
  const mk = (tag, attrs) => { const e = document.createElementNS(NS, tag); for (const [k, v] of Object.entries(attrs)) e.setAttribute(k, v); return e; };
  // step line: the price holds until the next trade
  let d = "";
  pts.forEach((p, i) => { const X = x(p, i), Y = y(p.price); d += i === 0 ? `M${X},${Y}` : `H${X}V${Y}`; });
  d += `H${W - P.r}`;
  const up = last >= startPrice;
  const color = up ? "#3ddc97" : "#ff6b6b";
  svg.append(
    mk("path", { d: `${d}V${H - P.b}H${P.l}Z`, fill: color, "fill-opacity": "0.08", stroke: "none" }),
    mk("path", { d, fill: "none", stroke: color, "stroke-width": "2", "vector-effect": "non-scaling-stroke" }),
    mk("line", { x1: P.l, x2: W - P.r, y1: y(startPrice), y2: y(startPrice), stroke: "rgba(255,255,255,.18)", "stroke-dasharray": "3 4" }),
  );
  const label = (txt, X, anchor) => { const e = mk("text", { x: X, y: H - 6, fill: "rgba(255,255,255,.45)", "font-size": "10", "text-anchor": anchor, "font-family": "monospace" }); e.textContent = txt; svg.append(e); };
  const when = (ts) => new Date(ts * 1000).toLocaleString(undefined, { month: "short", day: "numeric", hour: "2-digit", minute: "2-digit" });
  if (pts[0].time) { label(when(t0), P.l, "start"); label(when(t1), W - P.r, "end"); }
  svg.setAttribute("aria-label", `Price of $${t.symbol} in ${SYM}: ${fmtPrice(last)} now, ${change.toFixed(2)}% since launch, high ${fmtPrice(hi)}, low ${fmtPrice(lo)}.`);
  // hover: nearest point
  const cross = mk("line", { y1: P.t, y2: H - P.b, stroke: "rgba(255,255,255,.35)", visibility: "hidden" });
  const dot = mk("circle", { r: "3.5", fill: color, visibility: "hidden" });
  svg.append(cross, dot);
  const tip = $("[data-live-tip]", card);
  svg.onmousemove = (e) => {
    const r = svg.getBoundingClientRect();
    const mx = ((e.clientX - r.left) / r.width) * W;
    let best = 0, bd = Infinity;
    pts.forEach((p, i) => { const dd = Math.abs(x(p, i) - mx); if (dd < bd) { bd = dd; best = i; } });
    const p = pts[best], X = x(p, best), Y = y(p.price);
    cross.setAttribute("x1", X); cross.setAttribute("x2", X); dot.setAttribute("cx", X); dot.setAttribute("cy", Y);
    cross.setAttribute("visibility", "visible"); dot.setAttribute("visibility", "visible");
    tip.textContent = `${fmtPrice(p.price)} ${SYM}${p.time ? ` · ${when(p.time)}` : ""}${best === 0 ? " · launch price" : ""}`;
  };
  svg.onmouseleave = () => { cross.setAttribute("visibility", "hidden"); dot.setAttribute("visibility", "hidden"); tip.textContent = ""; };
}

// ---------------------------------------------------------------- trades + holders
const link = (href, text, title) => { const a = el("a", "link", text); a.href = href; if (title) a.title = title; return a; };

function drawTrades(t, s) {
  const body = $("[data-live-rows]", card);
  const head = $("[data-live-head]", card);
  head.replaceChildren(...["Time", "Type", SYM, `$${t.symbol}`, "Price", "Trader", "Tx"].map((h) => el("th", "", h)));
  body.replaceChildren();
  const rows = [...s.trades].reverse().slice(0, 60);
  if (!rows.length) { const tr = el("tr"); const td = el("td", "empty", "No trades yet. The first buy starts the chart."); td.colSpan = 7; tr.append(td); body.append(tr); return; }
  for (const r of rows) {
    const tr = el("tr");
    const typeTd = el("td");
    typeTd.append(el("span", `pill ${r.buy ? "ok" : "bad"}`, r.buy ? "Buy" : "Sell"));
    tr.append(
      el("td", "mono", r.time ? ago(r.time) : "—"),
      typeTd,
      el("td", "mono", fmt(r.quote, 2)),
      el("td", "mono", fmt(r.amount, 0)),
      el("td", "mono", fmtPrice(num(r.quote) / Math.max(num(r.amount), 1e-18))),
    );
    const trd = el("td", "mono"); trd.append(link(`${EXPLORER}/address/${r.trader}`, short(r.trader), r.trader)); tr.append(trd);
    const txd = el("td", "mono"); txd.append(link(`${EXPLORER}/tx/${r.tx}`, `${r.tx.slice(0, 8)}…`, r.venue === "pool" ? "on the exchange pool" : "on the bonding curve")); tr.append(txd);
    body.append(tr);
  }
}

function drawHolders(t, s) {
  const body = $("[data-live-rows]", card);
  const head = $("[data-live-head]", card);
  head.replaceChildren(...["#", "Holder", "Amount", "Share"].map((h) => el("th", "", h)));
  body.replaceChildren();
  const pair = t.pair ? t.pair.toLowerCase() : "";
  const labelOf = (a) => (a.toLowerCase() === PAD.toLowerCase() ? "Bonding curve" : a.toLowerCase() === pair ? "Exchange pool" : a.toLowerCase() === DEAD.toLowerCase() ? "Burned" : null);
  const list = [...s.balances.entries()].filter(([, v]) => v > 0n).sort((a, b) => (a[1] < b[1] ? 1 : -1));
  const wallets = list.filter(([a]) => !labelOf(a)).length;
  $("[data-live-holders-count]", card).textContent = `${wallets} holder${wallets === 1 ? "" : "s"}`;
  list.slice(0, 50).forEach(([addr, v], i) => {
    const tr = el("tr");
    const who = el("td", "mono"); const lab = labelOf(addr);
    who.append(link(`${EXPLORER}/address/${addr}`, lab || short(addr), addr));
    if (t.creator && addr.toLowerCase() === t.creator.toLowerCase()) who.append(el("span", "pill", "creator"));
    const pct = (num(v) / SUPPLY) * 100;
    tr.append(el("td", "mono", String(i + 1)), who, el("td", "mono", fmt(v, 0)), el("td", "mono", `${pct < 0.01 ? "<0.01" : pct.toFixed(2)}%`));
    body.append(tr);
  });
}

function draw() {
  if (!current) return;
  const s = stores.get(current.address); if (!s) return;
  drawChart(current, s);
  if (tab === "trades") drawTrades(current, s); else drawHolders(current, s);
  $("[data-live-updated]", card).textContent = `Live · updated ${new Date().toLocaleTimeString()}`;
}

async function refresh() {
  if (!current || busy || document.hidden) return;
  busy = true;
  try { await collect(current); draw(); }
  catch (e) { $("[data-live-updated]", card).textContent = "Could not reach GME CHAIN. Retrying…"; console.warn(e); }
  finally { busy = false; }
}

/** Show the live panel for a token (from launch.js). Calling it again with fresh token data updates graduation etc. */
export function showLive(t) {
  if (!card || !PAD || !t) return;
  const changed = !current || current.address !== t.address;
  current = t;
  card.hidden = false;
  $("[data-live-name]", card).textContent = `$${t.symbol}`;
  if (changed) {
    $("[data-live-price]", card).textContent = "…";
    $("[data-live-rows]", card).replaceChildren();
    $("[data-live-chart]", card).replaceChildren();
  }
  refresh().catch((e) => console.warn(e));
  if (!timer) timer = setInterval(() => { refresh().catch((e) => console.warn(e)); }, REFRESH_MS);
}
/** Fetch new events now (after the user's own trade). */
export function refreshLive() { return refresh(); }

if (card) {
  card.querySelectorAll("[data-live-tab]").forEach((b) => b.addEventListener("click", () => {
    tab = b.dataset.liveTab;
    card.querySelectorAll("[data-live-tab]").forEach((x) => { const on = x === b; x.setAttribute("aria-selected", String(on)); x.tabIndex = on ? 0 : -1; });
    $("[data-live-holders-count]", card).hidden = tab !== "holders";
    draw();
  }));
  document.addEventListener("visibilitychange", () => { if (!document.hidden) refresh().catch((e) => console.warn(e)); });
}
