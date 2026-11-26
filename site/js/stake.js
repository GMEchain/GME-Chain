// $GMEC staking page: stake on Robinhood Chain, watch gas credits grow, unstake any time.
// Network and contract come from STAKING in config.js ($GMEC on Robinhood Chain; test: true switches to the tGME rehearsal).
import { STAKING } from "./config.js";
import { viem, state, onWallet, connect, friendlyError, fmt, short, isUnauthorized } from "./wallet.js";
const warn = (e) => console.warn(e); // background refreshes: log failures instead of leaving promises unhandled

const { createPublicClient, createWalletClient, custom, http, fallback, defineChain, parseAbi, parseUnits, maxUint256 } = viem;
const $ = (s, r = document) => r.querySelector(s);
const $$ = (s, r = document) => [...r.querySelectorAll(s)];

const C = STAKING.chain;
const chain = defineChain({ id: C.id, name: C.name, nativeCurrency: { name: "Ether", symbol: "ETH", decimals: 18 }, rpcUrls: { default: { http: [C.walletRpc] } } });
const pub = createPublicClient({ chain, transport: fallback(C.rpcs.map((u) => http(u, { timeout: 15_000 }))) });
const SYM = STAKING.symbol;
const STAKE_ABI = parseAbi([
  "function stake(uint256)", "function unstake(uint256)",
  "function stakedOf(address) view returns (uint256)", "function creditsOf(address) view returns (uint256)",
  "function spentOf(address) view returns (uint256)", "function totalStaked() view returns (uint256)", "function stakingOpen() view returns (bool)",
]);
const ERC = parseAbi(["function balanceOf(address) view returns (uint256)", "function allowance(address,address) view returns (uint256)", "function approve(address,uint256) returns (bool)"]);

// ---------- static labels ----------
$$("[data-sym]").forEach((el) => { el.textContent = SYM; });
$$("[data-chain-name]").forEach((el) => { el.textContent = C.name; });
const contractLink = $("[data-contract]");
if (contractLink) { contractLink.textContent = STAKING.contract; contractLink.title = "Staking contract"; }
$("[data-test-mode]").hidden = !STAKING.test;
if (STAKING.buyUrl) { const b = $("[data-buy]"); b.href = STAKING.buyUrl; b.hidden = false; }

// ---------- reads ----------
let me = { staked: 0n, credits: 0n, wallet: 0n, allowance: 0n, readAt: 0 };
const read = (f, args = []) => pub.readContract({ address: STAKING.contract, abi: STAKE_ABI, functionName: f, args });
async function refresh() {
  try {
    const [total, open] = await Promise.all([read("totalStaked"), read("stakingOpen")]);
    $("[data-total]").textContent = `${fmt(total, 2)} ${SYM}`;
    $("[data-open]").textContent = open ? "Open" : "Paused";
    $("[data-open]").dataset.kind = open ? "ok" : "warn";
    if (state.address) {
      const a = state.address;
      const [staked, credits, wallet, allowance] = await Promise.all([
        read("stakedOf", [a]), read("creditsOf", [a]),
        pub.readContract({ address: STAKING.token, abi: ERC, functionName: "balanceOf", args: [a] }),
        pub.readContract({ address: STAKING.token, abi: ERC, functionName: "allowance", args: [a, STAKING.contract] }),
      ]);
      me = { staked, credits, wallet, allowance, readAt: Date.now() };
      $("[data-staked]").textContent = `${fmt(staked, 4)} ${SYM}`;
      $("[data-wallet]").textContent = `${fmt(wallet, 4)} ${SYM}`;
      $("[data-rate]").textContent = staked > 0n ? `+${fmt(staked, 4)} token-days per day` : "stake to start earning";
    } else {
      me = { staked: 0n, credits: 0n, wallet: 0n, allowance: 0n, readAt: Date.now() };
      ["[data-staked]", "[data-wallet]"].forEach((s) => { $(s).textContent = "—"; });
      $("[data-rate]").textContent = "connect a wallet";
    }
    renderCredits();
    renderButton();
  } catch (e) {
    $("[data-open]").textContent = "Retrying…";
    $("[data-open]").dataset.kind = "bad";
  }
}
// credits tick every second between reads: staked x elapsed / 1 day
function renderCredits() {
  const el = $("[data-credits]");
  if (!state.address) { el.textContent = "—"; return; }
  const elapsed = BigInt(Math.floor((Date.now() - me.readAt) / 1000));
  const live = me.credits + (me.staked * elapsed) / 86400n;
  el.textContent = `${fmt(live, 6)} token-days`;
}
setInterval(renderCredits, 1000);

// ---------- form ----------
let mode = "stake";
const tabs = $$('[role="tab"]');
tabs.forEach((t) => t.addEventListener("click", () => {
  mode = t.dataset.mode;
  tabs.forEach((o) => { const on = o === t; o.setAttribute("aria-selected", on); o.tabIndex = on ? 0 : -1; });
  $("#amount").value = "";
  clearPct();
  say("");
  renderButton();
}));
const input = $("#amount");
const pctBtns = $$("[data-pct] button");
const clearPct = () => pctBtns.forEach((b) => b.setAttribute("aria-pressed", "false"));
input.addEventListener("input", () => { input.value = input.value.replace(",", ".").replace(/[^0-9.]/g, ""); clearPct(); renderButton(); });
// 10/25/50/75/100% of the wallet's $GMEC (stake) or of what is staked (unstake), rounded down
pctBtns.forEach((b) => b.addEventListener("click", () => {
  if (!state.address) { say("Connect a wallet first.", "bad"); return; }
  const base = mode === "stake" ? me.wallet : me.staked;
  if (base <= 0n) { say(mode === "stake" ? `No ${SYM} in this wallet on ${C.name}.` : "Nothing staked yet.", "bad"); return; }
  input.value = viem.formatUnits((base * BigInt(b.dataset.p)) / 100n, 18);
  pctBtns.forEach((x) => x.setAttribute("aria-pressed", String(x === b)));
  say("");
  renderButton();
}));

