// Full rehearsal of the GME launchpad on a local Anvil fork of GME CHAIN mainnet, using the real deploy scripts:
//   1. scripts/11-fee-burner.js  (FeeBurner + the exchange fee switch)
//   2. scripts/08-launchpad.js   (GmeLaunchpad, paid in GME, burn share to the FeeBurner)
//   3. a user creates a token with GME, buys, sells back for GME, then buys it out to graduation
//   4. checks: TOKEN/WGME pool with burned liquidity, fee halves at the FeeBurner and the treasury, GME/USDG swaps still work
//   5. the keeper's burn job (fee-burner-job.js, as the keeper) turns what the FeeBurner holds into $GMEC at 0xdEaD,
//      through a GME / $GMEC pool made on the fork ($GMEC is not bridged yet: a stand-in token sits at its fixed address)
// Nothing touches the real chain.   node scripts/rehearse-launchpad.js --mainnet
import os from "node:os";
import fs from "node:fs";
import path from "node:path";
import { spawn, execFileSync } from "node:child_process";
import { createPublicClient, createWalletClient, defineChain, http, parseAbi, parseEther, formatEther, formatUnits, getAddress } from "viem";
import { ROOT, NETWORK, loadDeployment } from "./lib.js";
import { createBurnerJob } from "./fee-burner-job.js";
if (NETWORK !== "mainnet") throw new Error("Run with --mainnet: this rehearses on a fork of GME CHAIN mainnet.");

const GMEC = process.env.GMEC_TOKEN || "0xa8c53b1dAcFbd07895dC8D2c638F1bFDe10C0122";
const ANVIL = process.env.ANVIL_BIN || path.join(os.homedir(), ".foundry", "bin", process.platform === "win32" ? "anvil.exe" : "anvil");
const PORT = 8558, RPC = `http://127.0.0.1:${PORT}`;
const dep = loadDeployment();
const chain = defineChain({ id: 12821, name: "GME CHAIN", nativeCurrency: { name: "GME", symbol: "GME", decimals: 18 }, rpcUrls: { default: { http: [RPC] } } });
const pub = createPublicClient({ chain, transport: http(RPC) });
const rpc = (method, params) => fetch(RPC, { method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify({ jsonrpc: "2.0", id: 1, method, params }) }).then((r) => r.json()).then((j) => { if (j.error) throw new Error(j.error.message); return j.result; });
const ok = (c, m) => { console.log(`  ${c ? "PASS" : "FAIL"}  ${m}`); if (!c) throw new Error(`rehearsal failed: ${m}`); };
const run = (script, extra) => execFileSync(process.execPath, [path.join(ROOT, "scripts", script), "--mainnet"], { cwd: ROOT, env: { ...process.env, L3_RPC: RPC, GMEC_TOKEN: GMEC, ...extra }, encoding: "utf8" });

