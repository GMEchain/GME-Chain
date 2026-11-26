// GME CHAIN bridge: pay with ETH (swapped to GME by GmeGasRouter) or GME on Robinhood Chain, withdraw back,
// claim after the challenge window, and convert the claimed GME back to ETH.
import { ADDR, L2, L3, CONFIRM_BLOCKS, TOKEN, NETWORK, UNISWAP } from "./config.js";
import { viem, l2, l3, state, onWallet, connect, ensureChain, write, friendlyError, fmt, short, hasWallet, addNetwork } from "./wallet.js";
const warn = (e) => console.warn(e); // background refreshes: log failures instead of leaving promises unhandled

const { parseAbi, parseAbiItem, parseEther, formatEther, zeroHash, encodePacked } = viem;
const $ = (s, r = document) => r.querySelector(s);
const $$ = (s, r = document) => [...r.querySelectorAll(s)];

const erc20 = parseAbi([
  "function balanceOf(address) view returns (uint256)",
  "function allowance(address,address) view returns (uint256)",
  "function approve(address,uint256) returns (bool)",
]);
const inboxAbi = parseAbi([
  "function createRetryableTicket(address to, uint256 l2CallValue, uint256 maxSubmissionCost, address excessFeeRefundAddress, address callValueRefundAddress, uint256 gasLimit, uint256 maxFeePerGas, uint256 tokenTotalFeeAmount, bytes data) returns (uint256)",
  "function sendContractTransaction(uint256 gasLimit, uint256 maxFeePerGas, address to, uint256 value, bytes data) returns (uint256)",
]);
// Deposits are sent as a retryable ticket addressed to the wallet itself. A plain depositERC20 from a smart account
// (EIP-7702, e.g. MetaMask Smart Account) is credited to an aliased address instead; this way it always lands on you.
const DEPOSIT_GAS = 300000n; // gas for the ticket's auto-redeem (a plain transfer); unused gas is refunded
const RECOVER_GAS = 100000n;
const aliasOf = (a) => "0x" + ((BigInt(a) + 0x1111000000000000000000000000000000001111n) % (1n << 160n)).toString(16).padStart(40, "0");
async function feePerGas() { const gp = await l3.getGasPrice(); return gp * 2n; }
const arbSysAbi = parseAbi(["function withdrawEth(address destination) payable returns (uint256)"]);
const outboxAbi = parseAbi([
  "function isSpent(uint256 index) view returns (bool)",
  "function roots(bytes32) view returns (bytes32)",
  "function executeTransaction(bytes32[] proof, uint256 index, address l2Sender, address to, uint256 l2Block, uint256 l1Block, uint256 l2Timestamp, uint256 value, bytes data)",
]);
const nodeIfaceAbi = parseAbi(["function constructOutboxProof(uint64 size, uint64 leaf) view returns (bytes32 send, bytes32 root, bytes32[] proof)"]);
// ---------- ETH <-> GME through GmeGasRouter and Uniswap v3 on Robinhood Chain ----------
const routerAbi = parseAbi([
  "function depositEth(bytes path, uint256 minGmeOut, address to, uint256 gasLimit, uint256 maxFeePerGas) payable returns (uint256)",
  "function swapGmeToEth(uint256 amountIn, bytes path, uint256 minEthOut, address to) returns (uint256)",
]);
const quoterAbi = parseAbi(["function quoteExactInput(bytes path, uint256 amountIn) returns (uint256 amountOut, uint160[] sqrtPriceX96AfterList, uint32[] initializedTicksCrossedList, uint256 gasEstimate)"]);
const SLIPPAGE_BPS = 100n; // 1% price limit on every swap
const ETH_RESERVE = parseEther("0.0003"); // ETH kept back to pay the Robinhood Chain gas of the deposit itself
const ETH_MODE = !!ADDR.gasRouter;
let pay = ETH_MODE ? "eth" : "gme";
function pathFor(route, from, to) {
  const tokens = route.via ? [from, UNISWAP[route.via], to] : [from, to];
  const types = ["address"], vals = [tokens[0]];
  route.hops.forEach((fee, i) => { types.push("uint24", "address"); vals.push(fee, tokens[i + 1]); });
  return encodePacked(types, vals);
}
// Quotes every configured route (reversed for GME -> ETH) and returns the best one.
async function bestRoute(amountIn, from, to) {
  const tries = await Promise.allSettled(UNISWAP.routes.map(async (route) => {
    const r = from.toLowerCase() === UNISWAP.weth.toLowerCase() ? route : { ...route, hops: [...route.hops].reverse() };
    const path = pathFor(r, from, to);
    const [out] = await l2.readContract({ address: UNISWAP.quoterV2, abi: quoterAbi, functionName: "quoteExactInput", args: [path, amountIn] });
    return { out, path, name: route.name };
  }));
  const ok = tries.filter((t) => t.status === "fulfilled").map((t) => t.value).sort((a, b) => (a.out > b.out ? -1 : 1));
  if (!ok.length) throw new Error("No Uniswap route answered. Try again in a moment.");
  return ok[0];
}
const minOut = (out) => (out * (10000n - SLIPPAGE_BPS)) / 10000n;
function debounce(fn, ms) { let t; return (...a) => { clearTimeout(t); t = setTimeout(() => fn(...a), ms); }; }

