// GME CHAIN Explorer. Reads the chain straight from its RPC (batched JSON-RPC), no indexer yet.
// Routes (clean URLs, served by Caddy try_files):
//   /explorer/[testnet/]                 home: scoreboard, stage select, live blocks and moves
//   /explorer/[testnet/]block/<n|hash>   block detail
//   /explorer/[testnet/]tx/<hash>        transaction detail
//   /explorer/[testnet/]address/<addr>   address detail
import { PROFILES, MAINNET_OPEN } from "./config.js";
const warn = (e) => console.warn(e); // background refreshes: log failures instead of leaving promises unhandled

const stripEnd = (s, c) => { let i = s.length; while (i > 0 && s[i - 1] === c) i--; return s.slice(0, i); }; // trailing-char trim without a regex
const path = stripEnd(location.pathname, "/");
const NET = /\/explorer\/testnet(\/|$)/.test(path + "/") ? "testnet" : "mainnet";
const P = PROFILES[NET];
const BASE = NET === "testnet" ? "/explorer/testnet" : "/explorer";
const RPC = P.L3.rpc, TOKEN = P.TOKEN;
const SCAN_MAX = 3000; // how many recent blocks the stats and address history look at
const $ = (s, r = document) => r.querySelector(s);
const app = $("#explorer");

// ---------- labels for well-known addresses and Arbitrum system transactions ----------
const KNOWN = {
  "0x0000000000000000000000000000000000000064": "ArbSys (precompile)",
  "0x00000000000000000000000000000000000a4b05": "ArbOS (system)",
  "0x00000000000000000000000000000000000000c8": "NodeInterface",
  ...(P.DEX ? {
    [P.DEX.wrappedGme.toLowerCase()]: `Wrapped ${TOKEN}`,
    [P.DEX.factory.toLowerCase()]: "Exchange factory",
    [P.DEX.router.toLowerCase()]: "Exchange router",
    ...(P.DEX.testUsd ? { [P.DEX.testUsd.toLowerCase()]: "tUSD (test token)" } : {}),
    ...(P.DEX.usdg ? { [P.DEX.usdg.toLowerCase()]: "USDG (bridged)" } : {}),
    ...(P.DEX.usdgPair ? { [P.DEX.usdgPair.toLowerCase()]: `${TOKEN}/USDG pool` } : {}),
  } : {}),
};
const TX_TYPES = { "0x0": "legacy", "0x1": "access list", "0x2": "EIP-1559", "0x64": "deposit", "0x65": "unsigned", "0x66": "contract", "0x68": "retry", "0x69": "retryable", "0x6a": "system" };
const SYSTEM = new Set(["0x6a"]);
const SELECTORS = {
  "0xa9059cbb": "transfer", "0x095ea7b3": "approve", "0x23b872dd": "transferFrom", "0xd0e30db0": "wrap", "0x2e1a7d4d": "unwrap",
  "0x7ff36ab5": "swap", "0x18cbafe5": "swap", "0x38ed1739": "swap", "0xf305d719": "add liquidity", "0xe8e33700": "add liquidity",
  "0x02751cec": "remove liquidity", "0xbaa2abde": "remove liquidity", "0x25e16063": "withdraw to Robinhood Chain", "0x6b46cdb0": "drip",
};

// ---------- RPC ----------
let rid = 0;
async function rpc(method, params = []) {
  const r = await fetch(RPC, { method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify({ jsonrpc: "2.0", id: ++rid, method, params }), signal: AbortSignal.timeout(15000) });
  const j = await r.json();
  if (j.error) throw new Error(j.error.message);
  return j.result;
}
async function batch(calls) {
  const out = [];
  for (let i = 0; i < calls.length; i += 100) {
    const chunk = calls.slice(i, i + 100).map(([method, params], k) => ({ jsonrpc: "2.0", id: i + k, method, params }));
    const r = await fetch(RPC, { method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify(chunk), signal: AbortSignal.timeout(30000) });
    const j = await r.json();
    j.sort((a, b) => a.id - b.id).forEach((x) => out.push(x.result));
  }
  return out;
}

