// Rehearsal of $GMEC staking on a local Anvil fork of Robinhood Chain mainnet, with the real $GMEC token and the
// real deploy script (scripts/07-gmec-staking.js), then the guarantees the docs promise:
//   - credits grow with time (token-days), unstaking returns everything, credits stay after unstaking
//   - the owner can pause NEW stakes but never block unstaking
//   - the owner cannot take staked $GMEC (recover refuses the staking token)
//   - only the redeemer can spend credits, and never more than a user has
//   node scripts/rehearse-staking.js --mainnet
import os from "node:os";
import fs from "node:fs";
import path from "node:path";
import { spawn, execFileSync } from "node:child_process";
import { createPublicClient, createWalletClient, http, parseAbi, parseEther, formatEther, keccak256, toHex } from "viem";
import { ROOT, NETWORK, S, parentChain } from "./lib.js";

if (NETWORK !== "mainnet") throw new Error("Run with --mainnet: this rehearses on a fork of Robinhood Chain mainnet.");
const GMEC = process.env.GMEC_TOKEN || "0xa8c53b1dAcFbd07895dC8D2c638F1bFDe10C0122";
const ANVIL = process.env.ANVIL_BIN || path.join(os.homedir(), ".foundry", "bin", process.platform === "win32" ? "anvil.exe" : "anvil");
const PORT = 8559, RPC = `http://127.0.0.1:${PORT}`;
const rpc = (method, params) => fetch(RPC, { method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify({ jsonrpc: "2.0", id: 1, method, params }) }).then((r) => r.json()).then((j) => { if (j.error) throw new Error(j.error.message); return j.result; });
const ok = (c, m) => { console.log(`  ${c ? "PASS" : "FAIL"}  ${m}`); if (!c) throw new Error(`rehearsal failed: ${m}`); };
const refused = (p) => p.then(() => false, () => true);

const anvil = spawn(ANVIL, ["--fork-url", S.rpc, "--port", String(PORT), "--chain-id", "4663", "--silent", "--no-rate-limit"], { stdio: "ignore" });
try {
  for (let i = 0; i < 120; i++) { try { await rpc("eth_chainId", []); break; } catch { await new Promise((r) => setTimeout(r, 500)); } }
  const me = process.env.DEPLOYER_ADDRESS, user = "0x7E57000000000000000000000000000000000003", redeemer = "0x7E57000000000000000000000000000000000004";
  for (const a of [me, user, redeemer]) {
    await rpc("anvil_setBalance", [a, "0xDE0B6B3A7640000"]);
    await rpc("anvil_dealERC20", [a, GMEC, toHex(parseEther("1000"))]);
  }

  console.log("1. deploy + stake/unstake (scripts/07-gmec-staking.js on the fork)");
  const out = execFileSync(process.execPath, [path.join(ROOT, "scripts", "07-gmec-staking.js"), "--mainnet"], { cwd: ROOT, env: { ...process.env, PARENT_RPC: RPC, GMEC_TOKEN: GMEC }, encoding: "utf8" });
  process.stdout.write(out.split("\n").filter((l) => /✓|staking token|deployed/.test(l)).map((l) => `    ${l.trim()}`).join("\n") + "\n");
  const staking = JSON.parse(out.split("\n").find((l) => l.includes("rehearsalStaking"))).rehearsalStaking.address;
  const ABI = JSON.parse(fs.readFileSync(path.join(ROOT, "out/GmecStaking.sol/GmecStaking.json"), "utf8")).abi;
  const erc = parseAbi(["function approve(address,uint256) returns (bool)", "function balanceOf(address) view returns (uint256)"]);
  const pub = createPublicClient({ chain: parentChain, transport: http(RPC) });
  for (const a of [me, user, redeemer]) await rpc("anvil_impersonateAccount", [a]);
  const as = (a) => createWalletClient({ chain: parentChain, transport: http(RPC), account: a });
  const tx = async (from, req) => { const r = await pub.waitForTransactionReceipt({ hash: await as(from).writeContract(req) }); if (r.status !== "success") throw new Error("reverted"); return r; };
  const read = (fn, args = []) => pub.readContract({ address: staking, abi: ABI, functionName: fn, args });

  console.log("2. a user stakes real $GMEC");
  await tx(user, { address: GMEC, abi: erc, functionName: "approve", args: [staking, parseEther("100")] });
  await tx(user, { address: staking, abi: ABI, functionName: "stake", args: [parseEther("100")] });
  await rpc("evm_increaseTime", [3 * 86400]); await rpc("evm_mine", []);
  const c = await read("creditsOf", [user]);
  ok(Math.abs(Number(formatEther(c)) - 300) < 0.1, `100 $GMEC for 3 days = ~300 credits (${Number(formatEther(c)).toFixed(3)})`);

  console.log("3. what the owner can and cannot do");
  await tx(me, { address: staking, abi: ABI, functionName: "setStakingOpen", args: [false] });
  ok(await refused(tx(user, { address: staking, abi: ABI, functionName: "stake", args: [1n] })), "paused: new stakes are refused");
  ok(await refused(tx(me, { address: staking, abi: ABI, functionName: "recover", args: [GMEC, me] })), "owner cannot take the staked $GMEC (recover refuses it)");
  ok(await refused(tx(user, { address: staking, abi: ABI, functionName: "spendCredits", args: [user, 1n, keccak256(toHex("x"))] })), "only the redeemer can spend credits");
  await tx(me, { address: staking, abi: ABI, functionName: "setRedeemer", args: [redeemer] });
  await tx(redeemer, { address: staking, abi: ABI, functionName: "spendCredits", args: [user, parseEther("50"), keccak256(toHex("claim-1"))] });
  ok(Math.abs(Number(formatEther(await read("creditsOf", [user]))) - 250) < 0.1, "the redeemer spent 50 credits, 250 left");
  ok(await refused(tx(redeemer, { address: staking, abi: ABI, functionName: "spendCredits", args: [user, parseEther("10000"), keccak256(toHex("claim-2"))] })), "never more than the user has");

  console.log("4. unstaking always works, even while paused");
  const b0 = await pub.readContract({ address: GMEC, abi: erc, functionName: "balanceOf", args: [user] });
  await tx(user, { address: staking, abi: ABI, functionName: "unstake", args: [parseEther("100")] });
  ok((await pub.readContract({ address: GMEC, abi: erc, functionName: "balanceOf", args: [user] })) - b0 === parseEther("100"), "all 100 $GMEC back while staking is paused");
  ok(Math.abs(Number(formatEther(await read("creditsOf", [user]))) - 250) < 0.1, "credits kept after unstaking");
  console.log("\nREHEARSAL PASSED");
} finally { anvil.kill(); }
