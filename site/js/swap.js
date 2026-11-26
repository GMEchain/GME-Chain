// GME CHAIN exchange: Uniswap V2 router on GME CHAIN. Swap, wrap, add and remove liquidity, live price chart.
import { DEX, L3, TOKEN } from "./config.js";
import { viem, l3, state, onWallet, connect, write, friendlyError, fmt, short, hasWallet } from "./wallet.js";
const warn = (e) => console.warn(e); // background refreshes: log failures instead of leaving promises unhandled

const { parseAbi, parseAbiItem, parseUnits, formatUnits, getAddress, isAddress, zeroAddress } = viem;
const $ = (s, r = document) => r.querySelector(s);
const $$ = (s, r = document) => [...r.querySelectorAll(s)];

onWallet((s) => { $$("[data-connect]").forEach((b) => { b.textContent = s.address ? short(s.address) : "Connect wallet"; }); });
$$("[data-connect]").forEach((b) => b.addEventListener("click", () => connect().catch((e) => alert(friendlyError(e)))));

if (!DEX) {
  $("[data-dex-pending]").hidden = false;
  $$("#swap-form input, #swap-form button, #pool-form input, #pool-form button").forEach((el) => { el.disabled = true; });
  $$("[data-submit]").forEach((b) => { b.textContent = "Exchange opens soon"; });
} else {
  start();
}

