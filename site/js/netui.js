// Fills network-specific labels on every page from config.js, so one page works for mainnet and testnet.
//   data-n="l2|l2id|l3|l3id|tok|net|rpc|strip"  text from the active profile
//   data-show="mainnet|testnet"                   shown only on that network
//   data-net-switch                               Mainnet / Testnet toggle (links with ?net=)
//   data-explorer links and links to /explorer/testnet/... point at the explorer of the active network
import { PROFILES, ACTIVE, MAINNET_OPEN, LIVE } from "./config.js";

const P = PROFILES[ACTIVE];
const SHORT_L2 = { mainnet: "Robinhood Chain", testnet: "Robinhood Testnet" };
const TEXT = {
  l2: SHORT_L2[ACTIVE],
  l2id: String(P.L2.id),
  l3: P.L3.name,
  l3id: String(P.L3.id),
  tok: P.TOKEN,
  route: `${SHORT_L2[ACTIVE]} (${P.L2.id}) → ${P.L3.name} (${P.L3.id})`,
  rpc: P.L3.rpc.replace("https://", ""),
  cta: ACTIVE === "testnet" ? "Try it on testnet" : "Get GME gas",
  navcta: ACTIVE === "testnet" ? "Try testnet" : "Get GME gas",
  strip: ACTIVE === "mainnet" ? (LIVE.chain ? "Mainnet live" : "Mainnet soon") : LIVE.chain ? "Testnet live · mainnet soon" : "Testnet opening soon",
};

function apply() {
  document.querySelectorAll("[data-n]").forEach((el) => { const t = TEXT[el.dataset.n]; if (t !== undefined) el.textContent = t; });
  const COPY = { l3: P.L3.name, l3id: String(P.L3.id), rpcurl: P.L3.rpc };
  document.querySelectorAll("[data-n-copy]").forEach((el) => { el.dataset.copy = COPY[el.dataset.nCopy]; });
  document.querySelectorAll("[data-show]").forEach((el) => { el.hidden = el.dataset.show !== ACTIVE; });
  // on testnet pages, keep testnet when moving between the apps (the choice is not stored anywhere)
  if (ACTIVE === "testnet") {
    document.querySelectorAll('a[href^="/"]').forEach((a) => {
      const href = a.getAttribute("href");
      if (/^\/(bridge|swap)\/?(\?|#|$)/.test(href) && !/[?&]net=/.test(href)) a.setAttribute("href", href.replace(/^([^?#]*)(\?[^#]*)?(#.*)?$/, (m, path, qs, hash) => `${path}${qs ? qs + "&" : "?"}net=testnet${hash || ""}`));
    });
  }
  // explorer links follow the active network: in the menus (data-explorer) and in live-data links
  const exBase = ACTIVE === "mainnet" ? "/explorer" : "/explorer/testnet";
  document.querySelectorAll("a[data-explorer]").forEach((a) => { a.setAttribute("href", `${exBase}/`); });
  if (ACTIVE === "mainnet") {
    document.querySelectorAll('a[href^="/explorer/testnet"]').forEach((a) => {
      if (a.closest("[data-keep-net]")) return;
      a.setAttribute("href", a.getAttribute("href").replace("/explorer/testnet", "/explorer"));
    });
  }
  document.querySelectorAll("[data-net-switch]").forEach((box) => {
    if (!MAINNET_OPEN) { box.hidden = true; return; }
    box.replaceChildren(...["mainnet", "testnet"].map((net) => {
      const a = document.createElement("a");
      const u = new URL(location.href); u.searchParams.set("net", net);
      a.href = u.pathname + u.search + u.hash;
      a.textContent = net === "mainnet" ? "Mainnet" : "Testnet";
      if (net === ACTIVE) { a.className = "on"; a.setAttribute("aria-current", "true"); }
      return a;
    }));
  });
}
if (document.readyState === "loading") document.addEventListener("DOMContentLoaded", apply); else apply();
