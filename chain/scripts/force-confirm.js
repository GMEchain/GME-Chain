// Ends the one-time transition after the challenge window was shortened (7 days -> about one day).
// In BoLD an assertion waits its PARENT's window, and assertions confirm in order, so the assertions made around
// the change would still wait 7 days. This confirms exactly those, through the owner's forceConfirmAssertion,
// and only once each has already stood for the current window. Nothing else is touched.
//
//   node scripts/force-confirm.js --mainnet --dry    list what is eligible and rehearse it on a fork (default)
//   node scripts/force-confirm.js --mainnet --send   pause the rollup, force-confirm them in order, resume
//
// Rules, checked again before sending:
//   - start from the latest confirmed assertion and walk its children in order
//   - an assertion qualifies only if it is Pending, its parent's window is longer than the current one, and it is
//     at least the current window old (so no claim is confirmed without standing for a full current window)
//   - the confirm data comes from the rollup's own AssertionCreated event; the contract re-checks its hash
//   - resume() always runs after pause(), even when a step fails
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { spawn } from "node:child_process";
import { createPublicClient, createWalletClient, http, encodeFunctionData, getAbiItem } from "viem";
import { ROOT, NETWORK, S, parentChain, parentPublicClient, walletClient, account, loadDeployment, confirmMainnet } from "./lib.js";

if (NETWORK !== "mainnet") throw new Error("Run with --mainnet (add --dry or --send).");
const SEND = process.argv.includes("--send");
// fork rehearsal only: also take transition assertions younger than the window, to prove the mechanics today
const IGNORE_AGE = !SEND && process.argv.includes("--ignore-age");
const dep = loadDeployment(), R = dep.coreContracts.rollup;
const art = (c) => JSON.parse(fs.readFileSync(path.join(ROOT, "node_modules/@arbitrum/nitro-contracts/build/contracts/src/rollup", `${c}.sol`, `${c}.json`), "utf8")).abi;
const userAbi = art("RollupUserLogic"), adminAbi = art("RollupAdminLogic");
const ueAbi = [{ type: "function", name: "executeCall", stateMutability: "payable", inputs: [{ type: "address" }, { type: "bytes" }], outputs: [] }];
const AssertionCreated = getAbiItem({ abi: userAbi, name: "AssertionCreated" });
const STATUS = ["NoAssertion", "Pending", "Confirmed"];

// The rollup's history is read with an archive RPC that allows wide eth_getLogs ranges (free public RPCs cap them
// at 100 blocks): LOGS_RPC, or the parent-chain URL in the local, gitignored nodeConfig.mainnet.json. Never printed.
function logsClient() {
  let url = process.env.LOGS_RPC;
  if (!url) { try { url = JSON.parse(fs.readFileSync(path.join(ROOT, "nodeConfig.mainnet.json"), "utf8"))["parent-chain"].connection.url; } catch {} }
  return url ? createPublicClient({ chain: parentChain, transport: http(url) }) : parentPublicClient;
}

