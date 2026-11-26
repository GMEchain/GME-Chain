// Changes the rollup's challenge window (confirmPeriodBlocks), counted in Ethereum blocks of ~12 s.
//   node scripts/rollup-window.js --mainnet --dry    rehearse on a fork of Robinhood Chain (default)
//   node scripts/rollup-window.js --mainnet --send   send it through the rollup's UpgradeExecutor
// WINDOW_BLOCKS (default 7200, about one day).
//
// In BoLD an assertion's window comes from its parent's config, and assertions confirm in order. The first
// assertion after the change still waits the old window, so the new one is fully in effect one old window later.
import os from "node:os";
import path from "node:path";
import { spawn } from "node:child_process";
import { createPublicClient, createWalletClient, http, parseAbi, encodeFunctionData } from "viem";
import { NETWORK, S, parentChain, parentPublicClient, walletClient, account, loadDeployment, saveDeployment, confirmMainnet } from "./lib.js";

if (NETWORK !== "mainnet") throw new Error("Run with --mainnet (add --dry or --send).");
const SEND = process.argv.includes("--send");
const NEW = BigInt(process.env.WINDOW_BLOCKS || 7200);
const dep = loadDeployment(), R = dep.coreContracts.rollup;
const rAbi = parseAbi(["function owner() view returns (address)", "function confirmPeriodBlocks() view returns (uint64)", "function setConfirmPeriodBlocks(uint64)"]);
const ueAbi = parseAbi(["function executeCall(address,bytes) payable", "function hasRole(bytes32,address) view returns (bool)"]);
const EXECUTOR_ROLE = "0xd8aa0f3194971a2a116679f7c2090f6939c8d4e01a2a8d7e41d55e5351469e63"; // keccak256("EXECUTOR_ROLE")
const days = (b) => ((Number(b) * 12) / 86400).toFixed(2);

const owner = await parentPublicClient.readContract({ address: R, abi: rAbi, functionName: "owner" });
const cur = await parentPublicClient.readContract({ address: R, abi: rAbi, functionName: "confirmPeriodBlocks" });
console.log(`rollup ${R}, owner ${owner}`);
console.log(`window now ${cur} blocks (~${days(cur)} days), next ${NEW} blocks (~${days(NEW)} days)`);
if (NEW < 600n) throw new Error("Refusing a window under ~2 hours on mainnet. Nothing was sent.");
const data = encodeFunctionData({ abi: rAbi, functionName: "setConfirmPeriodBlocks", args: [NEW] });

if (SEND) {
  const me = account("DEPLOYER");
  const ok = await parentPublicClient.readContract({ address: owner, abi: ueAbi, functionName: "hasRole", args: [EXECUTOR_ROLE, me.address] });
  if (!ok) throw new Error("The deployer is not an executor of the rollup's UpgradeExecutor. Nothing was sent.");
  await confirmMainnet(`Set the challenge window to ${NEW} blocks (~${days(NEW)} days)`);
  const h = await walletClient("DEPLOYER").writeContract({ address: owner, abi: ueAbi, functionName: "executeCall", args: [R, data] });
  const r = await parentPublicClient.waitForTransactionReceipt({ hash: h });
  const now = await parentPublicClient.readContract({ address: R, abi: rAbi, functionName: "confirmPeriodBlocks" });
  console.log(`executeCall ${r.status} in ${h}; window is now ${now} blocks`);
  if (r.status === "success" && now === NEW) saveDeployment({ confirmPeriodBlocks: String(NEW), confirmPeriodChangedTx: h });
  process.exit(r.status === "success" && now === NEW ? 0 : 1);
}

// ---------- rehearsal on a fork
const ANVIL = process.env.ANVIL_BIN || path.join(os.homedir(), ".foundry", "bin", process.platform === "win32" ? "anvil.exe" : "anvil");
const anvil = spawn(ANVIL, ["--fork-url", S.rpc, "--port", "8554", "--chain-id", "4663", "--silent", "--no-rate-limit"], { stdio: "ignore" });
const RPC = "http://127.0.0.1:8554";
const rpc = (method, params) => fetch(RPC, { method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify({ jsonrpc: "2.0", id: 1, method, params }) }).then((r) => r.json()).then((j) => { if (j.error) throw new Error(j.error.message); return j.result; });
try {
  for (let i = 0; i < 120; i++) { try { await rpc("eth_chainId", []); break; } catch { await new Promise((r) => setTimeout(r, 500)); } }
  const pub = createPublicClient({ chain: parentChain, transport: http(RPC) });
  const me = process.env.DEPLOYER_ADDRESS;
  await rpc("anvil_impersonateAccount", [me]);
  const w = createWalletClient({ chain: parentChain, transport: http(RPC), account: me });
  const ok = (c, m) => { console.log(`  ${c ? "PASS" : "FAIL"}  ${m}`); if (!c) throw new Error("rehearsal failed"); };
  ok(await pub.readContract({ address: owner, abi: ueAbi, functionName: "hasRole", args: [EXECUTOR_ROLE, me] }), "deployer is an executor of the UpgradeExecutor");
  const h = await w.writeContract({ address: owner, abi: ueAbi, functionName: "executeCall", args: [R, data] });
  ok((await pub.waitForTransactionReceipt({ hash: h })).status === "success", "executeCall(setConfirmPeriodBlocks) succeeds");
  ok((await pub.readContract({ address: R, abi: rAbi, functionName: "confirmPeriodBlocks" })) === NEW, `window reads back ${NEW}`);
  const direct = await createWalletClient({ chain: parentChain, transport: http(RPC), account: me }).writeContract({ address: R, abi: rAbi, functionName: "setConfirmPeriodBlocks", args: [1n] }).then(() => "sent", (e) => "refused");
  ok(direct === "refused", "calling the rollup directly (not through the executor) is refused");
  console.log(`\nREHEARSAL PASSED. Send with --send. The ~${days(NEW)}-day window is fully in effect about ${days(cur)} days after sending.`);
} finally { anvil.kill(); }