const L2ToL1Tx = parseAbiItem("event L2ToL1Tx(address caller, address indexed destination, uint256 indexed hash, uint256 indexed position, uint256 arbBlockNum, uint256 ethBlockNum, uint256 timestamp, uint256 callvalue, bytes data)");

const WAIT = CONFIRM_BLOCKS * 12 < 3 * 3600 ? `about ${Math.round((CONFIRM_BLOCKS * 12) / 60)} minutes` : `about ${Math.round((CONFIRM_BLOCKS * 12) / 86400)} days`;
const GAS_RESERVE = parseEther("0.0002"); // GME kept back on GME CHAIN to pay the withdrawal's own gas
const bal = { gme: null, eth: null, allowance: null, l3: null };

// ---------- ui helpers ----------
function status(el, text, kind = "") {
  el.textContent = text;
  el.dataset.kind = kind;
}
// progress lights up the stations of the live route beside the form
function setStep(form, n) {
  $$(".route-track li").forEach((li, i) => {
    li.classList.toggle("done", i < n);
    li.classList.toggle("on", i === n);
  });
}
const txLink = (hash) => `<code title="${hash}">${short(hash)}</code>`;

// ---------- live stats ----------
async function refreshStats() {
  const set = (k, v, kind) => { const el = $(`[data-stat="${k}"]`); if (el) { el.textContent = v; if (kind) el.dataset.kind = kind; } };
  const [esc, head] = await Promise.allSettled([
    l2.readContract({ address: ADDR.gme, abi: erc20, functionName: "balanceOf", args: [ADDR.bridge] }),
    l3.getBlockNumber(),
  ]);
  set("escrow", esc.status === "fulfilled" ? `${fmt(esc.value, 4)} ${TOKEN}` : "unreachable", esc.status === "fulfilled" ? "" : "bad");
  set("parent", esc.status === "fulfilled" ? "Responding" : "Not reachable", esc.status === "fulfilled" ? "ok" : "bad");
  set("l3", head.status === "fulfilled" ? `Block ${head.value.toLocaleString("en-US")}` : "Not reachable", head.status === "fulfilled" ? "ok" : "bad");
}

// ---------- recovery: GME that an earlier smart-account deposit left at the aliased address ----------
async function checkAlias() {
  const box = $("[data-alias]");
  if (!box || !state.address) { if (box) box.hidden = true; return; }
  const a = aliasOf(state.address);
  const b = await l3.getBalance({ address: a }).catch(() => 0n);
  const fee = await feePerGas().catch(() => 0n);
  const movable = b - RECOVER_GAS * fee;
  if (!fee || movable <= 0n) { box.hidden = true; return; }
  $("[data-alias-amount]", box).textContent = `${fmt(b, 6)} ${TOKEN}`;
  $("[data-alias-addr]", box).textContent = short(a);
  box.hidden = false;
  box.dataset.value = movable.toString();
  box.dataset.fee = fee.toString();
}
async function recoverAlias() {
  const box = $("[data-alias]"), msg = $("[data-alias-msg]", box), btn = $("[data-alias-go]", box);
  btn.disabled = true;
  try {
    await checkAlias();
    const value = BigInt(box.dataset.value || "0"), fee = BigInt(box.dataset.fee || "0");
    if (value <= 0n) throw new Error("Nothing to move.");
    const before = await l3.getBalance({ address: state.address });
    status(msg, "Switch to Robinhood Chain and confirm in your wallet…");
    await ensureChain(L2.id);
    await write(L2.id, { address: ADDR.inbox, abi: inboxAbi, functionName: "sendContractTransaction", args: [RECOVER_GAS, fee, state.address, value, "0x"] }, (h) => status(msg, `Sent ${short(h)}. Waiting for GME CHAIN…`));
    const t0 = Date.now();
    while (Date.now() - t0 < 10 * 60_000) {
      await new Promise((res) => setTimeout(res, 4000));
      const now = await l3.getBalance({ address: state.address }).catch(() => before);
      if (now > before) { status(msg, `Done. ${fmt(now - before, 6)} ${TOKEN} is now at your address on GME CHAIN.`, "ok"); refreshBalances().catch(warn); checkAlias().catch(warn); return; }
    }
    status(msg, "Sent. It will arrive at your address when GME CHAIN picks it up; you do not need to do anything.", "warn");
  } catch (err) {
    status(msg, friendlyError(err), "bad");
  } finally {
    btn.disabled = false;
  }
}

