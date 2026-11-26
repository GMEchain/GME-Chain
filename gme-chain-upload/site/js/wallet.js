// Shared wallet + RPC helpers for the bridge and swap apps.
// Wallet selection runs through RainbowKit (js/walletkit, window.gmeWallet); a plain injected wallet is the fallback.
import { L2, L3, VIEM, TOKEN } from "./config.js";

// viem and RainbowKit come from our own bundle (js/walletkit); the CDN copy of viem is only a fallback.
let viemMod = null;
try { viemMod = (await import("./walletkit/index.js")).viem; } catch (e) { console.warn("RainbowKit unavailable, using the injected wallet", e); }
if (!viemMod) viemMod = await import(VIEM);
export const viem = viemMod;
const { createPublicClient, createWalletClient, custom, http, fallback, defineChain } = viem;

export const gmeChain = defineChain({
  id: L3.id, name: L3.name,
  nativeCurrency: { name: TOKEN, symbol: TOKEN, decimals: 18 },
  rpcUrls: { default: { http: [L3.rpc] } },
});
export const robinhood = defineChain({
  id: L2.id, name: L2.name,
  nativeCurrency: { name: "Ether", symbol: "ETH", decimals: 18 },
  rpcUrls: { default: { http: [L2.walletRpc] } },
});

export const l3 = createPublicClient({ chain: gmeChain, transport: http(L3.rpc, { timeout: 15_000 }) });
export const l2 = createPublicClient({ chain: robinhood, transport: fallback(L2.rpcs.map((u) => http(u, { timeout: 15_000 }))) });

const listeners = new Set();
export const state = { address: null, chainId: null };
export const onWallet = (fn) => { listeners.add(fn); fn(state); };
const emit = () => listeners.forEach((fn) => fn(state));

const kit = () => (typeof window !== "undefined" ? window.gmeWallet : null);
// the EIP-1193 provider of whichever wallet is connected
const prov = () => kit()?.provider || window.ethereum;
export function hasWallet() { return !!kit() || (typeof window !== "undefined" && !!window.ethereum); }

if (kit()) {
  window.addEventListener("gmewallet:change", (e) => {
    const { address, chainId } = e.detail || {};
    state.address = address ? viem.getAddress(address) : null;
    state.chainId = chainId || null;
    emit();
  });
} else if (window.ethereum) {
  window.ethereum.request({ method: "eth_accounts" }).then(async (accs) => {
    if (accs && accs[0]) {
      state.address = viem.getAddress(accs[0]);
      state.chainId = Number.parseInt(await window.ethereum.request({ method: "eth_chainId" }), 16);
      emit();
    }
  }).catch(() => {});
  window.ethereum.on?.("accountsChanged", (accs) => { state.address = accs && accs[0] ? viem.getAddress(accs[0]) : null; emit(); });
  window.ethereum.on?.("chainChanged", (id) => { state.chainId = Number.parseInt(id, 16); emit(); });
}

// Opens the RainbowKit modal (or the account panel when connected) and resolves with the address once connected.
export async function connect() {
  const k = kit();
  if (k) {
    if (state.address) { k.open(); return state.address; }
    k.open();
    return new Promise((resolve, reject) => {
      const t = setTimeout(() => { window.removeEventListener("gmewallet:change", on); reject(new Error("No wallet connected.")); }, 5 * 60_000);
      function on(e) { if (e.detail?.address) { clearTimeout(t); window.removeEventListener("gmewallet:change", on); resolve(viem.getAddress(e.detail.address)); } }
      window.addEventListener("gmewallet:change", on);
    });
  }
  if (!window.ethereum) throw new Error("No browser wallet found. Install MetaMask, Rabby or another EVM wallet.");
  const [addr] = await window.ethereum.request({ method: "eth_requestAccounts" });
  state.address = viem.getAddress(addr);
  state.chainId = Number.parseInt(await window.ethereum.request({ method: "eth_chainId" }), 16);
  emit();
  return state.address;
}

const PARAMS = {
  [L3.id]: { chainId: L3.hex, chainName: L3.name, nativeCurrency: { name: TOKEN, symbol: TOKEN, decimals: 18 }, rpcUrls: [L3.rpc] },
  [L2.id]: { chainId: L2.hex, chainName: L2.name, nativeCurrency: { name: "Ether", symbol: "ETH", decimals: 18 }, rpcUrls: [L2.walletRpc] },
};

export async function ensureChain(id) {
  if (!state.address) await connect();
  const p = prov();
  const current = Number.parseInt(await p.request({ method: "eth_chainId" }), 16);
  if (current === id) return;
  try {
    await p.request({ method: "wallet_switchEthereumChain", params: [{ chainId: PARAMS[id].chainId }] });
  } catch (e) {
    if (e && (e.code === 4902 || e.data?.originalError?.code === 4902 || /Unrecognized chain|not been added|unknown chain/i.test(e.message || ""))) {
      await p.request({ method: "wallet_addEthereumChain", params: [PARAMS[id]] });
    } else throw e;
  }
  state.chainId = id;
  emit();
}