function start() {
  const ROUTER = DEX.router, FACTORY = DEX.factory, WGME = DEX.wrappedGme;
  $("[data-addr=router]").textContent = ROUTER;
  $("[data-addr=factory]").textContent = FACTORY;
  $("[data-addr=want]").textContent = WGME;

  const erc20 = parseAbi([
    "function balanceOf(address) view returns (uint256)", "function allowance(address,address) view returns (uint256)",
    "function approve(address,uint256) returns (bool)", "function symbol() view returns (string)", "function decimals() view returns (uint8)",
    "function name() view returns (string)", "function totalSupply() view returns (uint256)",
  ]);
  const wantAbi = parseAbi(["function deposit() payable", "function withdraw(uint256)"]);
  const factoryAbi = parseAbi(["function getPair(address,address) view returns (address)", "function allPairsLength() view returns (uint256)"]);
  // a short note while the factory has no pool at all; it disappears by itself once the first pool exists
  l3.readContract({ address: FACTORY, abi: factoryAbi, functionName: "allPairsLength" }).then((n) => { const el = document.querySelector("[data-no-pools]"); if (el) el.hidden = n > 0n; }).catch(() => {});
  const pairAbi = parseAbi(["function getReserves() view returns (uint112,uint112,uint32)", "function token0() view returns (address)"]);
  const routerAbi = parseAbi([
    "function getAmountsOut(uint256,address[]) view returns (uint256[])",
    "function swapExactETHForTokens(uint256,address[],address,uint256) payable returns (uint256[])",
    "function swapExactTokensForETH(uint256,uint256,address[],address,uint256) returns (uint256[])",
    "function swapExactTokensForTokens(uint256,uint256,address[],address,uint256) returns (uint256[])",
    "function addLiquidityETH(address,uint256,uint256,uint256,address,uint256) payable returns (uint256,uint256,uint256)",
    "function addLiquidity(address,address,uint256,uint256,uint256,uint256,address,uint256) returns (uint256,uint256,uint256)",
    "function removeLiquidityETH(address,uint256,uint256,uint256,address,uint256) returns (uint256,uint256)",
    "function removeLiquidity(address,address,uint256,uint256,uint256,address,uint256) returns (uint256,uint256)",
  ]);
  const Sync = parseAbiItem("event Sync(uint112 reserve0, uint112 reserve1)");

  // ---------- token list ----------
  const GME = { address: null, symbol: TOKEN, name: `${TOKEN} (native gas)`, decimals: 18 };
  const WANT_T = { address: WGME, symbol: TOKEN === "GME" ? "WGME" : "W" + TOKEN, name: `Wrapped ${TOKEN}`, decimals: 18 };
  let tokens = [GME, WANT_T];
  if (DEX.testUsd) tokens.push({ address: DEX.testUsd, symbol: "tUSD", name: "Test USD (testnet)", decimals: 18 });
  if (DEX.usdg) tokens.push({ address: DEX.usdg, symbol: "USDG", name: "Global Dollar (bridged from Robinhood Chain)", decimals: 6 });
  const BUILTIN = tokens.length;
  const known = (a) => tokens.some((t) => (t.address || "").toLowerCase() === String(a).toLowerCase());
  try { (JSON.parse(localStorage.getItem("gmechain-tokens") || "[]")).forEach((t) => { if (isAddress(t.address) && !known(t.address)) tokens.push(t); }); } catch {}
  const saveTokens = () => { try { localStorage.setItem("gmechain-tokens", JSON.stringify(tokens.slice(BUILTIN))); } catch {} };
  const addr = (t) => t.address ?? WGME;
  const same = (a, b) => (a.address ?? "native") === (b.address ?? "native");
  const isWrap = (a, b) => (a.address === null && b.address === WGME) || (a.address === WGME && b.address === null);

  const S = { in: GME, out: tokens[2] || WANT_T, slip: 50n, quote: null, path: null, pool: { a: GME, b: tokens[2] || WANT_T } };
  const deadline = () => BigInt(Math.floor(Date.now() / 1000) + 20 * 60);

  async function balanceOf(t, who) {
    if (!who) return null;
    return t.address ? l3.readContract({ address: t.address, abi: erc20, functionName: "balanceOf", args: [who] }) : l3.getBalance({ address: who });
  }
  const icon = (t) => `<span class="tok-ico${t.address ? " alt" : ""}">${t.symbol.slice(0, 4)}</span>`;
  function paintTok(btn, t) { btn.innerHTML = `${icon(t)}${t.symbol}<span aria-hidden="true">▾</span>`; btn.setAttribute("aria-label", `Choose token, current ${t.symbol}`); }

  // ---------- picker ----------
  const dlg = $("#picker");
  let pickCb = null;
  function openPicker(cb) {
    pickCb = cb;
    $("#picker-q").value = "";
    renderPicker("");
    dlg.showModal();
    $("#picker-q").focus();
  }
  function renderPicker(q) {
    const ul = $("#picker-list");
    const ql = q.trim().toLowerCase();
    ul.innerHTML = "";
    tokens.filter((t) => !ql || t.symbol.toLowerCase().includes(ql) || (t.address || "").toLowerCase() === ql).forEach((t) => {
      const li = document.createElement("li");
      li.innerHTML = `<button type="button">${icon(t)}<span>${t.symbol}<small>${t.name}${t.address ? " · " + short(t.address) : ""}</small></span></button>`;
      li.querySelector("button").addEventListener("click", () => { dlg.close(); pickCb?.(t); });
      ul.appendChild(li);
    });
    if (isAddress(q.trim()) && !tokens.some((t) => (t.address || "").toLowerCase() === ql)) {
      const li = document.createElement("li");
      li.innerHTML = `<button type="button"><span class="tok-ico alt">+</span><span>Import ${short(q.trim())}<small>Read symbol and decimals from GME CHAIN</small></span></button>`;
      li.querySelector("button").addEventListener("click", async () => {
        const a = getAddress(q.trim());
        try {
          const [symbol, decimals, name] = await Promise.all([
            l3.readContract({ address: a, abi: erc20, functionName: "symbol" }),
            l3.readContract({ address: a, abi: erc20, functionName: "decimals" }),
            l3.readContract({ address: a, abi: erc20, functionName: "name" }).catch(() => "Imported token"),
          ]);
          const t = { address: a, symbol: String(symbol).slice(0, 12), name: String(name).slice(0, 40), decimals: Number(decimals) };
          tokens.push(t); saveTokens(); dlg.close(); pickCb?.(t);
        } catch { li.querySelector("small").textContent = "Not an ERC-20 on GME CHAIN."; }
      });
      ul.appendChild(li);
    }
  }
  $("#picker-q").addEventListener("input", (e) => renderPicker(e.target.value));
  $("[data-close-picker]").addEventListener("click", () => dlg.close());

  // ---------- swap ----------
  const f = $("#swap-form");
  const inAmt = $("input[name=in]", f), outAmt = $("input[name=out]", f);
  const btnIn = $("[data-tok=in]"), btnOut = $("[data-tok=out]"), go = $("[data-submit=swap]"), msg = $(".form-msg", f);
  paintTok(btnIn, S.in); paintTok(btnOut, S.out);
  btnIn.addEventListener("click", () => openPicker((t) => { if (same(t, S.out)) S.out = S.in; S.in = t; paintTok(btnIn, S.in); paintTok(btnOut, S.out); requote().catch(warn); }));
  btnOut.addEventListener("click", () => openPicker((t) => { if (same(t, S.in)) S.in = S.out; S.out = t; paintTok(btnIn, S.in); paintTok(btnOut, S.out); requote().catch(warn); }));
  $("[data-flip]").addEventListener("click", () => { [S.in, S.out] = [S.out, S.in]; paintTok(btnIn, S.in); paintTok(btnOut, S.out); inAmt.value = outAmt.value || inAmt.value; requote().catch(warn); });
  $$("[data-slip]").forEach((b) => b.addEventListener("click", () => {
    S.slip = BigInt(b.dataset.slip);
    $$("[data-slip]").forEach((x) => x.setAttribute("aria-pressed", String(x === b)));
    requote().catch(warn);
  }));
  inAmt.addEventListener("input", () => { inAmt.value = inAmt.value.replace(",", ".").replace(/[^0-9.]/g, ""); requote().catch(warn); });
  $("[data-max=in]").addEventListener("click", async () => {
    const b = await balanceOf(S.in, state.address);
    if (b === null) return;
    const keep = S.in.address ? 0n : parseUnits("0.0002", 18);
    inAmt.value = formatUnits(b > keep ? b - keep : 0n, S.in.decimals);
    requote().catch(warn);
  });

  let qid = 0;
  async function requote() {
    const id = ++qid;
    S.quote = null; S.path = null;
    outAmt.value = "";
    $("[data-quote]").hidden = true;
    let amount;
    try { amount = parseUnits(inAmt.value || "0", S.in.decimals); } catch { amount = 0n; }
    await paintBalances();
    if (amount <= 0n) return setGo();
    if (isWrap(S.in, S.out)) { S.quote = amount; outAmt.value = formatUnits(amount, 18); return setGo(amount); }
    const a = addr(S.in), b = addr(S.out);
    const hops = [WGME];
    const cands = [[a, b], ...hops.map((h) => [a, h, b]), ...hops.flatMap((h1) => hops.filter((h2) => h2 !== h1).map((h2) => [a, h1, h2, b]))];
    const lc = (x) => x.toLowerCase();
    const paths = cands.filter((p) => new Set(p.map(lc)).size === p.length); // no token twice in a route
    const results = await Promise.all(paths.map((p) => l3.readContract({ address: ROUTER, abi: routerAbi, functionName: "getAmountsOut", args: [amount, p] }).then((am) => ({ p, out: am[am.length - 1] })).catch(() => null)));
    if (id !== qid) return;
    const best = results.filter((r) => r && r.out > 0n).sort((x, y) => (y.out > x.out ? 1 : y.out < x.out ? -1 : x.p.length - y.p.length))[0];
    if (!best) return setGo(amount, "No pool for this pair yet");
    S.quote = best.out; S.path = best.p;
    outAmt.value = formatUnits(S.quote, S.out.decimals);
    const minOut = (S.quote * (10_000n - S.slip)) / 10_000n;
    const nameOf = (x) => (lc(x) === lc(WGME) ? WANT_T.symbol : short(x));
    $("[data-q=rate]").textContent = `1 ${S.in.symbol} ≈ ${fmt((S.quote * 10n ** BigInt(S.in.decimals)) / amount, 6, S.out.decimals)} ${S.out.symbol}`;
    $("[data-q=min]").textContent = `${fmt(minOut, 6, S.out.decimals)} ${S.out.symbol}`;
    $("[data-q=route]").textContent = best.p.length === 2 ? "Direct" : `via ${best.p.slice(1, -1).map(nameOf).join(" → ")}`;
    $("[data-quote]").hidden = false;
    return setGo(amount);
  }
  async function paintBalances() {
    const [bi, bo] = await Promise.all([balanceOf(S.in, state.address).catch(() => null), balanceOf(S.out, state.address).catch(() => null)]);
    $("[data-bal=in]").textContent = bi === null ? "—" : fmt(bi, 6, S.in.decimals);
    $("[data-bal=out]").textContent = bo === null ? "—" : fmt(bo, 6, S.out.decimals);
    S.balIn = bi;
  }
  function setGo(amount, reason) {
    go.disabled = false;
    if (!hasWallet()) { go.textContent = "Install a wallet"; go.disabled = true; return; }
    if (!state.address) { go.textContent = "Connect wallet"; return; }
    if (!amount) { go.textContent = "Enter an amount"; go.disabled = true; return; }
    if (reason) { go.textContent = reason; go.disabled = true; return; }
    if (S.balIn !== null && S.balIn !== undefined && amount > S.balIn) { go.textContent = `Not enough ${S.in.symbol}`; go.disabled = true; return; }
    go.textContent = isWrap(S.in, S.out) ? (S.in.address ? "Unwrap" : "Wrap") : "Swap";
  }
  onWallet(() => requote());

  async function ensureAllowance(token, spender, amount, m) {
    const cur = await l3.readContract({ address: token, abi: erc20, functionName: "allowance", args: [state.address, spender] });
    if (cur >= amount) return;
    m.textContent = "Approve in your wallet…";
    await write(L3.id, { address: token, abi: erc20, functionName: "approve", args: [spender, amount] }, (h) => { m.textContent = `Approval ${short(h)}…`; });
  }

  f.addEventListener("submit", async (e) => {
    e.preventDefault();
    if (!state.address) { connect().catch((err) => { msg.textContent = friendlyError(err); }); return; }
    const amount = parseUnits(inAmt.value || "0", S.in.decimals);
    if (amount <= 0n || S.quote === null) return;
    go.disabled = true;
    msg.dataset.kind = "";
    msg.textContent = "Preparing…";
    try {
      const to = state.address, dl = deadline();
      const minOut = (S.quote * (10_000n - S.slip)) / 10_000n;
      let r;
      const onHash = (h) => { msg.textContent = `Sent ${short(h)}…`; };
      if (isWrap(S.in, S.out)) {
        r = S.in.address === null
          ? await write(L3.id, { address: WGME, abi: wantAbi, functionName: "deposit", value: amount }, onHash)
          : await write(L3.id, { address: WGME, abi: wantAbi, functionName: "withdraw", args: [amount] }, onHash);
      } else if (S.in.address === null) {
        msg.textContent = "Confirm the swap in your wallet…";
        r = await write(L3.id, { address: ROUTER, abi: routerAbi, functionName: "swapExactETHForTokens", args: [minOut, S.path, to, dl], value: amount }, onHash);
      } else {
        await ensureAllowance(S.in.address, ROUTER, amount, msg);
        msg.textContent = "Confirm the swap in your wallet…";
        r = S.out.address === null
          ? await write(L3.id, { address: ROUTER, abi: routerAbi, functionName: "swapExactTokensForETH", args: [amount, minOut, S.path, to, dl] }, onHash)
          : await write(L3.id, { address: ROUTER, abi: routerAbi, functionName: "swapExactTokensForTokens", args: [amount, minOut, S.path, to, dl] }, onHash);
      }
      msg.dataset.kind = "ok";
      msg.innerHTML = `Done in block ${r.blockNumber.toLocaleString("en-US")} · <code title="${r.transactionHash}">${short(r.transactionHash)}</code>`;
      inAmt.value = "";
      requote().catch(warn);
      chart().catch(warn);
    } catch (err) {
      msg.dataset.kind = "bad";
      msg.textContent = friendlyError(err);
      go.disabled = false;
    }
  });

  // ---------- pool: add / remove liquidity ----------
  const pf = $("#pool-form");
  const pa = $("input[name=a]", pf), pb = $("input[name=b]", pf), pmsg = $(".form-msg", pf), pgo = $("[data-submit=pool]");
  const btnA = $("[data-tok=a]"), btnB = $("[data-tok=b]");
  paintTok(btnA, S.pool.a); paintTok(btnB, S.pool.b);
  btnA.addEventListener("click", () => openPicker((t) => { if (same(t, S.pool.b)) return; S.pool.a = t; paintTok(btnA, t); poolInfo().catch(warn); }));
  btnB.addEventListener("click", () => openPicker((t) => { if (same(t, S.pool.a)) return; S.pool.b = t; paintTok(btnB, t); poolInfo().catch(warn); }));

  async function pairOf(a, b) {
    const p = await l3.readContract({ address: FACTORY, abi: factoryAbi, functionName: "getPair", args: [addr(a), addr(b)] });
    return p === zeroAddress ? null : p;
  }
  let reserves = null;
  async function poolInfo() {
    const { a, b } = S.pool;
    const info = $("[data-pool-info]");
    reserves = null;
    if (isWrap(a, b) || same(a, b)) { info.textContent = "Pick two different tokens (GME and WGME are the same asset)."; return; }
    const pair = await pairOf(a, b).catch(() => null);
    const [ba, bb] = state.address ? await Promise.all([balanceOf(a, state.address).catch(() => null), balanceOf(b, state.address).catch(() => null)]) : [null, null];
    const yours = ba !== null ? ` · You have ${fmt(ba, 4, a.decimals)} ${a.symbol} and ${fmt(bb ?? 0n, 4, b.decimals)} ${b.symbol}` : "";
    if (!pair) { info.textContent = `No ${a.symbol}/${b.symbol} pool yet. Your deposit sets the starting price.${yours}`; $("[data-lp]").textContent = "—"; return; }
    const [[r0, r1], t0] = await Promise.all([
      l3.readContract({ address: pair, abi: pairAbi, functionName: "getReserves" }),
      l3.readContract({ address: pair, abi: pairAbi, functionName: "token0" }),
    ]);
    const aIs0 = getAddress(t0) === getAddress(addr(a));
    reserves = { pair, ra: aIs0 ? r0 : r1, rb: aIs0 ? r1 : r0 };
    info.textContent = `Pool ${short(pair)} · ${fmt(reserves.ra, 4, a.decimals)} ${a.symbol} / ${fmt(reserves.rb, 4, b.decimals)} ${b.symbol}${yours}`;
    const lp = state.address ? await l3.readContract({ address: pair, abi: erc20, functionName: "balanceOf", args: [state.address] }) : null;
    $("[data-lp]").textContent = lp === null ? "—" : `${fmt(lp, 8)} LP`;
    S.lp = lp;
  }
  pa.addEventListener("input", () => {
    pa.value = pa.value.replace(",", ".").replace(/[^0-9.]/g, "");
    if (reserves && reserves.ra > 0n) {
      try { const x = parseUnits(pa.value || "0", S.pool.a.decimals); pb.value = formatUnits((x * reserves.rb) / reserves.ra, S.pool.b.decimals); } catch {}
    }
  });
  pb.addEventListener("input", () => { pb.value = pb.value.replace(",", ".").replace(/[^0-9.]/g, ""); });
  onWallet(() => poolInfo());

  pf.addEventListener("submit", async (e) => {
    e.preventDefault();
    if (!state.address) { connect().catch((err) => { pmsg.textContent = friendlyError(err); }); return; }
    const { a, b } = S.pool;
    if (isWrap(a, b) || same(a, b)) return;
    let xa, xb;
    try { xa = parseUnits(pa.value || "0", a.decimals); xb = parseUnits(pb.value || "0", b.decimals); } catch { return; }
    if (xa <= 0n || xb <= 0n) { pmsg.textContent = "Enter both amounts."; return; }
    // Check both balances first, so the wallet never opens a transaction that is certain to fail.
    const [ba, bb] = await Promise.all([balanceOf(a, state.address).catch(() => null), balanceOf(b, state.address).catch(() => null)]);
    const reserve = parseUnits("0.0002", 18); // keep a little native gas for the transaction itself
    const short_ = (t, need, have) => `Not enough ${t.symbol}: need ${fmt(need, 6, t.decimals)}, you have ${fmt(have, 6, t.decimals)}.${t.address ? ` Swap some ${S.pool.a.address === null ? S.pool.a.symbol : "tokens"} to ${t.symbol} first.` : ""}`;
    if (ba !== null && xa + (a.address === null ? reserve : 0n) > ba) { pmsg.dataset.kind = "bad"; pmsg.textContent = short_(a, xa, ba); return; }
    if (bb !== null && xb + (b.address === null ? reserve : 0n) > bb) { pmsg.dataset.kind = "bad"; pmsg.textContent = short_(b, xb, bb); return; }
    pgo.disabled = true;
    pmsg.dataset.kind = "";
    pmsg.textContent = "Preparing…";
    try {
      const min = (x) => (reserves ? (x * (10_000n - S.slip)) / 10_000n : 0n);
      const dl = deadline(), to = state.address;
      const onHash = (h) => { pmsg.textContent = `Sent ${short(h)}…`; };
      if (a.address === null || b.address === null) {
        const tok = a.address === null ? b : a, xt = a.address === null ? xb : xa, xe = a.address === null ? xa : xb;
        await ensureAllowance(tok.address, ROUTER, xt, pmsg);
        pmsg.textContent = "Confirm in your wallet…";
        await write(L3.id, { address: ROUTER, abi: routerAbi, functionName: "addLiquidityETH", args: [tok.address, xt, min(xt), min(xe), to, dl], value: xe }, onHash);
      } else {
        await ensureAllowance(a.address, ROUTER, xa, pmsg);
        await ensureAllowance(b.address, ROUTER, xb, pmsg);
        pmsg.textContent = "Confirm in your wallet…";
        await write(L3.id, { address: ROUTER, abi: routerAbi, functionName: "addLiquidity", args: [a.address, b.address, xa, xb, min(xa), min(xb), to, dl] }, onHash);
      }
      pmsg.dataset.kind = "ok";
      pmsg.textContent = "Liquidity added.";
      pa.value = pb.value = "";
      poolInfo().catch(warn);
      chart().catch(warn);
    } catch (err) {
      pmsg.dataset.kind = "bad";
      pmsg.textContent = friendlyError(err);
    } finally { pgo.disabled = false; }
  });

  $("[data-remove]").addEventListener("click", async () => {
    const { a, b } = S.pool;
    if (!state.address || !reserves || !S.lp) { pmsg.textContent = "No liquidity of yours in this pool."; return; }
    const pct = BigInt($("select[name=pct]").value);
    const liq = (S.lp * pct) / 100n;
    if (liq <= 0n) return;
    try {
      const supply = await l3.readContract({ address: reserves.pair, abi: erc20, functionName: "totalSupply" });
      const ea = (reserves.ra * liq) / supply, eb = (reserves.rb * liq) / supply;
      const min = (x) => (x * (10_000n - S.slip)) / 10_000n;
      await ensureAllowance(reserves.pair, ROUTER, liq, pmsg);
      pmsg.textContent = "Confirm the removal in your wallet…";
      const dl = deadline(), to = state.address, onHash = (h) => { pmsg.textContent = `Sent ${short(h)}…`; };
      if (a.address === null || b.address === null) {
        const tok = a.address === null ? b : a;
        const et = a.address === null ? eb : ea, ee = a.address === null ? ea : eb;
        await write(L3.id, { address: ROUTER, abi: routerAbi, functionName: "removeLiquidityETH", args: [tok.address, liq, min(et), min(ee), to, dl] }, onHash);
      } else {
        await write(L3.id, { address: ROUTER, abi: routerAbi, functionName: "removeLiquidity", args: [a.address, b.address, liq, min(ea), min(eb), to, dl] }, onHash);
      }
      pmsg.dataset.kind = "ok";
      pmsg.textContent = `Removed ${pct}% of your liquidity.`;
      poolInfo().catch(warn);
      chart().catch(warn);
    } catch (err) { pmsg.dataset.kind = "bad"; pmsg.textContent = friendlyError(err); }
  });

  // ---------- tabs ----------
  $$(".swap-tabs [role=tab]").forEach((t, i, all) => {
    const sel = (tab, focus) => {
      all.forEach((x) => { const on = x === tab; x.setAttribute("aria-selected", String(on)); x.tabIndex = on ? 0 : -1; document.getElementById(x.getAttribute("aria-controls")).hidden = !on; });
      if (focus) tab.focus();
      if (tab.id === "tab-pool") poolInfo().catch(warn);
    };
    t.addEventListener("click", () => sel(t));
    t.addEventListener("keydown", (e) => {
      const n = e.key === "ArrowRight" ? all[(i + 1) % all.length] : e.key === "ArrowLeft" ? all[(i - 1 + all.length) % all.length] : null;
      if (n) { e.preventDefault(); sel(n, true); }
    });
  });

  // ---------- chart: price history from the pair's Sync events ----------
  async function chart() {
    const area = $("[data-chart]"), title = $("[data-chart-title]");
    const a = S.in.address === null ? WANT_T : S.in, b = S.out.address === null ? WANT_T : S.out;
    title.textContent = `${S.in.symbol} / ${S.out.symbol}`;
    if (same(a, b)) { area.innerHTML = "<span>GME and WGME are always 1:1.</span>"; return; }
    const pair = await pairOf(a, b).catch(() => null);
    if (!pair) { area.innerHTML = "<span>No pool to chart yet.</span>"; return; }
    const [t0, logs] = await Promise.all([
      l3.readContract({ address: pair, abi: pairAbi, functionName: "token0" }),
      l3.getLogs({ address: pair, event: Sync, fromBlock: 0n, toBlock: "latest" }),
    ]);
    const aIs0 = getAddress(t0) === getAddress(a.address);
    const pts = logs.map((l) => {
      const ra = Number(formatUnits(aIs0 ? l.args.reserve0 : l.args.reserve1, a.decimals));
      const rb = Number(formatUnits(aIs0 ? l.args.reserve1 : l.args.reserve0, b.decimals));
      return ra > 0 ? rb / ra : null;
    }).filter((x) => x !== null);
    if (pts.length < 2) { area.innerHTML = `<span>${pts.length ? `1 ${S.in.symbol} = ${pts[0].toPrecision(5)} ${S.out.symbol}` : "No trades yet."}</span>`; return; }
    area.innerHTML = `<canvas aria-label="Price of ${S.in.symbol} in ${S.out.symbol} over ${pts.length} pool updates" role="img"></canvas>`;
    const c = area.querySelector("canvas"), dpr = Math.min(devicePixelRatio || 1, 2);
    const w = c.clientWidth, h = c.clientHeight;
    c.width = w * dpr; c.height = h * dpr;
    const ctx = c.getContext("2d"); ctx.scale(dpr, dpr);
    const lo = Math.min(...pts), hi = Math.max(...pts), pad = 24;
    const X = (i) => pad + (i / (pts.length - 1)) * (w - pad * 2);
    const Y = (v) => h - pad - ((v - lo) / (hi - lo || 1)) * (h - pad * 2);
    const rgb = pts[pts.length - 1] >= pts[0] ? "59, 224, 126" : "255, 45, 45"; // up: --ok green, down: GME red
    const g = ctx.createLinearGradient(0, 0, 0, h); g.addColorStop(0, `rgba(${rgb}, .28)`); g.addColorStop(1, `rgba(${rgb}, 0)`);
    ctx.beginPath(); pts.forEach((v, i) => (i ? ctx.lineTo(X(i), Y(v)) : ctx.moveTo(X(i), Y(v)))); ctx.lineTo(X(pts.length - 1), h - pad); ctx.lineTo(X(0), h - pad); ctx.fillStyle = g; ctx.fill();
    ctx.beginPath(); pts.forEach((v, i) => (i ? ctx.lineTo(X(i), Y(v)) : ctx.moveTo(X(i), Y(v)))); ctx.strokeStyle = `rgb(${rgb})`; ctx.lineWidth = 2; ctx.stroke();
    ctx.fillStyle = "#A9B1BA"; ctx.font = "500 12px 'M PLUS 1 Code', ui-monospace, monospace";
    ctx.fillText(`${pts[pts.length - 1].toPrecision(5)} ${S.out.symbol}`, pad, 16);
  }
  [btnIn, btnOut, $("[data-flip]")].forEach((b) => b.addEventListener("click", () => setTimeout(chart, 0)));
  dlg.addEventListener("close", () => setTimeout(chart, 0));
  async function tokenFor(v) {
    if (!v) return null;
    if (/^(gme|native)$/i.test(v)) return GME;
    if (!isAddress(v)) return null;
    const hit = tokens.find((t) => (t.address || "").toLowerCase() === v.toLowerCase());
    if (hit) return hit;
    const a = getAddress(v);
    const [symbol, decimals, name] = await Promise.all([
      l3.readContract({ address: a, abi: erc20, functionName: "symbol" }),
      l3.readContract({ address: a, abi: erc20, functionName: "decimals" }),
      l3.readContract({ address: a, abi: erc20, functionName: "name" }).catch(() => "Imported token"),
    ]);
    const t = { address: a, symbol: String(symbol).slice(0, 12), name: String(name).slice(0, 40), decimals: Number(decimals) };
    tokens.push(t); saveTokens();
    return t;
  }
  (async () => {
    const q = new URLSearchParams(location.search);
    const [tin, tout] = await Promise.all([tokenFor(q.get("in")).catch(() => null), tokenFor(q.get("out")).catch(() => null)]);
    if (tin && !(tout && same(tin, tout))) S.in = tin;
    if (tout && !same(tout, S.in)) S.out = tout;
    paintTok(btnIn, S.in); paintTok(btnOut, S.out);
  })().catch(warn).finally(() => { chart().catch(warn); requote().catch(warn); });
}