async function refreshBalances() {
  if (!state.address) return;
  checkAlias().catch(warn);
  const a = state.address;
  const [gme, eth, allw, l3b] = await Promise.allSettled([
    l2.readContract({ address: ADDR.gme, abi: erc20, functionName: "balanceOf", args: [a] }),
    l2.getBalance({ address: a }),
    l2.readContract({ address: ADDR.gme, abi: erc20, functionName: "allowance", args: [a, ADDR.inbox] }),
    l3.getBalance({ address: a }),
  ]);
  bal.gme = gme.value ?? null; bal.eth = eth.value ?? null; bal.allowance = allw.value ?? null; bal.l3 = l3b.value ?? null;
  const show = (k, v, unit) => $$(`[data-bal="${k}"]`).forEach((el) => { el.textContent = v === null ? "—" : `${fmt(v, 6)} ${unit}`; });
  show("gme", bal.gme, TOKEN);
  show("eth", bal.eth, "ETH");
  show("l3", bal.l3, TOKEN);
  const db = pay === "eth" ? bal.eth : bal.gme;
  $$("[data-dep-bal]").forEach((el) => { el.textContent = db === null ? "—" : `${fmt(db, 6)} ${pay === "eth" ? "ETH" : TOKEN}`; });
  updateButtons();
}

// ---------- tabs ----------
$$(".bridge-tabs [role=tab]").forEach((t, i, all) => {
  const select = (tab, focus) => {
    all.forEach((x) => {
      const on = x === tab;
      x.setAttribute("aria-selected", String(on));
      x.tabIndex = on ? 0 : -1;
      document.getElementById(x.getAttribute("aria-controls")).hidden = !on;
    });
    if (focus) tab.focus();
    if (tab.id === "tab-out") loadWithdrawals().catch(warn);
  };
  t.addEventListener("click", () => select(t));
  t.addEventListener("keydown", (e) => {
    const n = e.key === "ArrowRight" ? all[(i + 1) % all.length] : e.key === "ArrowLeft" ? all[(i - 1 + all.length) % all.length] : null;
    if (n) { e.preventDefault(); select(n, true); }
  });
});

// the arrow between the legs flips the direction; the history button opens the withdrawals list
const isOut = () => $("#tab-out").getAttribute("aria-selected") === "true";
$$("[data-flip]").forEach((b) => b.addEventListener("click", () => { (isOut() ? $("#tab-in") : $("#tab-out")).click(); $(isOut() ? "#withdraw-form input[name=amount]" : "#deposit-form input[name=amount]")?.focus(); }));
$$("[data-history]").forEach((b) => b.addEventListener("click", () => {
  if (!isOut()) $("#tab-out").click();
  const list = $("#withdrawals"); list.scrollIntoView({ behavior: matchMedia("(prefers-reduced-motion: reduce)").matches ? "auto" : "smooth", block: "center" });
}));

