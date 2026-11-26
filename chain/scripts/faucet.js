// GME CHAIN testnet faucet ("Get test kit"): sends a little testnet ETH for gas plus tGME on
// Robinhood Chain Testnet to a tester's address, so nobody needs a third-party faucet.
// POST /claim {"address":"0x..."}   GET /health
// Limits: one kit per address and per IP every 24 hours, and a global hourly cap.
// Env: NETWORK=testnet, FAUCET_PRIVATE_KEY, FAUCET_ADDRESS, PARENT_RPC, KIT_ETH (default 0.00005), KIT_TGME (default 100)
import http from "node:http";
import { parseEther, formatEther, isAddress, getAddress } from "viem";
import { NETWORK, parentPublicClient as p, walletClient, account, loadDeployment, erc20Abi } from "./lib.js";

if (NETWORK !== "testnet") throw new Error("The faucet runs on testnet only.");
const dep = loadDeployment();
const TGME = dep.nativeToken;
const me = account("FAUCET");
const w = walletClient("FAUCET");
const KIT_ETH = parseEther(process.env.KIT_ETH || "0.00005");
const KIT_TGME = parseEther(process.env.KIT_TGME || "100");
const DAY = 24 * 3600 * 1000, HOURLY_CAP = Number(process.env.HOURLY_CAP || 60);
const byAddr = new Map(), byIp = new Map(), recent = [];
let queue = Promise.resolve(); // one claim at a time so nonces never collide

const json = (res, code, body) => {
  res.writeHead(code, { "content-type": "application/json", "cache-control": "no-store" });
  res.end(JSON.stringify(body));
};
const clientIp = (req) => (req.headers["x-forwarded-for"] || req.socket.remoteAddress || "").split(",")[0].trim();

async function sendKit(to) {
  const [eth, tgme] = await Promise.all([p.getBalance({ address: to }), p.readContract({ address: TGME, abi: erc20Abi, functionName: "balanceOf", args: [to] })]);
  const out = { address: to, eth: null, tgme: null };
  if (eth < KIT_ETH) { // only top up gas when the wallet is short
    const h = await w.sendTransaction({ to, value: KIT_ETH - eth });
    await p.waitForTransactionReceipt({ hash: h });
    out.eth = { amount: formatEther(KIT_ETH - eth), tx: h };
  }
  if (tgme < KIT_TGME * 5n) { // skip tGME for wallets that already hold plenty
    const h = await w.writeContract({ address: TGME, abi: erc20Abi, functionName: "transfer", args: [to, KIT_TGME] });
    await p.waitForTransactionReceipt({ hash: h });
    out.tgme = { amount: formatEther(KIT_TGME), tx: h };
  }
  return out;
}

http.createServer(async (req, res) => {
  try {
    if (req.method === "GET" && req.url.startsWith("/health")) {
      const [eth, tgme] = await Promise.all([p.getBalance({ address: me.address }), p.readContract({ address: TGME, abi: erc20Abi, functionName: "balanceOf", args: [me.address] })]);
      return json(res, 200, { ok: true, faucet: me.address, eth: formatEther(eth), tgme: formatEther(tgme), kitsLeft: Number(eth / (KIT_ETH + parseEther("0.000002"))) });
    }
    if (req.method !== "POST" || !req.url.startsWith("/claim")) return json(res, 404, { error: "not found" });
    let body = "";
    for await (const chunk of req) { body += chunk; if (body.length > 2000) return json(res, 413, { error: "too large" }); }
    let address;
    try { address = JSON.parse(body).address; } catch { return json(res, 400, { error: "Send JSON: {\"address\":\"0x...\"}" }); }
    if (!isAddress(address || "")) return json(res, 400, { error: "That is not a valid address." });
    address = getAddress(address);
    const now = Date.now(), ip = clientIp(req);
    const last = Math.max(byAddr.get(address) || 0, byIp.get(ip) || 0);
    if (now - last < DAY) return json(res, 429, { error: "This wallet (or network) already got a test kit today. Try again in 24 hours.", retryAt: new Date(last + DAY).toISOString() });
    while (recent.length && now - recent[0] > 3600_000) recent.shift();
    if (recent.length >= HOURLY_CAP) return json(res, 429, { error: "The faucet is busy. Try again in a few minutes." });
    byAddr.set(address, now); byIp.set(ip, now); recent.push(now);
    const job = queue.then(() => sendKit(address));
    queue = job.catch(() => {});
    const out = await job;
    console.log(JSON.stringify({ t: new Date().toISOString(), msg: "kit sent", ...out }));
    return json(res, 200, { ok: true, ...out });
  } catch (e) {
    console.log(JSON.stringify({ t: new Date().toISOString(), msg: "claim failed", err: e.shortMessage || e.message }));
    return json(res, 500, { error: "The faucet could not send right now. Try again shortly." });
  }
}).listen(Number(process.env.PORT || 8080), "::", () => console.log(JSON.stringify({ msg: "faucet up", faucet: me.address, kitEth: formatEther(KIT_ETH), kitTgme: formatEther(KIT_TGME) })));
