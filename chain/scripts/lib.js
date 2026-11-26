// Shared setup: network selection, env, DNS workaround, viem clients.
//
// NETWORK=mainnet  Robinhood Chain (4663), real GME as gas, keys from ../.env.mainnet
// NETWORK=fork     local Anvil fork of Robinhood Chain mainnet (free rehearsal), keys from ../.env.mainnet
// NETWORK=testnet  Robinhood Chain Testnet (46630), tGME as gas, keys from ../.env
import { config } from "dotenv";
import https from "node:https";
import { readFileSync, writeFileSync, existsSync } from "node:fs";
import { fileURLToPath } from "node:url";
import path from "node:path";
import readline from "node:readline/promises";
import { Agent, setGlobalDispatcher } from "undici";
import { createPublicClient, createWalletClient, defineChain, http } from "viem";
import { privateKeyToAccount } from "viem/accounts";

const here = path.dirname(fileURLToPath(import.meta.url));
export const ROOT = path.resolve(here, "..");

const flag = process.argv.find((a) => ["--mainnet", "--fork", "--testnet"].includes(a));
export const NETWORK = process.env.NETWORK || (flag ? flag.slice(2) : "testnet");
if (!["mainnet", "fork", "testnet"].includes(NETWORK)) throw new Error(`Unknown NETWORK=${NETWORK}`);
const usesMainnetKeys = NETWORK !== "testnet";
// override: the network's own key file always wins over variables left in the shell,
// so a testnet key exported in a terminal can never be used for a mainnet run.
config({ path: path.resolve(ROOT, "..", usesMainnetKeys ? ".env.mainnet" : ".env"), quiet: true, override: true });

// ---------- DNS-over-HTTPS (some ISPs hijack *.robinhood.com, even plain UDP to 1.1.1.1) ----------
const dohCache = new Map();
function dohResolve(hostname) {
  if (hostname === "localhost" || /^\d+\.\d+\.\d+\.\d+$/.test(hostname)) return Promise.resolve([hostname === "localhost" ? "127.0.0.1" : hostname]);
  const hit = dohCache.get(hostname);
  if (hit && hit.expires > Date.now()) return Promise.resolve(hit.addrs);
  return new Promise((resolve, reject) => {
    https
      .get(
        `https://cloudflare-dns.com/dns-query?name=${encodeURIComponent(hostname)}&type=A`,
        { headers: { accept: "application/dns-json" }, timeout: 10_000 },
        (res) => {
          let body = "";
          res.on("data", (c) => (body += c));
          res.on("end", () => {
            try {
              const answers = (JSON.parse(body).Answer || []).filter((a) => a.type === 1);
              if (!answers.length) return reject(new Error(`DoH: no A record for ${hostname}`));
              const addrs = answers.map((a) => a.data);
              const ttl = Math.max(30, Math.min(...answers.map((a) => a.TTL)));
              dohCache.set(hostname, { addrs, expires: Date.now() + ttl * 1000 });
              resolve(addrs);
            } catch (e) {
              reject(e);
            }
          });
        },
      )
      .on("error", reject);
  });
}
setGlobalDispatcher(
  new Agent({
    connect: {
      lookup(hostname, opts, cb) {
        dohResolve(hostname).then(
          (addrs) => (opts && opts.all ? cb(null, addrs.map((a) => ({ address: a, family: 4 }))) : cb(null, addrs[0], 4)),
          (err) => cb(err),
        );
      },
    },
  }),
);

