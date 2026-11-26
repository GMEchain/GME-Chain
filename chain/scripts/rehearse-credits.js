// Rehearsal of $GMEC gas credits on local Anvil forks of Robinhood Chain mainnet and GME CHAIN mainnet, with the
// real $GMEC token and the real scripts (07-gmec-staking.js, 09-credits-setup.js, credits.js). Nothing real is sent.
//   1. staking deployed on the Robinhood Chain fork (07)
//   2. 09 funds the gas pot from launchpad fee income only (WGME held by the treasury), never the deployer's own GME
//   3. a user stakes real $GMEC, earns credits, claims gas with a signed message through credits.js
//   4. the service restarts and still remembers the claim (no second claim the same day), a forged signature is refused
//   5. with the pot empty, /info reports claims closed
//   node scripts/rehearse-credits.js --mainnet
import os from "node:os";
import fs from "node:fs";
import path from "node:path";
import { spawn, execFileSync } from "node:child_process";
import { createPublicClient, createWalletClient, defineChain, http, parseAbi, parseEther, formatEther, toHex } from "viem";
import { privateKeyToAccount, generatePrivateKey } from "viem/accounts";
import { ROOT, NETWORK, S, parentChain, loadDeployment } from "./lib.js";

if (NETWORK !== "mainnet") throw new Error("Run with --mainnet: this rehearses on forks of the mainnets.");
const GMEC = process.env.GMEC_TOKEN || "0xa8c53b1dAcFbd07895dC8D2c638F1bFDe10C0122";
const ANVIL = process.env.ANVIL_BIN || path.join(os.homedir(), ".foundry", "bin", process.platform === "win32" ? "anvil.exe" : "anvil");
const L2 = "http://127.0.0.1:8561", L3 = "http://127.0.0.1:8562", SVC = "http://127.0.0.1:8563";
const dep = loadDeployment();
const WGME = dep.dex.wrappedGme;
const call = (url, method, params) => fetch(url, { method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify({ jsonrpc: "2.0", id: 1, method, params }) }).then((r) => r.json()).then((j) => { if (j.error) throw new Error(j.error.message); return j.result; });
const ok = (c, m) => { console.log(`  ${c ? "PASS" : "FAIL"}  ${m}`); if (!c) throw new Error(`rehearsal failed: ${m}`); };
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
const up = async (url) => { for (let i = 0; i < 120; i++) { try { await call(url, "eth_chainId", []); return; } catch { await sleep(500); } } throw new Error(`${url} did not start`); };

const l3chain = defineChain({ id: 12821, name: "GME CHAIN", nativeCurrency: { name: "GME", symbol: "GME", decimals: 18 }, rpcUrls: { default: { http: [L3] } } });
const pub2 = createPublicClient({ chain: parentChain, transport: http(L2) });
const pub3 = createPublicClient({ chain: l3chain, transport: http(L3) });
const procs = [
  spawn(ANVIL, ["--fork-url", S.rpc, "--port", "8561", "--chain-id", "4663", "--silent", "--no-rate-limit"], { stdio: "ignore" }),
  spawn(ANVIL, ["--fork-url", "https://rpc.gmechain.xyz", "--port", "8562", "--chain-id", "12821", "--silent", "--no-rate-limit"], { stdio: "ignore" }),
];
const stateFile = path.join(os.tmpdir(), `credits-rehearsal-${Date.now()}.json`);
let svc = null;
const startService = async (env) => {
  svc = spawn(process.execPath, [path.join(ROOT, "scripts", "credits.js"), "--mainnet"], { cwd: ROOT, env, stdio: ["ignore", "pipe", "pipe"] });
  let log = "";
  svc.stdout.on("data", (d) => { log += d; });
  svc.stderr.on("data", (d) => { log += d; });
  for (let i = 0; i < 60; i++) { try { await fetch(`${SVC}/info`); return () => log; } catch { await sleep(500); } }
  throw new Error(`credits.js did not start:\n${log}`);
};
const stopService = async () => { if (!svc) return; svc.kill(); await new Promise((r) => svc.once("exit", r)); svc = null; };