async function plan(pub) {
  const read = (functionName, args = []) => pub.readContract({ address: R, abi: userAbi, functionName, args });
  const logs = logsClient();
  const window = BigInt(await read("confirmPeriodBlocks"));
  const l1 = BigInt((await pub.request({ method: "eth_getBlockByNumber", params: ["latest", false] })).l1BlockNumber);
  const from = BigInt(dep.createdAtBlock);
  // public RPCs cap the block range of eth_getLogs, so read the rollup's history in slices
  const head = await logs.getBlockNumber();
  const events = [];
  for (let a = from, step = 100_000n; a <= head; ) {
    const b = a + step - 1n > head ? head : a + step - 1n;
    try { events.push(...(await logs.getLogs({ address: R, event: AssertionCreated, fromBlock: a, toBlock: b }))); a = b + 1n; }
    catch (e) { if (step <= 1_000n) throw e; step /= 4n; }
  }
  const byParent = new Map(events.map((e) => [e.args.parentAssertionHash.toLowerCase(), e]));
  let cur = (await read("latestConfirmed")).toLowerCase();
  const out = [];
  console.log(`current window ${window} L1 blocks; L1 head ${l1}; latest confirmed ${cur.slice(0, 10)}…; ${events.length} assertions created so far`);
  for (;;) {
    const e = byParent.get(cur);
    if (!e) { console.log("  no further assertion yet"); break; }
    const h = e.args.assertionHash.toLowerCase();
    const node = await read("getAssertion", [h]);
    const parentWindow = BigInt(e.args.assertion.beforeStateData.configData.confirmPeriodBlocks);
    const age = l1 - BigInt(node.createdAtBlock);
    const line = `  ${h.slice(0, 10)}… ${STATUS[node.status]}, parent window ${parentWindow}, age ${age} L1 blocks (~${((Number(age) * 12) / 3600).toFixed(1)} h)`;
    if (node.status !== 1) { console.log(`${line}: not pending, stop`); break; }
    if (parentWindow <= window) { console.log(`${line}: already on the current window, the validator confirms it normally`); break; }
    if (age < window && !IGNORE_AGE) { const left = Number(window - age) * 12; console.log(`${line}: eligible in ~${(left / 3600).toFixed(1)} h`); break; }
    if (age < window) console.log(`${line}: younger than the window, taken for the FORK REHEARSAL only (--ignore-age)`); else
    console.log(`${line}: ELIGIBLE`);
    out.push({ hash: h, parent: cur, afterState: e.args.assertion.afterState, inboxAcc: e.args.afterInboxBatchAcc });
    cur = h;
  }
  return out;
}

async function execute(pub, wallet, items) {
  const call = async (label, data) => {
    const hsh = await wallet.writeContract({ address: owner, abi: ueAbi, functionName: "executeCall", args: [R, data] });
    const r = await pub.waitForTransactionReceipt({ hash: hsh });
    if (r.status !== "success") throw new Error(`${label} reverted: ${hsh}`);
    console.log(`  ${label}: ${hsh}`);
  };
  await call("pause", encodeFunctionData({ abi: adminAbi, functionName: "pause" }));
  let failure = null;
  try {
    for (const it of items) await call(`forceConfirm ${it.hash.slice(0, 10)}…`, encodeFunctionData({ abi: adminAbi, functionName: "forceConfirmAssertion", args: [it.hash, it.parent, it.afterState, it.inboxAcc] }));
  } catch (e) { failure = e; }
  await call("resume", encodeFunctionData({ abi: adminAbi, functionName: "resume" }));
  if (failure) throw failure;
  const latest = (await pub.readContract({ address: R, abi: userAbi, functionName: "latestConfirmed" })).toLowerCase();
  const paused = await pub.readContract({ address: R, abi: userAbi, functionName: "paused" });
  const ok = latest === items[items.length - 1].hash && !paused;
  console.log(`  latest confirmed now ${latest.slice(0, 10)}…, rollup ${paused ? "PAUSED" : "running"}: ${ok ? "OK" : "CHECK"}`);
  if (!ok) throw new Error("state after the force-confirm is not as expected");
}

const owner = await parentPublicClient.readContract({ address: R, abi: userAbi, functionName: "owner" });
const items = await plan(parentPublicClient);
if (!items.length) { console.log("\nNothing to do now."); process.exit(0); }