// ---------- chains ----------
const rhMainnet = defineChain({
  id: 4663,
  network: "robinhood-chain",
  name: "Robinhood Chain",
  nativeCurrency: { name: "Ether", symbol: "ETH", decimals: 18 },
  rpcUrls: {
    default: { http: ["https://rpc.mainnet.chain.robinhood.com"] },
    public: { http: ["https://rpc.mainnet.chain.robinhood.com"] },
  },
  blockExplorers: { default: { name: "Blockscout", url: "https://robinhoodchain.blockscout.com" } },
  // Arbitrum chains ignore priority fees; Robinhood Chain RPCs report 0. Anvil forks default
  // to 1 gwei, which would make the rehearsal behave unlike mainnet, so pin it to 0.
  fees: { defaultPriorityFee: 0n },
});
const rhTestnet = defineChain({
  id: 46630,
  network: "robinhood-chain-testnet",
  name: "Robinhood Chain Testnet",
  nativeCurrency: { name: "Sepolia Ether", symbol: "ETH", decimals: 18 },
  rpcUrls: {
    default: { http: ["https://rpc.testnet.chain.robinhood.com"] },
    public: { http: ["https://rpc.testnet.chain.robinhood.com"] },
  },
  blockExplorers: { default: { name: "Blockscout", url: "https://explorer.testnet.chain.robinhood.com" } },
  testnet: true,
});

// ---------- per-network settings ----------
export const GME_TOKEN = "0x1b0E319c6A659F002271B69dB8A7df2F911c153E"; // GameStop • Robinhood Token, verified on-chain 2026-11-26 (same Robinhood beacon 0xe10b…1b00 as every stock token)
export const FORK_RPC = "http://127.0.0.1:8545";
export const erc20Abi = [
  { type: "function", name: "balanceOf", stateMutability: "view", inputs: [{ name: "a", type: "address" }], outputs: [{ type: "uint256" }] },
  { type: "function", name: "transfer", stateMutability: "nonpayable", inputs: [{ name: "to", type: "address" }, { name: "v", type: "uint256" }], outputs: [{ type: "bool" }] },
  { type: "function", name: "approve", stateMutability: "nonpayable", inputs: [{ name: "s", type: "address" }, { name: "v", type: "uint256" }], outputs: [{ type: "bool" }] },
  { type: "function", name: "allowance", stateMutability: "view", inputs: [{ name: "o", type: "address" }, { name: "s", type: "address" }], outputs: [{ type: "uint256" }] },
];

// Chainlink ETH/USD on Robinhood Chain mainnet, verified on-chain 2026-11-20 ("ETH / USD", 8 decimals).
export const CHAINLINK_ETH_USD_MAINNET = "0x78F3556b67E17Df817D51Ef5a990cDaF09E8d3A9";

// Mainnet parent RPC: PARENT_RPC unless it is clearly a testnet RPC left over in the shell (then dRPC).
const MAINNET_DEFAULT_RPC = "https://robinhood.drpc.org";
const MAINNET_PARENT_RPC = (() => {
  const v = process.env.PARENT_RPC;
  if (!v) return MAINNET_DEFAULT_RPC;
  if (/testnet/i.test(v)) {
    if (NETWORK === "mainnet") console.warn(`Note: ignoring PARENT_RPC=${v} (a testnet RPC) for mainnet; using ${MAINNET_DEFAULT_RPC}.`);
    return MAINNET_DEFAULT_RPC;
  }
  return v;
})();

const SETTINGS = {
  // the official Robinhood RPC does not answer from some networks (ISP DNS), so scripts default to dRPC
  mainnet: { parentChain: rhMainnet, rpc: MAINNET_PARENT_RPC, chainId: 12821, chainName: "GME CHAIN", nativeToken: GME_TOKEN, ethUsdFeed: CHAINLINK_ETH_USD_MAINNET, deploymentFile: "deployment.mainnet.json" },
  fork: { parentChain: rhMainnet, rpc: FORK_RPC, chainId: 12821, chainName: "GME CHAIN (fork rehearsal)", nativeToken: GME_TOKEN, ethUsdFeed: CHAINLINK_ETH_USD_MAINNET, deploymentFile: "deployment.fork.json" },
  testnet: { parentChain: rhTestnet, rpc: process.env.PARENT_RPC || rhTestnet.rpcUrls.default.http[0], chainId: 12822, chainName: "GME CHAIN Testnet", nativeToken: null, ethUsdFeed: process.env.TESTNET_ETH_USD_FEED || null, deploymentFile: "deployment.testnet.json" },
};
export const S = SETTINGS[NETWORK];
export const CHAIN_ID = S.chainId;
export const CHAIN_NAME = S.chainName;
export const parentChain = S.parentChain;