// ---------- formatting ----------
const hexN = (h) => (h == null ? 0 : Number(BigInt(h)));
const big = (h) => (h == null ? 0n : BigInt(h));
const esc = (s) => String(s).replace(/[&<>"']/g, (c) => ({ "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;", "'": "&#39;" }[c]));
const short = (h, a = 6, b = 4) => (h ? `${h.slice(0, a + 2)}…${h.slice(-b)}` : "—");
const ago = (ts) => { const s = Math.max(0, Math.floor(Date.now() / 1000 - ts)); return s < 60 ? `${s}s ago` : s < 3600 ? `${Math.floor(s / 60)}m ago` : s < 86400 ? `${Math.floor(s / 3600)}h ago` : `${Math.floor(s / 86400)}d ago`; };
function units(wei, dp = 6) {
  const neg = wei < 0n; let w = neg ? -wei : wei;
  const i = w / 10n ** 18n, f = stripEnd((w % 10n ** 18n).toString().padStart(18, "0").slice(0, dp), "0");
  return (neg ? "-" : "") + i.toLocaleString("en-US") + (f ? "." + f : "");
}
const tiny = (x) => { if (x === 0) return "0"; const e = Math.floor(Math.log10(x)); return e < -4 ? `0.0<sub>${-e - 1}</sub>${Math.round(x * 10 ** (-e + 1))}` : x.toLocaleString("en-US", { maximumSignificantDigits: 3 }); };
const label = (a) => (a ? KNOWN[a.toLowerCase()] : null);
// Hashes and addresses from the RPC are rebuilt from their numeric value, so only hex digits are ever rendered.
const hx = (h, len = 64) => { try { return "0x" + BigInt(h).toString(16).padStart(len, "0"); } catch { return "0x"; } };
const addrLink = (a) => { if (!a) return `<span class="muted">contract creation</span>`; const A = hx(a, 40); return `<a class="hx" href="${BASE}/address/${A}" title="${A}">${esc(label(A) || short(A))}</a>`; };
const txLink = (h, a = 6) => { const H = hx(h); return `<a class="hx" href="${BASE}/tx/${H}" title="${H}">${short(H, a, 6)}</a>`; };
const typeName = (t) => TX_TYPES[t] || `type ${Number(t)}`;
const blkLink = (n) => `<a class="hx" href="${BASE}/block/${n}">#${Number(n).toLocaleString("en-US")}</a>`;
function method(tx) {
  if (TX_TYPES[tx.type] && !["legacy", "access list", "EIP-1559"].includes(TX_TYPES[tx.type])) return TX_TYPES[tx.type];
  if (!tx.to) return "deploy";
  if (!tx.input || tx.input === "0x") return "transfer";
  return SELECTORS[tx.input.slice(0, 10)] || "contract call";
}

// Mainnet only, until about 2026-12-05: claims made under the old 7-day window keep it (same note as the bridge).
{ const n = document.querySelector("[data-window-transition]"); if (n) n.hidden = !(NET === "mainnet" && Date.now() < Date.UTC(2026, 11, 6)); }

// ---------- chrome: network toggle + search ----------
function chrome() {
  const toggle = $("[data-net-toggle]");
  if (toggle) {
    const rest = path.replace(/^\/explorer(\/testnet)?/, "");
    toggle.innerHTML = `
      <a class="${NET === "mainnet" ? "on" : ""}"><i></i>Mainnet <em>${MAINNET_OPEN ? "live" : "soon"}</em></a>
      <a class="${NET === "testnet" ? "on" : ""}"><i></i>Testnet <em>live</em></a>`;
    const [toMain, toTest] = toggle.querySelectorAll("a"); // hrefs set as properties, never parsed as HTML
    toMain.href = `/explorer${rest}`; toTest.href = `/explorer/testnet${rest}`;
  }
  $("[data-net-name]").textContent = P.L3.name;
  const f = $("[data-search]");
  f.addEventListener("submit", (e) => {
    e.preventDefault();
    const q = f.q.value.trim();
    const msg = $("[data-search-msg]");
    if (/^0x[0-9a-fA-F]{64}$/.test(q)) return go(`/tx/${q}`);
    if (/^0x[0-9a-fA-F]{40}$/.test(q)) return go(`/address/${q}`);
    if (/^#?\d+$/.test(q)) return go(`/block/${q.replace("#", "")}`);
    msg.textContent = "Search by a transaction hash, an address or a block number.";
  });
}
const go = (p) => { location.href = BASE + p; };

// ---------- views ----------
// Arcade look: a scoreboard with zero-padded counters, a stage-select grid of blocks, and two CRT screens
// (blocks as a high-score table, transactions as a move log) that update live as new blocks arrive.
const pad6 = (n) => { const s = Number(n).toLocaleString("en-US"), z = Math.max(0, 6 - String(n).length); return `<i>${"0".repeat(z)}</i>${s}`; };
const screen = (title, sub, body, attrs = "") => `<section class="crt" ${attrs}><header class="crt-h"><h2>${title}</h2><span>${sub}</span></header>${body}</section>`;
const blockRow = (b, userTx, fresh) => `
  <li class="${fresh ? "new" : ""}">${blkLink(hexN(b.number))}<span class="lead" aria-hidden="true"></span>
  <b>${userTx(b).length} ${userTx(b).length === 1 ? "move" : "moves"}</b><small>${hexN(b.gasUsed).toLocaleString("en-US")} gas · ${ago(hexN(b.timestamp))}</small></li>`;
const moveRow = (t, ts, fresh) => `
  <li class="${fresh ? "new" : ""}"><span class="meth">${esc(method(t))}</span>${txLink(t.hash)}<small>${ago(ts)}</small>
  <span class="mid">${addrLink(t.from)} <span class="arrow">→</span> ${addrLink(t.to)}</span></li>`;

async function home() {
  app.innerHTML = `
    <dl class="ex-board" aria-label="Chain statistics">
      <div><dt>Level</dt><dd data-s="height"><i class="sk"></i></dd><small>block height</small></div>
      <div><dt>Moves</dt><dd data-s="txs"><i class="sk"></i></dd><small data-s="today">transactions</small></div>
      <div><dt>Players</dt><dd data-s="addrs"><i class="sk"></i></dd><small>addresses</small></div>
      <div><dt>Gas</dt><dd data-s="gas"><i class="sk"></i></dd><small>gas price</small></div>
      <div><dt>Cost</dt><dd data-s="cost"><i class="sk"></i></dd><small>one transfer</small></div>
      <div><dt>Spent</dt><dd data-s="spent"><i class="sk"></i></dd><small>paid as gas</small></div>
    </dl>
    ${screen("Stage select", "latest 48 blocks · brighter = more moves", `<div class="stage" data-heat></div>`, 'aria-label="Recent blocks by activity"')}
    <div class="ex-cols">
      ${screen("Blocks", `<b class="live" data-live-tag>live</b>`, `<ol class="hs" data-blocks><li class="empty">Reading the chain…</li></ol>`)}
      ${screen("Moves", "latest transactions", `<ol class="hs mv" data-txs><li class="empty">Reading the chain…</li></ol>`)}
    </div>
    <p class="ex-note">Live data from ${esc(P.L3.name)} over RPC, checked every few seconds. Totals cover the latest ${SCAN_MAX.toLocaleString("en-US")} blocks. The chain makes a block only when there is a transaction; "system" transactions are ArbOS bookkeeping and are not counted.</p>`;
  const userTx = (b) => b.transactions.filter((t) => !SYSTEM.has(t.type));
  const fetchBlocks = (hi, lo) => { const nums = []; for (let n = hi; n >= lo; n--) nums.push(n); return batch(nums.map((n) => ["eth_getBlockByNumber", ["0x" + n.toString(16), true]])).then((r) => r.filter(Boolean)); };
  const set = (k, v) => { const el = $(`[data-s="${k}"]`); if (el) el.innerHTML = v; };
  const [headHex, gasHex] = await Promise.all([rpc("eth_blockNumber"), rpc("eth_gasPrice")]);
  let head = hexN(headHex), gas = big(gasHex);
  let blocks = await fetchBlocks(head, Math.max(0, head - SCAN_MAX + 1));
  let seen = new Set(blocks.map((b) => hexN(b.number)));

  const render = (fresh = new Set()) => {
    let txs = 0, today = 0, spent = 0n; const addrs = new Set(); const dayAgo = Date.now() / 1000 - 86400;
    for (const b of blocks) spent += big(b.gasUsed) * big(b.baseFeePerGas || "0x0"); // Nitro has no tips: every fee is gas used x base fee
    for (const b of blocks) for (const t of userTx(b)) { txs++; if (hexN(b.timestamp) > dayAgo) today++; if (t.from) addrs.add(t.from.toLowerCase()); if (t.to) addrs.add(t.to.toLowerCase()); }
    set("height", pad6(head)); set("txs", pad6(txs)); set("addrs", pad6(addrs.size));
    set("today", `${today.toLocaleString("en-US")} today`);
    set("gas", `${(Number(gas) / 1e9).toLocaleString("en-US", { maximumSignificantDigits: 3 })}<small> gwei</small>`);
    set("cost", `${tiny(Number(gas * 21000n) / 1e18)}<small> ${TOKEN}</small>`);
    set("spent", `${tiny(Number(spent) / 1e18)}<small> ${TOKEN}</small>`);
    const last = blocks.slice(0, 48).reverse();
    const maxTx = Math.max(1, ...last.map((b) => userTx(b).length));
    const empty = Array.from({ length: Math.max(0, 48 - last.length) }, () => `<span class="tile off" aria-hidden="true"></span>`).join("");
    $("[data-heat]").innerHTML = empty + last.map((b) => { const n = hexN(b.number), k = userTx(b).length; return `<a class="tile${fresh.has(n) ? " new" : ""}" href="${BASE}/block/${n}" style="--a:${k ? 0.3 + 0.7 * (k / maxTx) : 0.06}" title="Block #${n} · ${k} tx"><span>${n}</span></a>`; }).join("");
    $("[data-blocks]").innerHTML = blocks.slice(0, 10).map((b) => blockRow(b, userTx, fresh.has(hexN(b.number)))).join("") || `<li class="empty">No blocks yet.</li>`;
    const recent = [];
    for (const b of blocks) { for (const t of userTx(b).reverse()) { recent.push({ t, ts: hexN(b.timestamp), n: hexN(b.number) }); if (recent.length >= 10) break; } if (recent.length >= 10) break; }
    $("[data-txs]").innerHTML = recent.map(({ t, ts, n }) => moveRow(t, ts, fresh.has(n))).join("") || `<li class="empty">No transactions yet.</li>`;
  };
  render();

  // live: poll the head; fetch only the new blocks and flash them in
  let busy = false;
  const poll = async () => {
    if (busy || document.hidden || !app.isConnected) return;
    busy = true;
    try {
      const [h, g] = await batch([["eth_blockNumber", []], ["eth_gasPrice", []]]);
      const nh = hexN(h); if (g) gas = big(g);
      if (nh > head) {
        const add = (await fetchBlocks(nh, Math.max(head + 1, nh - 49))).filter((b) => !seen.has(hexN(b.number)));
        add.forEach((b) => seen.add(hexN(b.number)));
        blocks = [...add, ...blocks].slice(0, SCAN_MAX); head = nh;
        render(new Set(add.map((b) => hexN(b.number))));
      } else render();
    } catch (e) { warn(e); } finally { busy = false; }
  };
  setInterval(poll, 5000);
}

async function blockView(id) {
  const b = /^0x[0-9a-fA-F]{64}$/.test(id) ? await rpc("eth_getBlockByHash", [id, true]) : await rpc("eth_getBlockByNumber", ["0x" + Number(id).toString(16), true]);
  if (!b) return notFound(`Block ${esc(id)} not found.`);
  const n = hexN(b.number);
  const rows = [
    ["Block", `#${n.toLocaleString("en-US")}`], ["Time", `${new Date(hexN(b.timestamp) * 1000).toLocaleString()} (${ago(hexN(b.timestamp))})`],
    ["Hash", `<code>${hx(b.hash)}</code>`], ["Parent", `<a class="hx" href="${BASE}/block/${Math.max(0, n - 1)}"><code>${hx(b.parentHash)}</code></a>`],
    ["Transactions", `${Number(b.transactions.length)} (${Number(b.transactions.filter((t) => !SYSTEM.has(t.type)).length)} user)`],
    ["Gas used", hexN(b.gasUsed).toLocaleString("en-US")], ["Base fee", b.baseFeePerGas ? `${Number(big(b.baseFeePerGas)) / 1e9} gwei` : "—"],
    ["Parent-chain block", b.l1BlockNumber ? hexN(b.l1BlockNumber).toLocaleString("en-US") : "—"],
  ];
  app.innerHTML = `${crumb("Block")}${headline("Level", `#${n.toLocaleString("en-US")}`)}${table(rows)}
    <nav class="ex-pager"><a class="btn btn-line btn-sm" href="${BASE}/block/${Math.max(0, n - 1)}">← #${Math.max(0, n - 1)}</a><a class="btn btn-line btn-sm" href="${BASE}/block/${n + 1}">#${n + 1} →</a></nav>
    ${screen("Moves in this block", `${Number(b.transactions.length)} total`, `<ol class="hs mv">${b.transactions.map((t) => moveRow(t, hexN(b.timestamp), false).replace("</li>", `<small class="val">${units(big(t.value), 4)} ${TOKEN}</small></li>`)).join("") || `<li class="empty">Empty block.</li>`}</ol>`)}`;
}

async function txView(hash) {
  const [t, r] = await Promise.all([rpc("eth_getTransactionByHash", [hash]), rpc("eth_getTransactionReceipt", [hash])]);
  if (!t) return notFound(`Transaction ${esc(short(hash))} not found.`);
  const b = t.blockNumber ? await rpc("eth_getBlockByNumber", [t.blockNumber, false]) : null;
  const ok = r ? r.status === "0x1" : null;
  const fee = r ? big(r.gasUsed) * big(r.effectiveGasPrice || t.gasPrice || "0x0") : 0n;
  const rows = [
    ["Hash", `<code>${hx(t.hash)}</code>`],
    ["Status", r ? (ok ? `<span class="ok-t">Success</span>` : `<span class="bad-t">Failed</span>`) : `<span class="muted">Pending</span>`],
    ["Block", t.blockNumber ? `${blkLink(hexN(t.blockNumber))}${b ? ` · ${new Date(hexN(b.timestamp) * 1000).toLocaleString()} (${ago(hexN(b.timestamp))})` : ""}` : "—"],
    ["Type", typeName(t.type) + (t.type === "0x64" ? " · GME bridged in from the parent chain" : "")],
    ["Method", esc(method(t))], ["From", addrLink(t.from) + (t.from ? ` <code class="dim">${hx(t.from, 40)}</code>` : "")], ["To", addrLink(t.to) + (t.to ? ` <code class="dim">${hx(t.to, 40)}</code>` : "")],
    ["Value", `${units(big(t.value), 8)} ${TOKEN}`], ["Fee", r ? `${units(fee, 10)} ${TOKEN}` : "—"],
    ["Gas used", r ? hexN(r.gasUsed).toLocaleString("en-US") : "—"], ["Logs", r ? String(Number(r.logs.length)) : "—"],
    ["Input", t.input && t.input !== "0x" ? `<code class="wrap">${hx(t.input.slice(0, 650), Number(t.input.slice(0, 650).length) - 2)}${Number(t.input.length) > 650 ? "…" : ""}</code>` : "—"],
  ];
  const result = r ? (ok ? "Clear" : "Miss") : "Pending";
  app.innerHTML = `${crumb("Transaction")}${headline(esc(method(t)), result, r ? (ok ? "ok" : "bad") : "")}${table(rows)}`;
}

async function addressView(addr) {
  const [bal, nonce, code, headHex] = await Promise.all([rpc("eth_getBalance", [addr, "latest"]), rpc("eth_getTransactionCount", [addr, "latest"]), rpc("eth_getCode", [addr, "latest"]), rpc("eth_blockNumber")]);
  const head = hexN(headHex), from = Math.max(0, head - SCAN_MAX + 1);
  const isContract = code && code !== "0x";
  const rows = [
    ["Address", `<code>${hx(addr, 40)}</code>`], ["Name", esc(label(addr) || (isContract ? "Contract" : "Account"))],
    ["Balance", `${units(big(bal), 8)} ${TOKEN}`], ["Transactions sent", hexN(nonce).toLocaleString("en-US")],
    ["Type", isContract ? `Contract (${((code.length - 2) / 2).toLocaleString("en-US")} bytes)` : "Externally owned account"],
  ];
  app.innerHTML = `${crumb(isContract ? "Contract" : "Player")}${headline(isContract ? "Contract" : "Player", esc(label(addr) || short(addr)))}${table(rows)}
    ${screen("Recent moves", `latest ${SCAN_MAX.toLocaleString("en-US")} blocks`, `<ol class="hs mv" data-hist><li class="empty">Scanning the latest blocks…</li></ol>`)}`;
  const nums = []; for (let n = head; n >= from; n--) nums.push(n);
  const blocks = (await batch(nums.map((n) => ["eth_getBlockByNumber", ["0x" + n.toString(16), true]]))).filter(Boolean);
  const a = addr.toLowerCase(), hist = [];
  for (const b of blocks) for (const t of b.transactions) if (!SYSTEM.has(t.type) && ((t.from || "").toLowerCase() === a || (t.to || "").toLowerCase() === a)) hist.push({ t, ts: hexN(b.timestamp) });
  $("[data-hist]").innerHTML = hist.slice(0, 50).map(({ t, ts }) => moveRow(t, ts, false).replace("</li>", `<small class="val">${(t.from || "").toLowerCase() === a ? "out" : "in"} · ${units(big(t.value), 4)} ${TOKEN}</small></li>`)).join("") || `<li class="empty">No transactions in the latest ${SCAN_MAX.toLocaleString("en-US")} blocks.</li>`;
}

const crumb = (t) => `<p class="ex-crumb"><a href="${BASE}/">Game log</a> <span>/</span> ${esc(t)}</p>`;
const headline = (k, v, cls = "") => `<div class="ex-head"><span>${k}</span><b class="${cls}">${v}</b></div>`;
const table = (rows) => `<section class="crt crt-sheet"><table class="ex-table"><tbody>${rows.map(([k, v]) => `<tr><th scope="row">${k}</th><td>${v}</td></tr>`).join("")}</tbody></table></section>`;
function notFound(msg) { app.innerHTML = `${crumb("Not found")}${headline("Game over", "Not found", "bad")}<p class="notice">${msg}</p>`; }

// ---------- router ----------
async function route() {
  chrome();
  const rest = path.replace(/^\/explorer(\/testnet)?/, "");
  const m = rest.match(/^\/(block|tx|address)\/([^/]+)$/);
  // Only well-formed ids reach the views, and they are rebuilt from numbers, so nothing typed in the URL is rendered.
  const ID_OK = { block: /^(\d{1,12}|0x[0-9a-fA-F]{64})$/, tx: /^0x[0-9a-fA-F]{64}$/, address: /^0x[0-9a-fA-F]{40}$/ };
  const hexOf = (s, len) => "0x" + BigInt(s).toString(16).padStart(len, "0");
  const CANON = { block: (s) => (s.startsWith("0x") ? hexOf(s, 64) : String(Number(s))), tx: (s) => hexOf(s, 64), address: (s) => hexOf(s, 40) };
  const kind = m ? m[1] : null;
  const id = m && ID_OK[kind].test(m[2]) ? CANON[kind](m[2]) : null;
  const notice = (title, text) => { const p = document.createElement("p"); p.className = "notice"; const b = document.createElement("b"); b.textContent = title; p.append(b, " ", text); app.replaceChildren(p); return p; };
  try {
    if (NET === "mainnet") {
      // before launch the explorer is the testnet one
      if (!MAINNET_OPEN) { location.replace(id ? `/explorer/testnet/${kind}/${id}` : "/explorer/testnet/"); return; }
      const alive = await rpc("eth_chainId").then(() => true).catch(() => false);
      if (!alive) {
        const p = notice("The mainnet node is not answering.", `${P.L3.name} will be back shortly. Meanwhile the testnet explorer works. `);
        const a = document.createElement("a"); a.href = id ? `/explorer/testnet/${kind}/${id}` : "/explorer/testnet/"; a.textContent = "Open the testnet explorer →"; p.append(a);
        return;
      }
    }
    if (m && !id) notFound("That is not a valid block, transaction or address.");
    else if (!m) await home();
    else if (kind === "block") await blockView(id);
    else if (kind === "tx") await txView(id);
    else await addressView(id);
  } catch (e) {
    notice(`Could not read ${P.L3.name}.`, e.message || String(e));
  }
}
route().catch(warn);