// ---------- buttons follow wallet state ----------
const dep = $("#deposit-form"), wd = $("#withdraw-form"), cv = $("#convert-form");
function amountOf(form) {
  const v = $("input[name=amount]", form).value.trim();
  if (!v) return null;
  try { const x = parseEther(v); return x > 0n ? x : null; } catch { return null; }
}
function updateButtons() {
  const depBtn = $("button[type=submit]", dep), wdBtn = $("button[type=submit]", wd);
  if (!hasWallet()) { depBtn.textContent = wdBtn.textContent = "Install a wallet"; depBtn.disabled = wdBtn.disabled = true; return; }
  if (!state.address) { depBtn.textContent = wdBtn.textContent = "Connect wallet"; depBtn.disabled = wdBtn.disabled = false; return; }
  const da = amountOf(dep);
  if (!da) { depBtn.textContent = "Enter an amount"; depBtn.disabled = true; }
  else if (pay === "eth" && bal.eth !== null && da + ETH_RESERVE > bal.eth) { depBtn.textContent = "Not enough ETH (keep a little for gas)"; depBtn.disabled = true; }
  else if (pay === "eth") { depBtn.textContent = "Swap and deposit"; depBtn.disabled = false; }
  else if (bal.gme !== null && da > bal.gme) { depBtn.textContent = `Not enough ${TOKEN}`; depBtn.disabled = true; }
  else if (bal.eth !== null && bal.eth === 0n) { depBtn.textContent = "Need ETH for gas on Robinhood Chain"; depBtn.disabled = true; }
  else { depBtn.textContent = bal.allowance !== null && bal.allowance < da ? "Approve and deposit" : "Deposit"; depBtn.disabled = false; }
  const wa = amountOf(wd);
  if (!wa) { wdBtn.textContent = "Enter an amount"; wdBtn.disabled = true; }
  else if (bal.l3 !== null && wa + GAS_RESERVE > bal.l3) { wdBtn.textContent = `Not enough ${TOKEN} (keep a little for gas)`; wdBtn.disabled = true; }
  else { wdBtn.textContent = "Start withdrawal"; wdBtn.disabled = false; }
  updateConvertButton();
}
$$("input[name=amount]").forEach((i) => i.addEventListener("input", () => {
  i.value = i.value.replace(",", ".").replace(/[^0-9.]/g, "");
  i.closest("form")?.querySelectorAll(".pct-row button").forEach((b) => b.setAttribute("aria-pressed", "false"));
  updateButtons();
}));
// 10/25/50/75/100% of what can be moved: the whole GME balance for deposits; for withdrawals the GME on
// GME CHAIN minus a small reserve for the withdrawal's own gas (so 100% always goes through). Rounded down.
function setPct(form, spendable, pct, btn) {
  const msg = $(".form-msg", form);
  if (!state.address) { status(msg, "Connect a wallet first.", "bad"); return; }
  if (spendable === null) { status(msg, "Still reading your balance…"); return; }
  if (spendable <= 0n) { status(msg, "Nothing to move yet.", "bad"); return; }
  $("input[name=amount]", form).value = formatEther((spendable * BigInt(pct)) / 100n);
  form.querySelectorAll(".pct-row button").forEach((b) => b.setAttribute("aria-pressed", String(b === btn)));
  status(msg, "");
  updateButtons();
}
$$("[data-pct=deposit] button").forEach((b) => b.addEventListener("click", () => {
  const spendable = pay === "eth" ? (bal.eth === null ? null : bal.eth - ETH_RESERVE) : bal.gme;
  setPct(dep, spendable, Number(b.dataset.p), b);
  quoteDeposit();
}));

// ---------- pay with ETH or GME ----------
const receive = $("[data-receive]");
const RECEIVE_GME = "You receive the same amount as native gas, at the same address, minus a tiny gas fee for the transfer (under 0.0001 GME).";
const RECEIVE_ETH = "Your ETH is swapped to GME on Uniswap v3 (best route, 1% price limit) and arrives as native gas at the same address.";
function setPay(mode) {
  pay = mode;
  $$("[data-pay]").forEach((b) => b.setAttribute("aria-checked", String(b.dataset.pay === mode)));
  $("[data-pay-unit]").textContent = mode === "eth" ? "ETH" : TOKEN;
  $("[data-pay-label]").textContent = mode === "eth" ? "Amount of ETH to bridge" : `Amount of ${TOKEN} to deposit`;
  $("[data-step0]").textContent = mode === "eth" ? "Swap ETH → GME" : "Approve";
  $("input[name=amount]", dep).value = "";
  dep.querySelectorAll(".pct-row button").forEach((b) => b.setAttribute("aria-pressed", "false"));
  receive.textContent = mode === "eth" ? RECEIVE_ETH : RECEIVE_GME;
  refreshBalances().catch(warn);
  updateButtons();
}
// The ETH route needs GmeGasRouter (mainnet). Without it (testnet), only GME/tGME deposits are offered.
if (!ETH_MODE) { const seg = $("[data-pay-seg]"); if (seg) seg.hidden = true; }
$$("[data-pay]").forEach((b) => b.addEventListener("click", () => { if (ETH_MODE) setPay(b.dataset.pay); }));
setPay(pay);
let quoteSeq = 0;
const quoteDeposit = debounce(async () => {
  if (pay !== "eth") return;
  const amount = amountOf(dep), my = ++quoteSeq;
  if (!amount) { receive.textContent = RECEIVE_ETH; return; }
  receive.textContent = "Getting a Uniswap quote…";
  try {
    const q = await bestRoute(amount, UNISWAP.weth, ADDR.gme);
    if (my !== quoteSeq) return;
    receive.innerHTML = `≈ <b>${fmt(q.out, 4)} ${TOKEN}</b> arrives as gas (via ${q.name}). At least ${fmt(minOut(q.out), 4)} ${TOKEN} with the 1% price limit, or the transaction reverts and your ETH stays put.`;
  } catch (err) { if (my === quoteSeq) receive.textContent = friendlyError(err); }
}, 350);
$("input[name=amount]", dep).addEventListener("input", quoteDeposit);
$$("[data-pct=withdraw] button").forEach((b) => b.addEventListener("click", () => setPct(wd, bal.l3 === null ? null : bal.l3 - GAS_RESERVE, Number(b.dataset.p), b)));