try {
  await Promise.all([up(L2), up(L3)]);
  const me = process.env.DEPLOYER_ADDRESS;
  const user = privateKeyToAccount(generatePrivateKey());
  const redeemerKey = generatePrivateKey(), redeemer = privateKeyToAccount(redeemerKey).address;
  await call(L2, "anvil_setBalance", [me, toHex(parseEther("1"))]);
  await call(L2, "anvil_dealERC20", [me, GMEC, toHex(parseEther("10"))]); // 07 stakes 1 token from the deployer as a check
  await call(L2, "anvil_setBalance", [user.address, toHex(parseEther("0.01"))]);
  await call(L2, "anvil_dealERC20", [user.address, GMEC, toHex(parseEther("5000"))]);
  await call(L3, "anvil_setBalance", [me, toHex(parseEther("10"))]);

  console.log("1. staking contract (scripts/07-gmec-staking.js on the Robinhood Chain fork)");
  const out = execFileSync(process.execPath, [path.join(ROOT, "scripts", "07-gmec-staking.js"), "--mainnet"], { cwd: ROOT, env: { ...process.env, PARENT_RPC: L2, GMEC_TOKEN: GMEC }, encoding: "utf8" });
  const staking = JSON.parse(out.split("\n").find((l) => l.includes("rehearsalStaking"))).rehearsalStaking.address;
  ok(!!staking, `GmecStaking ${staking}`);

  console.log("2. gas pot funded from launchpad fee income only (scripts/09-credits-setup.js)");
  const wAbi = parseAbi(["function deposit() payable", "function balanceOf(address) view returns (uint256)"]);
  const dw = createWalletClient({ chain: l3chain, transport: http(L3), account: me });
  await call(L3, "anvil_impersonateAccount", [me]);
  // stand-in for the treasury half of launchpad fees, which the treasury receives as WGME
  await pub3.waitForTransactionReceipt({ hash: await dw.writeContract({ address: WGME, abi: wAbi, functionName: "deposit", value: parseEther("0.002") }) });
  const wBefore = await pub3.readContract({ address: WGME, abi: wAbi, functionName: "balanceOf", args: [me] });
  const run09 = (extra) => execFileSync(process.execPath, [path.join(ROOT, "scripts", "09-credits-setup.js"), "--mainnet"], { cwd: ROOT, env: { ...process.env, PARENT_RPC: L2, L3_RPC: L3, STAKING_ADDRESS: staking, REDEEMER_ADDRESS: redeemer, ...extra }, encoding: "utf8" });
  const o9 = run09({ FUND_GME: "0.005" }); // asks for more than the fee income holds
  process.stdout.write(o9.split("\n").filter((l) => /income|NOTE/.test(l)).map((l) => `    ${l.trim()}`).join("\n") + "\n");
  const pot = await pub3.getBalance({ address: redeemer });
  const wAfter = await pub3.readContract({ address: WGME, abi: wAbi, functionName: "balanceOf", args: [me] });
  ok(pot === wBefore && wAfter === 0n, `pot got exactly the fee income (${formatEther(pot)} GME), capped below the 0.005 asked`);
  const stAbi = parseAbi(["function redeemer() view returns (address)", "function creditsOf(address) view returns (uint256)", "function stake(uint256)"]);
  ok((await pub2.readContract({ address: staking, abi: stAbi, functionName: "redeemer" })).toLowerCase() === redeemer.toLowerCase(), "staking redeemer set to the service wallet");

  console.log("3. a user stakes real $GMEC and claims gas");
  const uw = createWalletClient({ chain: parentChain, transport: http(L2), account: user });
  const erc = parseAbi(["function approve(address,uint256) returns (bool)"]);
  await pub2.waitForTransactionReceipt({ hash: await uw.writeContract({ address: GMEC, abi: erc, functionName: "approve", args: [staking, parseEther("1000")] }) });
  await pub2.waitForTransactionReceipt({ hash: await uw.writeContract({ address: staking, abi: stAbi, functionName: "stake", args: [parseEther("1000")] }) });
  await call(L2, "evm_increaseTime", [2 * 86400]); await call(L2, "evm_mine", []);
  const c0 = await pub2.readContract({ address: staking, abi: stAbi, functionName: "creditsOf", args: [user.address] });
  ok(c0 >= parseEther("1999"), `~2000 credits after 2 days (${Number(formatEther(c0)).toFixed(1)})`);

  const env = { ...process.env, PARENT_RPC: L2, L3_RPC: L3, STAKING_ADDRESS: staking, REDEEMER_PRIVATE_KEY: redeemerKey, REDEEMER_ADDRESS: redeemer, CREDITS_PER_CLAIM: "1000", GAS_PER_CLAIM: "0.0005", STATE_FILE: stateFile, PORT: "8563" };
  let logs = await startService(env);
  const info = await (await fetch(`${SVC}/info`)).json();
  ok(info.open === true, `/info: open, ${info.gasPerClaim} GME per claim for ${info.creditsPerClaim} credits`);
  const claim = async (signer = user) => {
    const message = `GME CHAIN gas claim\nAddress: ${user.address}\nChain: 12821\nIssued: ${new Date().toISOString()}`;
    const signature = await signer.signMessage({ message });
    const r = await fetch(`${SVC}/claim`, { method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify({ address: user.address, message, signature }) });
    return { status: r.status, body: await r.json() };
  };
  const g0 = await pub3.getBalance({ address: user.address });
  const r1 = await claim();
  ok(r1.status === 200 && r1.body.gasTx, `claim accepted (spendCredits ${r1.body.spendTx?.slice(0, 10)}…, gas ${r1.body.gasTx?.slice(0, 10)}…)`);
  ok((await pub3.getBalance({ address: user.address })) - g0 === parseEther("0.0005"), "0.0005 GME arrived on GME CHAIN");
  const c1 = await pub2.readContract({ address: staking, abi: stAbi, functionName: "creditsOf", args: [user.address] });
  ok(c0 - c1 >= parseEther("999.9") && c0 - c1 <= parseEther("1000.1"), "1000 credits spent on Robinhood Chain");

  console.log("4. restart: the claim is remembered");
  await stopService();
  const saved = JSON.parse(fs.readFileSync(stateFile, "utf8"));
  ok(saved.byAddr.length === 1 && saved.pending.length === 0, "state file: 1 claim today, nothing undelivered");
  logs = await startService(env);
  const r2 = await claim();
  ok(r2.status === 429 && /already claimed/.test(r2.body.error), `second claim the same day refused after restart: "${r2.body.error}"`);
  const r3 = await claim(privateKeyToAccount(generatePrivateKey()));
  ok(r3.status === 401, `forged signature refused: "${r3.body.error}"`);

  console.log("5. pot empty -> claims closed");
  await call(L3, "anvil_setBalance", [redeemer, toHex(parseEther("0.0009"))]);
  const info2 = await (await fetch(`${SVC}/info`)).json();
  ok(info2.open === false, "/info: closed while the pot holds less than one claim");
  void logs;
  console.log("\nREHEARSAL PASSED");
} finally {
  await stopService().catch(() => {});
  for (const p of procs) p.kill();
  fs.rmSync(stateFile, { force: true }); fs.rmSync(`${stateFile}.tmp`, { force: true });
}