if (SEND) {
  await confirmMainnet(`Pause the rollup, force-confirm ${items.length} transition assertion(s) in order, resume`);
  await execute(parentPublicClient, walletClient("DEPLOYER"), items);
  console.log(`\nDONE. Withdrawals covered by these assertions can be claimed now; later ones follow the one-day window.`);
} else {
  const ANVIL = process.env.ANVIL_BIN || path.join(os.homedir(), ".foundry", "bin", process.platform === "win32" ? "anvil.exe" : "anvil");
  const anvil = spawn(ANVIL, ["--fork-url", S.rpc, "--port", "8557", "--chain-id", "4663", "--silent", "--no-rate-limit"], { stdio: "ignore" });
  const RPC = "http://127.0.0.1:8557";
  const rpc = (method, params) => fetch(RPC, { method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify({ jsonrpc: "2.0", id: 1, method, params }) }).then((r) => r.json()).then((j) => { if (j.error) throw new Error(j.error.message); return j.result; });
  try {
    for (let i = 0; i < 120; i++) { try { await rpc("eth_chainId", []); break; } catch { await new Promise((r) => setTimeout(r, 500)); } }
    const me = process.env.DEPLOYER_ADDRESS;
    await rpc("anvil_impersonateAccount", [me]);
    const pub = createPublicClient({ chain: parentChain, transport: http(RPC) });
    // fork only: a large balance so a revert shows its real reason instead of anvil's "exceeds the balance"
    await rpc("anvil_setBalance", [me, "0x56BC75E2D63100000"]);
    const w = createWalletClient({ chain: parentChain, transport: http(RPC), account: me });
    // failure path first: a wrong inbox accumulator must make the confirm revert, and the rollup must still be resumed
    console.log("\nFailure path on a fork (bad data on purpose):");
    const snap = await rpc("evm_snapshot", []);
    const badItem = { ...items[0], inboxAcc: "0x" + "11".repeat(32) };
    // (a) the contract's own reason, read with eth_call while paused
    const badData = encodeFunctionData({ abi: adminAbi, functionName: "forceConfirmAssertion", args: [badItem.hash, badItem.parent, badItem.afterState, badItem.inboxAcc] });
    await pub.waitForTransactionReceipt({ hash: await w.writeContract({ address: owner, abi: ueAbi, functionName: "executeCall", args: [R, encodeFunctionData({ abi: adminAbi, functionName: "pause" })] }) });
    const reason = await pub.call({ account: me, to: owner, data: encodeFunctionData({ abi: ueAbi, functionName: "executeCall", args: [R, badData] }) }).then(() => "no revert", (e) => [e.shortMessage, e.details, e.message].filter(Boolean).join(" ").replace(/\s+/g, " "));
    console.log(`  eth_call with bad data: ${/CONFIRM_DATA/.test(reason) ? "reverts with CONFIRM_DATA" : reason.slice(0, 200)}`);
    await rpc("evm_revert", [snap]);
    // (b) the script's own path: a failing confirm still ends with resume()
    const snap2 = await rpc("evm_snapshot", []);
    const threw = await execute(pub, w, [badItem]).then(() => false, () => true);
    const pausedAfter = await pub.readContract({ address: R, abi: userAbi, functionName: "paused" });
    console.log(`  script stopped on the bad confirm: ${threw}; rollup left ${pausedAfter ? "PAUSED (bad)" : "running (good)"}`);
    if (!/CONFIRM_DATA/.test(reason) || !threw || pausedAfter) throw new Error("the failure path did not behave");
    await rpc("evm_revert", [snap2]);
    console.log("\nRehearsal on a fork of Robinhood Chain:");
    await execute(pub, w, items);
    const outbox = dep.coreContracts.outbox;
    for (const it of items) {
      const sendRoot = it.afterState.globalState.bytes32Vals[1];
      const blockHash = await pub.readContract({ address: outbox, abi: [{ type: "function", name: "roots", stateMutability: "view", inputs: [{ type: "bytes32" }], outputs: [{ type: "bytes32" }] }], functionName: "roots", args: [sendRoot] });
      console.log(`  outbox knows send root ${sendRoot.slice(0, 10)}…: ${BigInt(blockHash) ? "yes" : "NO"}`);
      if (!BigInt(blockHash)) throw new Error("outbox did not receive the send root");
    }
    console.log(`\nREHEARSAL PASSED. Send with: node scripts/force-confirm.js --mainnet --send`);
  } finally { anvil.kill(); }
}