onWallet((s) => {
  $$("[data-connect]").forEach((b) => { b.textContent = s.address ? short(s.address) : "Connect wallet"; });
  $$("[data-need-wallet]").forEach((el) => { el.hidden = !s.address; });
  refreshBalances().catch(warn);
  updateButtons();
  if (!$("#panel-out").hidden) loadWithdrawals().catch(warn);
});
$$("[data-connect]").forEach((b) => b.addEventListener("click", () => connect().catch((e) => alert(friendlyError(e)))));
$$("[data-add-l3]").forEach((b) => b.addEventListener("click", async () => {
  const msg = $("[data-add-msg]");
  try { await addNetwork(L3.id); if (msg) status(msg, "GME CHAIN is in your wallet.", "ok"); } catch (e) { if (msg) status(msg, friendlyError(e), "bad"); }
}));

// ---------- deposit ----------
dep.addEventListener("submit", async (e) => {
  e.preventDefault();
  const msg = $(".form-msg", dep);
  if (!state.address) { connect().catch((err) => status(msg, friendlyError(err), "bad")); return; }
  const amount = amountOf(dep);
  if (!amount) return;
  const btn = $("button[type=submit]", dep);
  btn.disabled = true;
  try {
    const before = await l3.getBalance({ address: state.address });
    setStep(dep, 0);
    status(msg, "Switch to Robinhood Chain in your wallet…");
    await ensureChain(L2.id);
    let r;
    if (pay === "eth") {
      status(msg, "Getting the best Uniswap route…");
      const q = await bestRoute(amount, UNISWAP.weth, ADDR.gme);
      const fee = await feePerGas();
      const floor = minOut(q.out);
      if (floor <= DEPOSIT_GAS * fee) throw new Error("That amount is too small to bridge.");
      status(msg, `Confirm in your wallet: ${fmt(amount, 6)} ETH → at least ${fmt(floor, 4)} ${TOKEN} on GME CHAIN…`);
      r = await write(L2.id, { address: ADDR.gasRouter, abi: routerAbi, functionName: "depositEth", args: [q.path, floor, state.address, DEPOSIT_GAS, fee], value: amount }, (h) => status(msg, `Swap and deposit sent ${short(h)}. Waiting for Robinhood Chain…`));
      setStep(dep, 2);
    } else {
    const allowance = await l2.readContract({ address: ADDR.gme, abi: erc20, functionName: "allowance", args: [state.address, ADDR.inbox] });
    if (allowance < amount) {
      status(msg, `Approve ${TOKEN} for the GME CHAIN inbox in your wallet…`);
      await write(L2.id, { address: ADDR.gme, abi: erc20, functionName: "approve", args: [ADDR.inbox, amount] }, (h) => status(msg, `Approval sent ${short(h)}. Waiting for Robinhood Chain…`));
    }
    setStep(dep, 1);
    status(msg, "Confirm the deposit in your wallet…");
    const fee = await feePerGas();
    if (amount <= DEPOSIT_GAS * fee) throw new Error("That amount is too small to bridge.");
    const me = state.address;
    r = await write(L2.id, { address: ADDR.inbox, abi: inboxAbi, functionName: "createRetryableTicket", args: [me, amount - DEPOSIT_GAS * fee, 0n, me, me, DEPOSIT_GAS, fee, amount, "0x"] }, (h) => status(msg, `Deposit sent ${short(h)}. Waiting for Robinhood Chain…`));
    setStep(dep, 2);
    }
    status(msg, "Locked on Robinhood Chain. Waiting for GME CHAIN to credit it (usually under a minute)…");
    const t0 = Date.now();
    while (Date.now() - t0 < 15 * 60_000) {
      await new Promise((res) => setTimeout(res, 4000));
      const now = await l3.getBalance({ address: state.address }).catch(() => before);
      if (now > before) {
        setStep(dep, 3);
        msg.innerHTML = `Done. ${fmt(now - before, 6)} ${TOKEN} arrived on GME CHAIN in ${Math.round((Date.now() - t0) / 1000)} s. Deposit tx ${txLink(r.transactionHash)}.`;
        msg.dataset.kind = "ok";
        window.gmeConfetti?.();
        $("input[name=amount]", dep).value = "";
        refreshBalances().catch(warn);
        return;
      }
    }
    status(msg, "The deposit is locked on Robinhood Chain but not credited yet. It will arrive when the sequencer picks it up; you do not need to do anything.", "warn");
  } catch (err) {
    status(msg, friendlyError(err), "bad");
  } finally {
    refreshBalances().catch(warn);
  }
});