const transport = http(S.rpc, { timeout: 120_000 });
export const parentPublicClient = createPublicClient({ chain: parentChain, transport });

// Mainnet scripts run from a terminal check the parent RPC first: it must answer as Robinhood Chain (4663)
// and see the GME token. A wrong or blocked RPC otherwise shows up later as confusing "returned no data" errors.
if (NETWORK === "mainnet" && process.stdin.isTTY) {
  const fail = (why) => {
    console.error(`\nRobinhood Chain RPC problem: ${why}\nRPC in use: ${S.rpc}\nFix: set a working RPC first, e.g. PowerShell:  $env:PARENT_RPC="https://robinhood.drpc.org"\nNothing was sent.\n`);
    process.exit(1);
  };
  const id = await parentPublicClient.getChainId().catch((e) => fail(`it did not answer (${e.shortMessage || e.message})`));
  if (id !== 4663) fail(`it answered as chain ${id}, not Robinhood Chain (4663)`);
  const code = await parentPublicClient.getBytecode({ address: GME_TOKEN }).catch(() => null);
  if (!code || code === "0x") fail("it does not see the GME token contract");
}

export function env(name) {
  const v = process.env[name];
  if (!v) throw new Error(`Missing ${name} in ${usesMainnetKeys ? ".env.mainnet" : ".env"}`);
  return v;
}
export function account(role) {
  const acct = privateKeyToAccount(env(`${role}_PRIVATE_KEY`));
  // the key must belong to the address recorded for this role in the same key file
  const expected = process.env[`${role}_ADDRESS`];
  if (expected && expected.toLowerCase() !== acct.address.toLowerCase()) {
    throw new Error(`${role} key does not match ${role}_ADDRESS for NETWORK=${NETWORK} (${acct.address} vs ${expected}). Check your key file and shell variables; nothing was sent.`);
  }
  return acct;
}
export function walletClient(role) {
  return createWalletClient({ chain: parentChain, transport, account: account(role) });
}

// ---------- deployment record ----------
const DEPLOYMENT = path.join(ROOT, S.deploymentFile);
export function loadDeployment() {
  return existsSync(DEPLOYMENT) ? JSON.parse(readFileSync(DEPLOYMENT, "utf8")) : {};
}
export function saveDeployment(patch) {
  const next = { ...loadDeployment(), ...patch };
  writeFileSync(DEPLOYMENT, JSON.stringify(next, (_, v) => (typeof v === "bigint" ? v.toString() : v), 2));
  return next;
}

// ---------- safety ----------
// Every script that sends mainnet transactions calls this first.
export async function confirmMainnet(action) {
  if (NETWORK !== "mainnet") return;
  const fork = loadForkRehearsal();
  if (!fork.passed) throw new Error("Mainnet is locked until the fork rehearsal passes. Run: npm run rehearse");
  console.log(`\n*** MAINNET *** ${action}\nThis spends real ETH/GME and cannot be undone.`);
  const rl = readline.createInterface({ input: process.stdin, output: process.stdout });
  const answer = await rl.question('Type "deploy mainnet" to continue: ');
  rl.close();
  if (answer.trim() !== "deploy mainnet") throw new Error("Aborted.");
}
const REHEARSAL = path.join(ROOT, "rehearsal.json");
export function loadForkRehearsal() {
  return existsSync(REHEARSAL) ? JSON.parse(readFileSync(REHEARSAL, "utf8")) : {};
}
export function saveForkRehearsal(r) {
  writeFileSync(REHEARSAL, JSON.stringify(r, null, 2));
}