const anvil = spawn(ANVIL, ["--fork-url", "https://rpc.gmechain.xyz", "--port", String(PORT), "--chain-id", "12821", "--silent", "--no-rate-limit"], { stdio: "ignore" });
try {
  for (let i = 0; i < 120; i++) { try { await rpc("eth_chainId", []); break; } catch { await new Promise((r) => setTimeout(r, 500)); } }
  // the deployer needs a little GME for gas on the fork (the real one has it too)
  await rpc("anvil_setBalance", [process.env.DEPLOYER_ADDRESS, "0x8AC7230489E80000"]);

  console.log("1. FeeBurner + fee switch (scripts/11-fee-burner.js on the fork)");
  const out1 = run("11-fee-burner.js");
  const burnerRec = JSON.parse(out1.split("\n").find((l) => l.includes("rehearsalFeeBurner"))).rehearsalFeeBurner;
  const burner = burnerRec.address;
  ok(/OK\s+deployer is the factory's feeToSetter/.test(out1) && /OK\s+factory.feeTo\(\) is the FeeBurner/.test(out1), `FeeBurner ${burner}, fee switch on`);

  console.log("2. GmeLaunchpad (scripts/08-launchpad.js on the fork)");
  const out2 = run("08-launchpad.js", { BURN_SINK: burner });
  ok(!/FAIL/.test(out2), "every post-deploy check of the launchpad");
  const pad = JSON.parse(out2.split("\n").find((l) => l.includes("rehearsalLaunchpad"))).rehearsalLaunchpad.address;
  const PAD = JSON.parse(fs.readFileSync(path.join(ROOT, "out/GmeLaunchpad.sol/GmeLaunchpad.json"), "utf8")).abi;

  console.log("3. a user on the fork");
  const user = "0x7E57000000000000000000000000000000000002";
  await rpc("anvil_impersonateAccount", [user]);
  await rpc("anvil_setBalance", [user, "0x15AF1D78B58C400000"]); // 400 GME
  const w = createWalletClient({ chain, transport: http(RPC), account: user });
  const send = async (label, req) => { const h = await w.writeContract(req); const r = await pub.waitForTransactionReceipt({ hash: h }); ok(r.status === "success", label); return r; };
  const dl = () => BigInt(Math.floor(Date.now() / 1000) + 3600);
  const erc = parseAbi(["function balanceOf(address) view returns (uint256)", "function approve(address,uint256) returns (bool)"]);
  const WGME = dep.dex.wrappedGme, me = process.env.DEPLOYER_ADDRESS;
  const sink0 = await pub.readContract({ address: WGME, abi: erc, functionName: "balanceOf", args: [burner] });
  const tre0 = await pub.readContract({ address: WGME, abi: erc, functionName: "balanceOf", args: [me] });

  await send("createWithGme with a first buy of 1 GME", { address: pad, abi: PAD, functionName: "createWithGme", args: ["Rehearsal", "REH", '{"description":"fork rehearsal"}', 1n, dl()], value: parseEther("1") });
  const token = (await pub.readContract({ address: pad, abi: PAD, functionName: "tokensPage", args: [0n, 1n] }))[0];
  const p0 = await pub.readContract({ address: pad, abi: PAD, functionName: "priceOf", args: [token] });
  await send("buyWithGme 10 GME", { address: pad, abi: PAD, functionName: "buyWithGme", args: [token, 1n, dl()], value: parseEther("10") });
  ok((await pub.readContract({ address: pad, abi: PAD, functionName: "priceOf", args: [token] })) > p0, "price rose");
  const held = await pub.readContract({ address: token, abi: erc, functionName: "balanceOf", args: [user] });
  await send("approve", { address: token, abi: erc, functionName: "approve", args: [pad, held] });
  const g0 = await pub.getBalance({ address: user });
  const q = await pub.readContract({ address: pad, abi: PAD, functionName: "quoteSell", args: [token, held / 2n] });
  await send("sellForGme half", { address: pad, abi: PAD, functionName: "sellForGme", args: [token, held / 2n, q, dl()] });
  ok((await pub.getBalance({ address: user })) > g0, `received ~${Number(formatEther(q)).toFixed(4)} GME back`);

  const [, need] = await pub.readContract({ address: pad, abi: PAD, functionName: "quoteBuy", args: [token, parseEther("300")] });
  const g1 = await pub.getBalance({ address: user });
  const r = await send(`buy out the curve (needs ${Number(formatEther(need)).toFixed(4)} GME, sending 300)`, { address: pad, abi: PAD, functionName: "buyWithGme", args: [token, 1n, dl()], value: parseEther("300") });
  const paid = g1 - (await pub.getBalance({ address: user })) - r.gasUsed * r.effectiveGasPrice;
  ok(paid === need, `paid exactly what was needed, the rest refunded (${formatEther(paid)} GME)`);

  console.log("4. checks");
  const l = await pub.readContract({ address: pad, abi: PAD, functionName: "launches", args: [token] });
  const pair = l[7];
  ok(l[8] === true, "graduated");
  const pairAbi = parseAbi(["function getReserves() view returns (uint112,uint112,uint32)", "function token0() view returns (address)", "function balanceOf(address) view returns (uint256)", "function totalSupply() view returns (uint256)"]);
  const [r0, r1] = await pub.readContract({ address: pair, abi: pairAbi, functionName: "getReserves" });
  const t0 = await pub.readContract({ address: pair, abi: pairAbi, functionName: "token0" });
  const [rT, rQ] = getAddress(t0) === getAddress(token) ? [r0, r1] : [r1, r0];
  ok(rT === parseEther("200000000"), `pool holds 200,000,000 ${"REH"}`);
  ok(Math.abs(Number(formatEther(rQ)) - 100) < 0.01, `pool holds ~100 GME (${Number(formatEther(rQ)).toFixed(4)})`);
  const dead = await pub.readContract({ address: pair, abi: pairAbi, functionName: "balanceOf", args: ["0x000000000000000000000000000000000000dEaD"] });
  const ts = await pub.readContract({ address: pair, abi: pairAbi, functionName: "totalSupply" });
  ok(dead === ts - 1000n, "pool liquidity burned (locked forever)");
  const sinkGot = (await pub.readContract({ address: WGME, abi: erc, functionName: "balanceOf", args: [burner] })) - sink0;
  const treGot = (await pub.readContract({ address: WGME, abi: erc, functionName: "balanceOf", args: [me] })) - tre0;
  ok(sinkGot > 0n && sinkGot === treGot || sinkGot - treGot <= 1n, `fee halves: FeeBurner ${Number(formatEther(sinkGot)).toFixed(5)} GME, treasury ${Number(formatEther(treGot)).toFixed(5)} GME`);
  ok((await pub.getBalance({ address: pad })) === 0n && (await pub.readContract({ address: WGME, abi: erc, functionName: "balanceOf", args: [pad] })) === 0n, "nothing left in the launchpad");

  // the existing exchange keeps working with the fee switch on
  const routerAbi = parseAbi(["function getAmountsOut(uint256,address[]) view returns (uint256[])", "function swapExactETHForTokens(uint256,address[],address,uint256) payable returns (uint256[])"]);
  const [, outU] = await pub.readContract({ address: dep.dex.router, abi: routerAbi, functionName: "getAmountsOut", args: [parseEther("0.01"), [WGME, dep.dex.usdg]] });
  await send(`GME/USDG swap still works (0.01 GME -> ${formatUnits(outU, 6)} USDG)`, { address: dep.dex.router, abi: routerAbi, functionName: "swapExactETHForTokens", args: [(outU * 99n) / 100n, [WGME, dep.dex.usdg], user, dl()], value: parseEther("0.01") });

  console.log("5. the keeper's burn job");
  const gmec = burnerRec.gmec, keeperAddr = burnerRec.operator, DEAD = "0x000000000000000000000000000000000000dEaD";
  const TG = JSON.parse(fs.readFileSync(path.join(ROOT, "out/TestGMEC.sol/TestGMEC.json"), "utf8"));
  if (((await pub.getBytecode({ address: gmec })) || "0x") === "0x") await rpc("anvil_setCode", [gmec, TG.deployedBytecode.object]); // stand-in for bridged $GMEC
  await send("get stand-in $GMEC", { address: gmec, abi: TG.abi, functionName: "drip" });
  const liqAbi = parseAbi(["function addLiquidityETH(address,uint256,uint256,uint256,address,uint256) payable returns (uint256,uint256,uint256)"]);
  await send("approve", { address: gmec, abi: erc, functionName: "approve", args: [dep.dex.router, parseEther("100000")] });
  await send("GME / $GMEC pool: 50 GME + 100,000 $GMEC", { address: dep.dex.router, abi: liqAbi, functionName: "addLiquidityETH", args: [gmec, parseEther("100000"), 0n, 0n, user, dl()], value: parseEther("50") });
  await rpc("anvil_impersonateAccount", [keeperAddr]);
  await rpc("anvil_setBalance", [keeperAddr, "0xDE0B6B3A7640000"]);
  const kw = createWalletClient({ chain, transport: http(RPC), account: keeperAddr });
  const job = createBurnerJob({ pub, wallet: kw, addr: { burner, factory: dep.dex.factory, router: dep.dex.router, gmec, want: WGME }, log: (m, e) => console.log(`    ${m}${e ? " " + JSON.stringify(e) : ""}`) });
  const burnAbi = parseAbi(["function totalBurned() view returns (uint256)"]);
  const dead0 = await pub.readContract({ address: gmec, abi: erc, functionName: "balanceOf", args: [DEAD] });
  const wg0 = await pub.readContract({ address: WGME, abi: erc, functionName: "balanceOf", args: [burner] });
  const burned = await job.run();
  const dead1 = await pub.readContract({ address: gmec, abi: erc, functionName: "balanceOf", args: [DEAD] });
  ok(burned > 0n && dead1 - dead0 === burned, `${Number(formatEther(burned)).toFixed(2)} $GMEC sent to 0xdEaD`);
  ok((await pub.readContract({ address: burner, abi: burnAbi, functionName: "totalBurned" })) === burned, "totalBurned() matches");
  const wg1 = await pub.readContract({ address: WGME, abi: erc, functionName: "balanceOf", args: [burner] });
  ok(wg1 === 0n, `the FeeBurner's ${Number(formatEther(wg0)).toFixed(4)} GME of fees all went into the burn`);
  ok((await pub.readContract({ address: gmec, abi: erc, functionName: "balanceOf", args: [keeperAddr] })) === 0n && job.status.lastError === null, "the keeper received nothing, no errors");

  console.log("\nREHEARSAL PASSED");
} finally { anvil.kill(); }