// ---------- withdraw ----------
wd.addEventListener("submit", async (e) => {
  e.preventDefault();
  const msg = $(".form-msg", wd);
  if (!state.address) { connect().catch((err) => status(msg, friendlyError(err), "bad")); return; }
  const amount = amountOf(wd);
  if (!amount) return;
  const btn = $("button[type=submit]", wd);
  btn.disabled = true;
  try {
    status(msg, "Switch to GME CHAIN in your wallet…");
    await ensureChain(L3.id);
    status(msg, "Confirm the withdrawal in your wallet…");
    const r = await write(L3.id, { address: ADDR.arbSys, abi: arbSysAbi, functionName: "withdrawEth", args: [state.address], value: amount }, (h) => status(msg, `Sent ${short(h)}…`));
    msg.innerHTML = `Withdrawal started (${txLink(r.transactionHash)}). Your ${TOKEN} can be claimed on ${L2.name} after the challenge window, ${WAIT}. It is listed below.`;
    msg.dataset.kind = "ok";
    $("input[name=amount]", wd).value = "";
    refreshBalances().catch(warn);
    loadWithdrawals().catch(warn);
  } catch (err) {
    status(msg, friendlyError(err), "bad");
  } finally {
    updateButtons();
  }
});

// ---------- withdrawals list + claim ----------
// A withdrawal at outbox position p can be claimed once a confirmed send root covers it:
// outbox.roots(sendRoot) is set only when the rollup confirms an assertion with that root.
async function confirmedSize() {
  const all = await l3.getLogs({ address: ADDR.arbSys, event: L2ToL1Tx, fromBlock: 0n, toBlock: "latest" });
  const blocks = [...new Set(all.map((l) => l.blockNumber))].sort((a, b) => (a < b ? 1 : -1));
  for (const bn of blocks) {
    const b = await l3.request({ method: "eth_getBlockByNumber", params: [viem.toHex(bn), false] });
    if (!b?.sendRoot || b.sendRoot === zeroHash) continue;
    const root = await l2.readContract({ address: ADDR.outbox, abi: outboxAbi, functionName: "roots", args: [b.sendRoot] });
    if (root && root !== zeroHash) return BigInt(b.sendCount);
  }
  return 0n;
}

let loading = false;
async function loadWithdrawals() {
  const list = $("#withdrawals");
  if (!state.address || loading) { if (!state.address) list.innerHTML = `<li class="empty">Connect a wallet to see your withdrawals.</li>`; return; }
  loading = true;
  list.innerHTML = `<li class="empty">Reading GME CHAIN…</li>`;
  try {
    const logs = await l3.getLogs({ address: ADDR.arbSys, event: L2ToL1Tx, args: { destination: state.address }, fromBlock: 0n, toBlock: "latest" });
    if (!logs.length) { list.innerHTML = `<li class="empty">No withdrawals to ${short(state.address)} yet.</li>`; return; }
    const size = await confirmedSize();
    const rows = await Promise.all(logs.reverse().map(async (l) => {
      const a = l.args;
      const spent = await l2.readContract({ address: ADDR.outbox, abi: outboxAbi, functionName: "isSpent", args: [a.position] }).catch(() => false);
      // batch posting + next assertion + challenge window; testnet adds ~25 min to the window, mainnet ~1 h
      const eta = new Date((Number(a.timestamp) + CONFIRM_BLOCKS * 12 + (NETWORK === "testnet" ? 25 * 60 : 3600)) * 1000);
      return { l, a, spent, ready: !spent && a.position < size, eta };
    }));
    list.innerHTML = "";
    rows.forEach(({ l, a, spent, ready, eta }) => {
      const li = document.createElement("li");
      const when = new Date(Number(a.timestamp) * 1000).toLocaleString();
      li.innerHTML = `
        <div><b>${fmt(a.callvalue, 6)} ${TOKEN}</b><span>Started ${when} · ${txLink(l.transactionHash)}</span></div>
        <div class="w-state">${spent ? `<span class="pill ok">Claimed</span>` : ready ? `<button class="btn btn-accent btn-small" type="button">Claim on Robinhood Chain</button>` : `<span class="countdown" data-start="${Number(a.timestamp) * 1000}" data-eta="${eta.getTime()}" title="Estimated: ${eta.toLocaleString()}"><span class="pill" data-cd-text>Claim opens in …</span><i class="cd-bar"><b></b></i></span>`}</div>
        <p class="form-msg" role="status" aria-live="polite"></p>`;
      const btn = li.querySelector("button");
      if (btn) btn.addEventListener("click", () => claim(a, size, li));
      list.appendChild(li);
    });
  } catch (err) {
    list.innerHTML = `<li class="empty">Could not read withdrawals: ${friendlyError(err)}</li>`;
  } finally {
    loading = false;
  }
}

