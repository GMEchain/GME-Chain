// Stake page: claim gas on GME CHAIN with $GMEC staking credits, through the credits service (/api/credits).
// The wallet signs a plain message (no transaction); the service checks credits on chain, records the use
// with spendCredits, and sends gas to the same address on GME CHAIN.
import { STAKING, PROFILES } from "./config.js";
import { viem, state, onWallet, connect, friendlyError, fmt, signMessage } from "./wallet.js";

const warn = (e) => console.warn(e);
const $ = (s, r = document) => r.querySelector(s);
const card = $("[data-claim]");
const L3 = PROFILES.mainnet.L3;
const { createPublicClient, http, parseAbi } = viem;
const pub = createPublicClient({ transport: viem.fallback(STAKING.chain.rpcs.map((u) => http(u, { timeout: 15_000 }))) });
const abi = parseAbi(["function creditsOf(address) view returns (uint256)"]);
const status = (el, text, kind = "") => { el.textContent = text; el.dataset.kind = kind; };
let info = null;

async function loadInfo() {
  try { info = await (await fetch("/api/credits/info", { cache: "no-store" })).json(); } catch { info = null; }
  const terms = $("[data-claim-terms]", card);
  if (!info || !info.open) {
    terms.textContent = "Gas claims open once launchpad fees fill the gas pot (it is paid from trading fees, topped up over time). Your credits keep growing while you stake, and nothing is lost by waiting.";
  } else {
    terms.textContent = `${info.creditsPerClaim} credits buy ${info.gasPerClaim} GME of gas on GME CHAIN, once a day per wallet.`;
    $("[data-claim-budget]", card).textContent = `${info.budgetLeftToday} GME`;
  }
  paint().catch(warn);
}
async function paint() {
  const go = $("[data-claim-go]", card);
  if (!state.address) { $("[data-claim-credits]", card).textContent = "—"; go.textContent = "Connect wallet"; go.disabled = false; return; }
  const c = await pub.readContract({ address: STAKING.contract, abi, functionName: "creditsOf", args: [state.address] }).catch(() => null);
  $("[data-claim-credits]", card).textContent = c === null ? "—" : fmt(c, 4);
  go.textContent = "Claim gas";
  go.disabled = !info?.open;
}

async function claimGas() {
  const msg = $("[data-claim-msg]", card), go = $("[data-claim-go]", card);
  if (!state.address) { connect().catch((e) => status(msg, friendlyError(e), "bad")); return; }
  go.disabled = true;
  try {
    const address = viem.getAddress(state.address);
    const message = `GME CHAIN gas claim\nAddress: ${address}\nChain: ${L3.id}\nIssued: ${new Date().toISOString()}`;
    status(msg, "Sign the message in your wallet (free, no transaction)…");
    const signature = await signMessage(message);
    status(msg, "Recording the claim and sending your gas…");
    const r = await fetch("/api/credits/claim", { method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify({ address, message, signature }) });
    const j = await r.json().catch(() => ({}));
    if (!r.ok) throw new Error(j.error || `The service answered ${r.status}.`);
    status(msg, j.queued ? `Recorded. ${j.gas} GME is on its way to ${address.slice(0, 6)}… on GME CHAIN.` : `Done. ${j.gas} GME of gas is in your wallet on GME CHAIN.`, "ok");
  } catch (e) {
    status(msg, friendlyError(e), "bad");
  } finally {
    loadInfo().catch(warn);
  }
}

if (card) {
  if (STAKING.test) card.hidden = true;
  else {
    $("[data-claim-go]", card).addEventListener("click", () => { claimGas().catch(warn); });
    onWallet(() => { paint().catch(warn); });
    loadInfo().catch(warn);
    setInterval(() => { if (!document.hidden) paint().catch(warn); }, 30_000);
  }
}
