// Home page: the ASCII cartridge, the gas shop quote (ETH -> GME from Uniswap), live chain numbers, the GME chart,
// code tabs, "Add network" and the Continue? countdown.
import { L3, L2, ADDR, TOKEN, ACTIVE, LIVE } from "./config.js";
import { onGmePrice } from "./gmeprice.js";
import { bestEthToGme, gmeSupply, parseEth, fmtUnits, rpcBatch } from "./quote.js";
import "./netui.js";
import { mountCartridge } from "./cartridge.js";

const stage = document.querySelector("[data-stage]");
if (stage) mountCartridge(stage);

const reduced = matchMedia("(prefers-reduced-motion: reduce)").matches;
const $ = (s, r = document) => r.querySelector(s);
const $$ = (s, r = document) => [...r.querySelectorAll(s)];
const TRANSFER_GAS = 28402n; // gas of a plain GME transfer on an Arbitrum Nitro chain (21,000 + L1 data)
const MIN_GAS_PRICE = 100_000_000n; // ArbOS minimum base fee, 0.1 gwei: the fee floor before launch
const EXPLORER = ACTIVE === "mainnet" ? "/explorer" : "/explorer/testnet";

// ---------- live values ----------
$$("[data-live], [data-market]").forEach((e) => { if (e.textContent.trim() === "…") { e.textContent = " "; e.classList.add("loading"); } });
function setLive(key, text, attr = "data-live") {
  $$(`[${attr}="${key}"]`).forEach((e) => {
    const was = e.classList.contains("loading");
    if (e.textContent === text && !was) return;
    e.textContent = text;
    e.classList.remove("loading");
    if (!was && !reduced) { e.classList.remove("tick"); void e.offsetWidth; e.classList.add("tick"); }
  });
}
const sig = (x, d = 2) => (x === 0 ? "0" : x.toLocaleString("en-US", { maximumSignificantDigits: d }));
const usd = (x) => (x < 0.0001 ? `$${x.toFixed(6)}` : x < 0.01 ? `$${sig(x, 2)}` : `$${x.toFixed(2)}`);

async function rpc(url, method, params = []) {
  const r = await fetch(url, { method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify({ jsonrpc: "2.0", id: 1, method, params }), signal: AbortSignal.timeout(8000) });
  const j = await r.json();
  if (j.error) throw new Error(j.error.message);
  return j.result;
}

let gasPrice = LIVE.chain ? null : MIN_GAS_PRICE, gmeUsd = null;
const feeGme = () => (gasPrice === null ? null : Number(gasPrice * TRANSFER_GAS) / 1e18);
function renderFee() {
  const f = feeGme();
  if (f === null) return;
  if (gmeUsd !== null) setLive("fee-usd", usd(f * gmeUsd));
  renderTicketTransfers();
}
onGmePrice((p) => { gmeUsd = p; setLive("gmeusd", `$${p.toFixed(2)}`); renderFee(); });

async function refreshL3() {
  if (!LIVE.chain) {
    setLive("block", "at launch"); setLive("validator", "at launch");
    setLive("gas", "0.1 gwei"); setLive("updated", `${L3.name} opens soon: fees use the 0.1 gwei floor it starts at.`);
    renderFee();
    return;
  }
  try {
    const [bh, gh] = await Promise.all([rpc(L3.rpc, "eth_blockNumber"), rpc(L3.rpc, "eth_gasPrice")]);
    gasPrice = BigInt(gh);
    setLive("block", `#${BigInt(bh).toLocaleString("en-US")}`);
    setLive("gas", `${sig(Number(gasPrice) / 1e9, 3)} gwei`);
    setLive("updated", `Updated ${new Date().toLocaleTimeString()}`);
    renderFee();
  } catch { setLive("block", "offline"); setLive("updated", "The GME CHAIN RPC did not answer. Retrying."); }
}

const pad = (a) => a.toLowerCase().replace("0x", "").padStart(64, "0");
async function refreshL2() {
  if (!LIVE.chain) { ["escrow", "batches"].forEach((k) => setLive(k, "at launch")); return; }
  const calls = [
    [ADDR.sequencerInbox, "0x06f13056"],                    // batchCount()
    [ADDR.gme, "0x70a08231" + pad(ADDR.bridge)],              // balanceOf(bridge)
    [ADDR.rollup, "0x6177fd18" + pad(ADDR.validator || "0x0")], // isStaked(validator)
  ];
  try {
    const [b, e, s] = await rpcBatch(calls, L2.rpcs);
    setLive("batches", BigInt(b).toLocaleString("en-US"));
    setLive("escrow", `${fmtUnits(BigInt(e), 2)} ${TOKEN}`);
    setLive("validator", BigInt(s) === 1n ? "Staked" : "Not staked yet");
  } catch { /* keep last values */ }
}
gmeSupply().then((s) => setLive("supply", `${fmtUnits(s, 0)} GME`, "data-market")).catch(() => setLive("supply", "unavailable", "data-market"));

