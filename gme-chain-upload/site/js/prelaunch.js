// Pre-launch panel for app pages whose contracts are not open yet on the active network (see boot.js and config.js LIVE).
// It replaces the app's grid with a card that says what the app will do, and shows what is already real today:
// the GME Stock Token on Robinhood Chain and, on the bridge page, a live ETH -> GME quote from Uniswap v3.
import { UNISWAP, ACTIVE } from "./config.js";
import { GME, bestEthToGme, gmeSupply, parseEth, fmtUnits } from "./quote.js";
import { onGmePrice } from "./gmeprice.js";

const BLOCKSCOUT = "https://robinhoodchain.blockscout.com";

const TESTNET = ACTIVE === "testnet";
const COPY = {
  bridge: TESTNET ? {
    icon: "bridge",
    title: "The testnet bridge opens soon",
    lede: "A free test run of the whole flow: get a test kit, bridge tGME into GME CHAIN Testnet, use it as gas, then withdraw. On mainnet you bring ETH and it lands as GME gas in one transaction.",
    steps: [
      ["01", "Get a test kit", "One click sends testnet ETH and tGME to your wallet. Test tokens have no value."],
      ["02", "Bridge in", "Deposit tGME; it arrives as gas on GME CHAIN Testnet in about a minute."],
      ["03", "Play", "Send, swap, deploy. Withdraw any time and claim it back about an hour later."],
    ],
    quote: true,
  } : {
    icon: "bridge",
    title: "The bridge opens at launch",
    lede: "Bring ETH from Robinhood Chain and it lands on GME CHAIN as GME gas, in one transaction. Leave the same way: back to ETH.",
    steps: [
      ["01", "Connect", "MetaMask, Rabby, OKX, Phantom, Coinbase Wallet, or any WalletConnect wallet."],
      ["02", "Enter ETH", "One transaction swaps your ETH to GME on Uniswap v3 (1% price limit) and bridges it."],
      ["03", "Play", "GME arrives as gas on GME CHAIN in about a minute. Withdraw any time; claim after 7 days."],
    ],
    quote: true,
  },
  swap: { icon: "chart", title: TESTNET ? "The testnet exchange opens soon" : "The exchange opens at launch", lede: "A Uniswap V2 exchange on GME CHAIN, where every trade pays its gas in GME. Pools are created by their liquidity providers once the chain is live.", steps: [] },
  explorer: { icon: "code", title: "The explorer starts with the first block", lede: "Blocks, transactions and addresses of GME CHAIN, read straight from its RPC. It fills in from block 0.", steps: [] },
};

const el = (tag, cls, html) => { const e = document.createElement(tag); if (cls) e.className = cls; if (html !== undefined) e.innerHTML = html; return e; };

export function showPrelaunch(app) {
  const c = COPY[app];
  if (!c) return;
  const grid = document.querySelector(".bx, .swap-grid") || document.querySelector("main section:not(.app-hero):not(.ex-hero)");
  const card = el("section", "card prelaunch");
  card.setAttribute("aria-label", c.title);
  card.append(el("div", "pre-head", `
    <span class="pre-ic"><svg aria-hidden="true"><use href="#i-${c.icon}"/></svg></span>
    <h2 class="pre-title">${c.title}</h2>`));
  card.append(el("p", "lead", c.lede));
  if (c.steps.length) {
    const ol = el("ol", "pre-steps");
    c.steps.forEach(([lv, b, t]) => ol.append(el("li", "", `<span class="lv-chip">${lv}</span><b>${b}</b><span>${t}</span>`)));
    card.append(ol);
  }
  if (c.quote) {
    const q = el("div", "pre-quote");
    q.innerHTML = `
      <p class="label">Mainnet price preview · Uniswap v3</p>
      <label class="amount"><span class="sr-only">ETH to bridge</span><input inputmode="decimal" autocomplete="off" value="0.05" data-pre-eth><span class="unit">ETH</span></label>
      <p class="receive">≈ <b data-pre-out>…</b> GME of gas on GME CHAIN <span class="fine" data-pre-route></span></p>
      <p class="fine">A real quote from Uniswap's QuoterV2 at <code>${UNISWAP.quoterV2.slice(0, 6)}…${UNISWAP.quoterV2.slice(-4)}</code>, refreshed as you type. Nothing is sent.</p>`;
    card.append(q);
    const input = q.querySelector("[data-pre-eth]"), out = q.querySelector("[data-pre-out]"), route = q.querySelector("[data-pre-route]");
    let seq = 0;
    const run = async () => {
      const my = ++seq;
      const wei = parseEth(input.value);
      if (!wei) { out.textContent = "—"; route.textContent = ""; return; }
      out.textContent = "…";
      try {
        const b = await bestEthToGme(wei);
        if (my !== seq) return;
        out.textContent = fmtUnits(b.out, 4);
        route.textContent = `via ${b.route.name}`;
      } catch { if (my === seq) { out.textContent = "unavailable"; route.textContent = ""; } }
    };
    let t;
    input.addEventListener("input", () => { clearTimeout(t); t = setTimeout(run, 350); });
    run();
  }
  const facts = el("div", "pre-facts");
  facts.innerHTML = `
    <p class="label">Already real today</p>
    <dl>
      <div><dt>Gas token</dt><dd>GameStop • Robinhood Token (GME)</dd></div>
      <div><dt>Contract</dt><dd><a class="link mono" href="${BLOCKSCOUT}/token/${GME}" target="_blank" rel="noopener">${GME.slice(0, 6)}…${GME.slice(-4)} ↗</a></dd></div>
      <div><dt>GME on Robinhood Chain</dt><dd data-pre-supply>…</dd></div>
      <div><dt>GME price</dt><dd data-pre-price>…</dd></div>
    </dl>
    <p class="fine">Check the GME contract yourself before you use any GME CHAIN page. Several look-alike tokens also call themselves "GameStop".</p>
    <p class="pre-links"><a class="btn btn-sm btn-go" href="/#start">How it works <span aria-hidden="true">→</span></a> <a class="btn btn-sm btn-line" href="/roadmap/">Roadmap</a></p>`;
  card.append(facts);
  gmeSupply().then((s) => { facts.querySelector("[data-pre-supply]").textContent = `${fmtUnits(s, 0)} GME`; }).catch(() => { facts.querySelector("[data-pre-supply]").textContent = "unavailable"; });
  onGmePrice((p) => { facts.querySelector("[data-pre-price]").textContent = `$${p.toFixed(2)}`; });

  if (grid) grid.replaceWith(card); else document.querySelector("main")?.append(card);
  document.querySelectorAll(".powerup, [data-dex-pending]").forEach((e) => { e.hidden = true; }); // live readouts start at launch
  document.querySelectorAll("[data-connect]").forEach((b) => { b.disabled = true; b.textContent = "Soon"; });
}