async function claim(a, size, li) {
  const msg = li.querySelector(".form-msg");
  const btn = li.querySelector("button");
  btn.disabled = true;
  try {
    status(msg, "Building the proof from GME CHAIN…");
    const [, , proof] = await l3.readContract({ address: ADDR.nodeInterface, abi: nodeIfaceAbi, functionName: "constructOutboxProof", args: [size, a.position] });
    status(msg, "Switch to Robinhood Chain and confirm the claim…");
    const r = await write(L2.id, {
      address: ADDR.outbox, abi: outboxAbi, functionName: "executeTransaction",
      args: [proof, a.position, a.caller, a.destination, a.arbBlockNum, a.ethBlockNum, a.timestamp, a.callvalue, a.data],
    }, (h) => status(msg, `Claim sent ${short(h)}…`));
    msg.innerHTML = `Claimed. It is back on ${L2.name} (${txLink(r.transactionHash)}).${ETH_MODE && a.callvalue > 0n ? " Want ETH? Convert it below." : ""}`;
    msg.dataset.kind = "ok";
    window.gmeConfetti?.();
    btn.outerHTML = `<span class="pill ok">Claimed</span>`;
    if (ETH_MODE && a.callvalue > 0n && cv) { $("input[name=amount]", cv).value = formatEther(a.callvalue); quoteConvert(); cv.scrollIntoView({ behavior: "smooth", block: "center" }); }
    refreshBalances().catch(warn);
  } catch (err) {
    status(msg, friendlyError(err), "bad");
    btn.disabled = false;
  }
}

// ---------- convert claimed GME to ETH (GmeGasRouter.swapGmeToEth) ----------
const erc20Allow = (owner, spender) => l2.readContract({ address: ADDR.gme, abi: erc20, functionName: "allowance", args: [owner, spender] });
function updateConvertButton() {
  if (!cv) return;
  const b = $("button[type=submit]", cv);
  if (!hasWallet()) { b.textContent = "Install a wallet"; b.disabled = true; return; }
  if (!state.address) { b.textContent = "Connect wallet"; b.disabled = false; return; }
  const a = amountOf(cv);
  if (!a) { b.textContent = "Enter an amount"; b.disabled = true; }
  else if (bal.gme !== null && a > bal.gme) { b.textContent = `Not enough ${TOKEN} on ${L2.name}`; b.disabled = true; }
  else { b.textContent = "Convert to ETH"; b.disabled = false; }
}
let cvSeq = 0;
const quoteConvert = debounce(async () => {
  const out = $("[data-convert-out]", cv), amount = amountOf(cv), my = ++cvSeq;
  updateConvertButton();
  if (!amount) { out.textContent = "—"; return; }
  out.textContent = "…";
  try { const q = await bestRoute(amount, ADDR.gme, UNISWAP.weth); if (my === cvSeq) out.textContent = `≈ ${fmt(q.out, 6)} ETH`; }
  catch { if (my === cvSeq) out.textContent = "no quote"; }
}, 350);
if (cv && !ETH_MODE) cv.hidden = true;
if (cv && ETH_MODE) {
  $("input[name=amount]", cv).addEventListener("input", (e) => { e.target.value = e.target.value.replace(",", ".").replace(/[^0-9.]/g, ""); quoteConvert(); });
  $$("[data-pct=convert] button", cv).forEach((b) => b.addEventListener("click", () => { setPct(cv, bal.gme, Number(b.dataset.p), b); quoteConvert(); }));
  cv.addEventListener("submit", async (e) => {
    e.preventDefault();
    const msg = $(".form-msg", cv), btn = $("button[type=submit]", cv);
    if (!state.address) { connect().catch((err) => status(msg, friendlyError(err), "bad")); return; }
    const amount = amountOf(cv);
    if (!amount) return;
    btn.disabled = true;
    try {
      status(msg, "Switch to Robinhood Chain in your wallet…");
      await ensureChain(L2.id);
      if ((await erc20Allow(state.address, ADDR.gasRouter)) < amount) {
        status(msg, `Approve ${TOKEN} for the GME CHAIN gas router in your wallet…`);
        await write(L2.id, { address: ADDR.gme, abi: erc20, functionName: "approve", args: [ADDR.gasRouter, amount] }, (h) => status(msg, `Approval sent ${short(h)}…`));
      }
      const q = await bestRoute(amount, ADDR.gme, UNISWAP.weth);
      status(msg, `Confirm in your wallet: ${fmt(amount, 6)} ${TOKEN} → at least ${fmt(minOut(q.out), 6)} ETH…`);
      const r = await write(L2.id, { address: ADDR.gasRouter, abi: routerAbi, functionName: "swapGmeToEth", args: [amount, q.path, minOut(q.out), state.address] }, (h) => status(msg, `Sent ${short(h)}…`));
      msg.innerHTML = `Done. About ${fmt(q.out, 6)} ETH is in your wallet on ${L2.name} (${txLink(r.transactionHash)}).`;
      msg.dataset.kind = "ok";
      $("input[name=amount]", cv).value = "";
      $("[data-convert-out]", cv).textContent = "—";
    } catch (err) {
      status(msg, friendlyError(err), "bad");
    } finally {
      refreshBalances().catch(warn);
    }
  });
}