// ---------- the order ticket ----------
const tkInput = $("#tk-eth"), tkOut = $("[data-tk-out]"), tkTx = $("[data-tk-tx]"), tkRoute = $("[data-tk-route]");
let tkGme = null;
function renderTicketTransfers() {
  const f = feeGme();
  if (!tkTx) return;
  tkTx.textContent = tkGme && f ? Math.floor(Number(tkGme) / 1e18 / f).toLocaleString("en-US") : "…";
}
let seq = 0;
async function quoteTicket() {
  const my = ++seq;
  const wei = parseEth(tkInput.value);
  if (!wei) { tkOut.textContent = "0"; tkGme = null; renderTicketTransfers(); return; }
  try {
    const b = await bestEthToGme(wei);
    if (my !== seq) return;
    tkGme = b.out;
    tkOut.textContent = fmtUnits(b.out, 4);
    if (!reduced) { tkOut.classList.remove("bump"); void tkOut.offsetWidth; tkOut.classList.add("bump"); }
    tkRoute.textContent = b.route.name;
    renderTicketTransfers();
  } catch {
    if (my === seq) { tkOut.textContent = "—"; tkRoute.textContent = "quote unavailable"; }
  }
}
if (tkInput) {
  let t;
  tkInput.addEventListener("input", () => {
    tkInput.value = tkInput.value.replace(",", ".").replace(/[^0-9.]/g, "");
    $$("[data-tk-amt]").forEach((b) => b.setAttribute("aria-pressed", String(b.dataset.tkAmt === tkInput.value)));
    clearTimeout(t); t = setTimeout(quoteTicket, 350);
  });
  $$("[data-tk-amt]").forEach((b) => b.addEventListener("click", () => {
    tkInput.value = b.dataset.tkAmt;
    $$("[data-tk-amt]").forEach((x) => x.setAttribute("aria-pressed", String(x === b)));
    quoteTicket();
  }));
  quoteTicket();
}

// ---------- GME market chart (TradingView, loaded when scrolled near) ----------
const tv = $("[data-tv-chart]");
if (tv) {
  const load = () => {
    if (tv.dataset.loaded) return;
    tv.dataset.loaded = "1";
    const sc = document.createElement("script");
    sc.src = "https://s3.tradingview.com/external-embedding/embed-widget-advanced-chart.js";
    sc.async = true;
    sc.textContent = JSON.stringify({ autosize: true, symbol: "NYSE:GME", interval: "D", timezone: "Etc/UTC", theme: "dark", style: "1", locale: "en", backgroundColor: "rgba(17, 20, 24, 1)", gridColor: "rgba(236, 239, 242, 0.05)", allow_symbol_change: false, hide_side_toolbar: true, calendar: false, support_host: "https://www.tradingview.com" });
    tv.append(sc);
  };
  if ("IntersectionObserver" in window) new IntersectionObserver((es, o) => { if (es.some((e) => e.isIntersecting)) { load(); o.disconnect(); } }, { rootMargin: "600px" }).observe(tv);
  else load();
}

// ---------- tabs (code samples, order ticket) ----------
function tablist(sel) {
  const tabs = $$(sel);
  const select = (tab, focus) => {
    tabs.forEach((x) => { const on = x === tab; x.setAttribute("aria-selected", String(on)); x.tabIndex = on ? 0 : -1; document.getElementById(x.getAttribute("aria-controls")).hidden = !on; });
    if (focus) tab.focus();
  };
  tabs.forEach((t, i) => {
    t.addEventListener("click", () => select(t));
    t.addEventListener("keydown", (e) => {
      const n = e.key === "ArrowRight" ? tabs[(i + 1) % tabs.length] : e.key === "ArrowLeft" ? tabs[(i - 1 + tabs.length) % tabs.length] : null;
      if (n) { e.preventDefault(); select(n, true); }
    });
  });
}
tablist(".term-tabs [role=tab]");
tablist(".tk-tabs [role=tab]");

// ---------- add network ----------
const walletMsg = $("[data-wallet-msg]");
async function addNetwork() {
  const say = (t) => { if (walletMsg) walletMsg.textContent = t; else alert(t); };
  if (!LIVE.chain) { say(`${L3.name} opens at launch. Its RPC goes public then, and you can add the network in one click.`); return; }
  const eth = window.gmeWallet?.provider || window.ethereum;
  if (!eth) { say("No browser wallet found. Install one such as MetaMask, or add the network by hand with the values above."); return; }
  try {
    await eth.request({ method: "wallet_addEthereumChain", params: [{ chainId: L3.hex, chainName: L3.name, nativeCurrency: { name: TOKEN, symbol: TOKEN, decimals: 18 }, rpcUrls: [L3.rpc], blockExplorerUrls: [`${location.origin}${EXPLORER}`] }] });
    say(`${L3.name} is in your wallet.`);
  } catch (e) {
    say(e && e.code === 4001 ? "Cancelled in your wallet." : "Your wallet could not add the network. Add it by hand with the values above.");
  }
}
$$("[data-add-network]").forEach((b) => b.addEventListener("click", addNetwork));

// ---------- continue? countdown (9 to 0, then again) ----------
const cd = $("[data-countdown]");
if (cd && !reduced) {
  let n = 9, timer = 0;
  const step = () => { n = n === 0 ? 9 : n - 1; cd.textContent = String(n); cd.classList.remove("beat"); void cd.offsetWidth; cd.classList.add("beat"); };
  new IntersectionObserver(([e]) => { clearInterval(timer); if (e.isIntersecting) timer = setInterval(step, 1000); }).observe(cd);
}

// ---------- start ----------
refreshL3(); refreshL2();
setInterval(refreshL3, LIVE.chain ? 4000 : 60000);
setInterval(refreshL2, 30000);