export async function addNetwork(id = L3.id) {
  if (!state.address && kit()) await connect();
  const p = prov();
  if (!p) throw new Error("No browser wallet found.");
  await p.request({ method: "wallet_addEthereumChain", params: [PARAMS[id]] });
}

export function walletFor(id) {
  return createWalletClient({ account: state.address, chain: id === L3.id ? gmeChain : robinhood, transport: custom(prov()) });
}

// EIP-1193 error 4100: the wallet has not authorised this site for that account or network. New MetaMask
// versions grant sites access per network, and a WalletConnect session only covers the chains it was opened
// with, so a site connected on Robinhood Chain can be refused on GME CHAIN until the user allows it.
export const isUnauthorized = (e) => {
  for (let x = e, i = 0; x && i < 5; x = x.cause, i++) {
    if (x.code === 4100 || /not been authori[sz]ed|unauthori[sz]ed/i.test(x.shortMessage || x.message || "")) return true;
  }
  return false;
};
const UNAUTHORIZED_HELP = "Your wallet has not allowed gmechain.xyz to use this network yet. Open your wallet, allow this site on GME CHAIN (or disconnect and connect again), then try once more.";

// Ask the wallet to grant this site the network: switching prompts for it; failing that, ask for permissions again.
async function permitChain(id) {
  const p = prov();
  try {
    await p.request({ method: "wallet_switchEthereumChain", params: [{ chainId: PARAMS[id].chainId }] });
    return;
  } catch (e) {
    if (e && (e.code === 4902 || e.data?.originalError?.code === 4902)) { await p.request({ method: "wallet_addEthereumChain", params: [PARAMS[id]] }); return; }
    if (!isUnauthorized(e)) throw e;
  }
  await p.request({ method: "wallet_requestPermissions", params: [{ eth_accounts: {} }] });
}

// Run a wallet request; if the wallet answers 4100 (site not allowed on this network), ask for the
// permission once and retry. A second refusal gets a clear explanation instead of the raw wallet error.
async function withPermission(id, fn) {
  try { return await fn(); } catch (e) {
    if (!isUnauthorized(e)) throw e;
  }
  try { await permitChain(id); } catch (e) {
    if (e?.code === 4001) throw e; // the user said no to the permission prompt
    throw new Error(UNAUTHORIZED_HELP); // the wallet cannot grant it from here (e.g. an old WalletConnect session)
  }
  try { return await fn(); } catch (e) {
    if (isUnauthorized(e)) throw new Error(UNAUTHORIZED_HELP);
    throw e;
  }
}

// Show an ERC-20 on GME CHAIN in the wallet's token list (EIP-747). Switches the wallet to GME CHAIN first.
export async function watchToken({ address, symbol, decimals = 18, image }) {
  await withPermission(L3.id, () => ensureChain(L3.id));
  const options = { address, symbol: String(symbol).slice(0, 11), decimals };
  if (image) options.image = image;
  return withPermission(L3.id, () => prov().request({ method: "wallet_watchAsset", params: { type: "ERC20", options } }));
}

// Ask the connected wallet to sign a plain text message (free, no transaction, works on any network).
export async function signMessage(message) {
  if (!state.address) throw new Error("Connect a wallet first.");
  const p = prov();
  if (!p) throw new Error("No wallet found.");
  return withPermission(state.chainId || L2.id, () => createWalletClient({ account: state.address, transport: custom(prov()) }).signMessage({ account: state.address, message }));
}

// Send a contract write on chain `id` and wait for the receipt on our own RPC.
export async function write(id, req, onHash) {
  await withPermission(id, () => ensureChain(id));
  const hash = await withPermission(id, () => walletFor(id).writeContract({ ...req, account: state.address, chain: id === L3.id ? gmeChain : robinhood }));
  onHash?.(hash);
  const client = id === L3.id ? l3 : l2;
  const r = await client.waitForTransactionReceipt({ hash, timeout: 180_000 });
  if (r.status !== "success") throw new Error(`Transaction reverted (${hash.slice(0, 10)}…)`);
  return r;
}

export function friendlyError(e) {
  const m = e?.shortMessage || e?.message || String(e);
  if (e?.code === 4001 || /User rejected|denied/i.test(m)) return "Cancelled in your wallet.";
  if (isUnauthorized(e)) return UNAUTHORIZED_HELP;
  if (/insufficient funds/i.test(m)) return "Not enough gas in your wallet for this network.";
  return m.split("\n")[0].slice(0, 220);
}

export const fmt = (wei, dp = 6, decimals = 18) => {
  const s = viem.formatUnits(wei ?? 0n, decimals);
  const [i, f = ""] = s.split(".");
  let t = f.slice(0, dp); while (t.endsWith("0")) t = t.slice(0, -1);
  return Number(i).toLocaleString("en-US") + (t ? "." + t : "");
};
export const short = (a) => (a ? `${a.slice(0, 6)}…${a.slice(-4)}` : "");