$("[data-refresh-withdrawals]")?.addEventListener("click", loadWithdrawals);
document.addEventListener("gmechain:withdrawals", () => { loadWithdrawals().catch(warn); });

// ---------- live countdown until a withdrawal can be claimed ----------
const two = (n) => String(n).padStart(2, "0");
let lastRecheck = 0;
setInterval(() => {
  const cds = document.querySelectorAll("#withdrawals .countdown");
  if (!cds.length) return;
  const now = Date.now();
  let due = false;
  cds.forEach((el) => {
    const start = Number(el.dataset.start), eta = Number(el.dataset.eta), left = eta - now;
    const txt = el.querySelector("[data-cd-text]"), bar = el.querySelector(".cd-bar b");
    bar.style.width = `${Math.min(100, Math.max(0, ((now - start) / (eta - start)) * 100)).toFixed(1)}%`;
    if (left > 0) {
      const t = Math.ceil(left / 1000), h = Math.floor(t / 3600), m = Math.floor((t % 3600) / 60), sec = t % 60;
      txt.textContent = `Claim opens in ${h ? `${h}:${two(m)}` : m}:${two(sec)}`;
    } else {
      txt.textContent = "Finalizing on chain…";
      due = true;
    }
  });
  // once an estimate has passed, look again every minute; the Claim button appears by itself when ready
  if (due && now - lastRecheck > 60_000 && !loading) { lastRecheck = now; loadWithdrawals().catch(warn); }
}, 1000);

// ---------- testnet faucet: 100 tGME per address per day from the tGME contract itself ----------
const faucetCard = $("[data-faucet]");
if (faucetCard && NETWORK === "testnet") {
  faucetCard.hidden = false;
  const fmsg = $(".form-msg:not([data-kit-msg])", faucetCard);
  // test kit: our faucet service sends testnet ETH + tGME, no wallet signature needed
  const kmsg = $("[data-kit-msg]", faucetCard);
  $("[data-kit]", faucetCard).addEventListener("click", async (e) => {
    const b = e.currentTarget;
    b.disabled = true;
    try {
      if (!state.address) await connect();
      status(kmsg, `Sending a test kit to ${short(state.address)}…`);
      const r = await fetch("/api/faucet/claim", { method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify({ address: state.address }) });
      const j = await r.json().catch(() => ({}));
      if (!r.ok) { status(kmsg, j.error || "The faucet is unavailable right now.", "bad"); return; }
      const parts = [];
      if (j.eth) parts.push(`${j.eth.amount} ETH for gas`);
      if (j.tgme) parts.push(`${j.tgme.amount} tGME`);
      kmsg.innerHTML = parts.length ? `Sent ${parts.join(" and ")} to ${short(state.address)}. Now deposit tGME on the left.` : "Your wallet already has enough ETH and tGME to test. Go ahead and deposit.";
      kmsg.dataset.kind = "ok";
      refreshBalances().catch(warn);
    } catch (err) {
      status(kmsg, friendlyError(err), "bad");
    } finally { b.disabled = false; }
  });
  $("[data-drip]", faucetCard).addEventListener("click", async (e) => {
    const b = e.currentTarget;
    b.disabled = true;
    try {
      if (!state.address) await connect();
      // Claiming costs a little ETH for gas on the parent chain. Check first instead of letting the wallet show a red alert.
      const eth = await l2.getBalance({ address: state.address }).catch(() => null);
      if (eth === 0n) {
        fmsg.innerHTML = `You need a little testnet ETH on ${L2.name} to pay gas first. Get it free from the <a href="https://faucet.testnet.chain.robinhood.com" target="_blank" rel="noopener">Robinhood faucet</a> for ${short(state.address)}, then try again.`;
        fmsg.dataset.kind = "warn";
        return;
      }
      status(fmsg, `Switch to ${L2.name} and confirm in your wallet…`);
      const r = await write(L2.id, { address: ADDR.gme, abi: parseAbi(["function drip()"]), functionName: "drip" }, (h) => status(fmsg, `Sent ${short(h)}…`));
      fmsg.innerHTML = `100 ${TOKEN} sent to ${short(state.address)} (${txLink(r.transactionHash)}). Now deposit it below.`;
      fmsg.dataset.kind = "ok";
      refreshBalances().catch(warn);
    } catch (err) {
      const m = friendlyError(err);
      status(fmsg, /DripCooldown|0x[0-9a-f]{8}/i.test(m) ? "Already claimed today. The faucet gives 100 tGME per address every 24 hours." : m, "bad");
    } finally { b.disabled = false; }
  });
}

refreshStats().catch(warn);
setInterval(refreshStats, 20_000);
setInterval(refreshBalances, 15_000);
updateButtons();

$("[data-alias-go]")?.addEventListener("click", () => { recoverAlias().catch(warn); });