const go = $("[data-go]");
function amount() { try { const v = input.value.trim(); return v ? parseUnits(v, 18) : 0n; } catch { return -1n; } }
function renderButton() {
  const a = amount();
  go.disabled = false;
  if (!state.address) { go.textContent = "Connect wallet"; return; }
  if (a < 0n) { go.textContent = "Enter a valid amount"; go.disabled = true; return; }
  if (a === 0n) { go.textContent = mode === "stake" ? `Stake ${SYM}` : `Unstake ${SYM}`; go.disabled = true; return; }
  if (mode === "stake") {
    if (a > me.wallet) { go.textContent = `Not enough ${SYM}: you have ${fmt(me.wallet, 4)}`; go.disabled = true; return; }
    go.textContent = me.allowance >= a ? `Stake ${input.value} ${SYM}` : `Approve and stake ${input.value} ${SYM}`;
  } else {
    if (a > me.staked) { go.textContent = `You have ${fmt(me.staked, 4)} staked`; go.disabled = true; return; }
    go.textContent = `Unstake ${input.value} ${SYM}`;
  }
}
const msg = $("[data-msg]");
function say(text, kind) { msg.textContent = text; msg.dataset.kind = kind || ""; }

// wallet writes on the staking chain
const prov = () => window.gmeWallet?.provider || window.ethereum;
async function onChain() {
  const p = prov();
  if (!p) throw new Error("No browser wallet found.");
  const current = Number.parseInt(await p.request({ method: "eth_chainId" }), 16);
  if (current === C.id) return;
  try {
    await p.request({ method: "wallet_switchEthereumChain", params: [{ chainId: C.hex }] });
  } catch (e) {
    if (e && (e.code === 4902 || e.data?.originalError?.code === 4902 || /Unrecognized chain|not been added|unknown chain/i.test(e.message || ""))) {
      await p.request({ method: "wallet_addEthereumChain", params: [{ chainId: C.hex, chainName: C.name, nativeCurrency: { name: "Ether", symbol: "ETH", decimals: 18 }, rpcUrls: [C.walletRpc] }] });
    } else throw e;
  }
}
// A wallet that has not allowed this site on the staking chain answers 4100 (new MetaMask grants sites access
// per network). Ask for it once (switching prompts for it; failing that, ask for permissions again) and retry.
const NOT_ALLOWED = `Your wallet has not allowed gmechain.xyz to use ${C.name} yet. Open your wallet, allow this site on ${C.name} (or disconnect and connect again), then try once more.`;
async function grgmeChain() {
  const p = prov();
  try { await p.request({ method: "wallet_switchEthereumChain", params: [{ chainId: C.hex }] }); return; } catch (e) {
    if (e && (e.code === 4902 || e.data?.originalError?.code === 4902)) { await onChain(); return; }
    if (!isUnauthorized(e)) throw e;
  }
  await p.request({ method: "wallet_requestPermissions", params: [{ eth_accounts: {} }] });
}
async function permitted(fn) {
  try { return await fn(); } catch (e) { if (!isUnauthorized(e)) throw e; }
  try { await grgmeChain(); } catch (e) { if (e?.code === 4001) throw e; throw new Error(NOT_ALLOWED); }
  try { return await fn(); } catch (e) { if (isUnauthorized(e)) throw new Error(NOT_ALLOWED); throw e; }
}
async function send(req, label) {
  await permitted(onChain);
  say(`${label}: confirm in your wallet…`);
  const hash = await permitted(() => createWalletClient({ account: state.address, chain, transport: custom(prov()) }).writeContract({ ...req, account: state.address, chain }));
  say(`${label}: waiting for ${C.name}…`);
  const r = await pub.waitForTransactionReceipt({ hash, timeout: 180_000 });
  if (r.status !== "success") throw new Error(`Transaction reverted (${hash.slice(0, 10)}…)`);
  return hash;
}

go.addEventListener("click", async () => {
  if (!state.address) { connect().catch((e) => say(friendlyError(e), "bad")); return; }
  const a = amount();
  if (a <= 0n) return;
  go.disabled = true;
  try {
    if (mode === "stake") {
      if (me.allowance < a) await send({ address: STAKING.token, abi: ERC, functionName: "approve", args: [STAKING.contract, maxUint256] }, "Approve");
      await send({ address: STAKING.contract, abi: STAKE_ABI, functionName: "stake", args: [a] }, "Stake");
      say(`Staked ${input.value} ${SYM}. Credits start growing now.`, "ok");
    } else {
      await send({ address: STAKING.contract, abi: STAKE_ABI, functionName: "unstake", args: [a] }, "Unstake");
      say(`Unstaked ${input.value} ${SYM}. Credits you earned stay yours.`, "ok");
    }
    input.value = "";
    clearPct();
  } catch (e) {
    say(friendlyError(e), "bad");
  }
  await refresh();
});

onWallet((s) => {
  $$("[data-connect]").forEach((b) => { b.textContent = s.address ? short(s.address) : "Connect wallet"; });
  refresh().catch(warn);
});
$$("[data-connect]").forEach((b) => b.addEventListener("click", () => connect().catch((e) => say(friendlyError(e), "bad"))));
refresh().catch(warn);
setInterval(refresh, 20_000);
