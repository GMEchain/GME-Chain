// Tightens the fee pricer's limits on the keeper: how far one update may move the GME price, and how often.
//   node scripts/pricer-params.js --mainnet --dry    rehearse on a fork of Robinhood Chain (default)
//   node scripts/pricer-params.js --mainnet --send   send setParams from the pricer owner
// MAX_DEV_BPS (default 300 = 3%), MIN_INTERVAL (default 900 s), FEED_MAX_AGE (default: keep the current value).
import os from "node:os";
import path from "node:path";
import { spawn } from "node:child_process";
import { createPublicClient, createWalletClient, http, parseAbi, parseEther, formatEther } from "viem";
import { NETWORK, S, parentChain, parentPublicClient, walletClient, account, loadDeployment, confirmMainnet } from "./lib.js";

if (NETWORK !== "mainnet") throw new Error("Run with --mainnet (add --dry or --send).");
const SEND = process.argv.includes("--send");
const dep = loadDeployment();
const PRICER = dep.feeTokenPricer;
const abi = parseAbi([
  "function owner() view returns (address)", "function keeper() view returns (address)",
  "function maxDeviationBps() view returns (uint256)", "function minUpdateInterval() view returns (uint256)", "function ethFeedMaxAge() view returns (uint256)",
  "function gmeUsd() view returns (uint256)", "function gmeUsdUpdatedAt() view returns (uint256)",
  "function setParams(uint256,uint256,uint256)", "function submitGmePrice(uint256)",
]);
const read = (c, fn) => c.readContract({ address: PRICER, abi, functionName: fn });
const cur = { bps: await read(parentPublicClient, "maxDeviationBps"), iv: await read(parentPublicClient, "minUpdateInterval"), age: await read(parentPublicClient, "ethFeedMaxAge") };
const NEW = { bps: BigInt(process.env.MAX_DEV_BPS || 300), iv: BigInt(process.env.MIN_INTERVAL || 900), age: BigInt(process.env.FEED_MAX_AGE || cur.age) };
const owner = await read(parentPublicClient, "owner");
console.log(`pricer ${PRICER}, owner ${owner}`);
console.log(`now:  max move ${Number(cur.bps) / 100}% per update, every >= ${cur.iv} s, ETH feed max age ${cur.age} s`);
console.log(`next: max move ${Number(NEW.bps) / 100}% per update, every >= ${NEW.iv} s, ETH feed max age ${NEW.age} s`);
if (NEW.bps === 0n || NEW.bps > 5000n || NEW.iv > 86400n || NEW.age < 300n) throw new Error("Out of the contract's allowed range. Nothing was sent.");

if (SEND) {
  const me = account("DEPLOYER");
  if (me.address.toLowerCase() !== owner.toLowerCase()) throw new Error(`The pricer owner is ${owner}, not the deployer. Nothing was sent.`);
  await confirmMainnet(`Set the fee pricer limits to ${Number(NEW.bps) / 100}% per update, every ${NEW.iv} s`);
  const h = await walletClient("DEPLOYER").writeContract({ address: PRICER, abi, functionName: "setParams", args: [NEW.bps, NEW.iv, NEW.age] });
  const r = await parentPublicClient.waitForTransactionReceipt({ hash: h });
  console.log(`setParams ${r.status} in ${h}`);
  console.log(`check: ${await read(parentPublicClient, "maxDeviationBps")} bps, ${await read(parentPublicClient, "minUpdateInterval")} s`);
  process.exit(r.status === "success" ? 0 : 1);
}

// ---------- rehearsal on a fork: owner sets the limits, then the keeper's real stepping logic is tried against them
const ANVIL = process.env.ANVIL_BIN || path.join(os.homedir(), ".foundry", "bin", process.platform === "win32" ? "anvil.exe" : "anvil");
const anvil = spawn(ANVIL, ["--fork-url", S.rpc, "--port", "8553", "--chain-id", "4663", "--silent", "--no-rate-limit"], { stdio: "ignore" });
const RPC = "http://127.0.0.1:8553";
const rpc = (method, params) => fetch(RPC, { method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify({ jsonrpc: "2.0", id: 1, method, params }) }).then((r) => r.json()).then((j) => { if (j.error) throw new Error(j.error.message); return j.result; });
try {
  for (let i = 0; i < 120; i++) { try { await rpc("eth_chainId", []); break; } catch { await new Promise((r) => setTimeout(r, 500)); } }
  const pub = createPublicClient({ chain: parentChain, transport: http(RPC) });
  const as = (addr) => createWalletClient({ chain: parentChain, transport: http(RPC), account: addr });
  const keeper = await read(pub, "keeper");
  for (const a of [owner, keeper]) { await rpc("anvil_impersonateAccount", [a]); await rpc("anvil_setBalance", [a, "0xDE0B6B3A7640000"]); }
  const tx = async (from, fn, args) => { const h = await as(from).writeContract({ address: PRICER, abi, functionName: fn, args }); return (await pub.waitForTransactionReceipt({ hash: h })).status === "success"; };
  const fails = (from, fn, args) => tx(from, fn, args).then(() => null, (e) => (e.shortMessage || e.message).split("\n")[0]);
  const ok = (c, m) => { console.log(`  ${c ? "PASS" : "FAIL"}  ${m}`); if (!c) throw new Error("rehearsal failed"); };

  ok(await tx(owner, "setParams", [NEW.bps, NEW.iv, NEW.age]), "owner sets the new limits");
  ok((await read(pub, "maxDeviationBps")) === NEW.bps && (await read(pub, "minUpdateInterval")) === NEW.iv, "limits read back");
  const warp = async (s) => { await rpc("evm_increaseTime", [Number(s)]); await rpc("evm_mine", []); };
  await warp(NEW.iv);
  const p0 = await read(pub, "gmeUsd");
  // the keeper steps inside the band minus a 0.5% margin, exactly like scripts/keeper.js
  const band = Number(NEW.bps) / 10000 - 0.005;
  const step = BigInt(Math.floor(band * 1e6));
  const up = (p) => p + (p * step) / 1_000_000n;
  ok(await tx(keeper, "submitGmePrice", [up(p0)]), `keeper step +${(band * 100).toFixed(1)}% accepted`);
  ok(!!(await fails(keeper, "submitGmePrice", [up(up(p0))])), `a second step within ${NEW.iv} s is refused (TooSoon)`);
  await warp(NEW.iv);
  const p1 = await read(pub, "gmeUsd");
  ok(!!(await fails(keeper, "submitGmePrice", [p1 + (p1 * (NEW.bps + 50n)) / 10000n])), `a jump above ${Number(NEW.bps) / 100}% is refused (DeviationTooLarge)`);
  // a 20% move: how long the keeper needs to catch up
  let p = p1, n = 0; const target = (p1 * 120n) / 100n;
  while (p < target && n < 50) { await warp(NEW.iv); const nx = up(p) > target ? target : up(p); ok(await tx(keeper, "submitGmePrice", [nx]), `step ${++n} to $${Number(formatEther(nx)).toFixed(2)}`); p = nx; }
  console.log(`\nREHEARSAL PASSED. A 20% GME move is followed in ${n} steps, about ${Math.round((n * Number(NEW.iv)) / 60)} minutes.`);
} finally { anvil.kill(); }
