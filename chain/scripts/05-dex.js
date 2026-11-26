// Deploys the GME CHAIN exchange: Wrapped GME + the official Uniswap V2 Factory and Router02 bytecode.
// The pair init code hash baked into Router02 (0x96e8ac42…) matches the Factory's pair bytecode,
// so the canonical artifacts are used unmodified.
//
// Usage:
//   node scripts/05-dex.js --mainnet --dry   deploy + swap smoke test on a local Anvil fork of GME CHAIN
//   node scripts/05-dex.js --mainnet         real deployment on GME CHAIN (asks you to type "deploy mainnet")
import fs from "node:fs";
import path from "node:path";
import os from "node:os";
import { spawn } from "node:child_process";
import { createPublicClient, createWalletClient, defineChain, http, parseAbi, parseEther, formatEther, getContractAddress, getAddress } from "viem";
import { ROOT, NETWORK, S, account, loadDeployment, saveDeployment, confirmMainnet } from "./lib.js";
const ANVIL = process.env.ANVIL_BIN || path.join(os.homedir(), ".foundry", "bin", process.platform === "win32" ? "anvil.exe" : "anvil"); // absolute path, not a PATH lookup

if (!["mainnet", "testnet"].includes(NETWORK)) throw new Error("Run with --mainnet or --testnet (add --dry for the fork rehearsal).");
const TESTNET = NETWORK === "testnet";
const DRY = process.argv.includes("--dry");
const L3_RPC = process.env.L3_RPC || (TESTNET ? "https://rpc.testnet.gmechain.xyz" : "https://rpc.gmechain.xyz");
const FORK = "http://127.0.0.1:8546";

const dep = loadDeployment();
if (dep.dex && !DRY) {
  console.log("DEX already deployed:", dep.dex);
  process.exit(0);
}

const art = (p) => JSON.parse(fs.readFileSync(path.join(ROOT, p), "utf8"));
const bc = (a) => (a.bytecode?.object ?? a.bytecode ?? a.evm.bytecode.object).replace(/^0x/, "0x");
const hex = (s) => (s.startsWith("0x") ? s : "0x" + s);
const FACTORY = art("node_modules/@uniswap/v2-core/build/UniswapV2Factory.json");
const ROUTER = art("node_modules/@uniswap/v2-periphery/build/UniswapV2Router02.json");
const WGME = art("out/WrappedGME.sol/WrappedGME.json");

let anvil;
const forkUp = DRY && (await fetch(FORK, { method: "POST", headers: { "content-type": "application/json" }, body: '{"jsonrpc":"2.0","id":1,"method":"eth_chainId","params":[]}' }).then(() => true).catch(() => false));
if (DRY && !forkUp) {
  anvil = spawn(ANVIL, ["--fork-url", L3_RPC, "--port", "8546", "--silent"], { stdio: "ignore" });
  for (let i = 0; i < 60; i++) {
    try { await fetch(FORK, { method: "POST", headers: { "content-type": "application/json" }, body: '{"jsonrpc":"2.0","id":1,"method":"eth_chainId","params":[]}' }); break; } catch { await new Promise((r) => setTimeout(r, 500)); }
  }
}
const rpc = DRY ? FORK : L3_RPC;
const gmeChain = defineChain({
  id: S.chainId, name: S.chainName, network: "gme-chain",
  nativeCurrency: { name: "GME", symbol: "GME", decimals: 18 },
  rpcUrls: { default: { http: [rpc] }, public: { http: [rpc] } },
});
const pub = createPublicClient({ chain: gmeChain, transport: http(rpc, { timeout: 60_000 }) });
const me = account("DEPLOYER");
const wallet = createWalletClient({ account: me, chain: gmeChain, transport: http(rpc, { timeout: 60_000 }) });

if (DRY) { // anvil prices priority fees at 1 gwei (10x GME CHAIN), so give the fork deployer test balance
  await fetch(FORK, { method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify({ jsonrpc: "2.0", id: 1, method: "anvil_setBalance", params: [me.address, "0xde0b6b3a7640000"] }) });
}
const [bal, startNonce, gasPrice] = await Promise.all([pub.getBalance({ address: me.address }), pub.getTransactionCount({ address: me.address }), pub.getGasPrice()]);
console.log(`${DRY ? "[fork] " : ""}deployer ${me.address} on GME CHAIN: ${formatEther(bal)} GME, nonce ${startNonce}, gas ${Number(gasPrice) / 1e9} gwei`);

// The deployer also deployed contracts on Robinhood Chain. Never reuse one of those addresses on GME CHAIN:
// same address, different contract on another chain is an easy way for users to send funds to the wrong place.
const known = new Set((JSON.stringify(dep).match(/0x[0-9a-fA-F]{40}/g) || []).map((a) => a.toLowerCase()));
let nonce = startNonce;
const predict = (n) => [0, 1, 2].map((i) => getContractAddress({ from: me.address, nonce: BigInt(n + i) }));
while (predict(nonce).some((a) => known.has(a.toLowerCase()))) nonce++;
const skip = nonce - startNonce;
const predicted = predict(nonce);
console.log(`will deploy WGME ${predicted[0]}, Factory ${predicted[1]}, Router02 ${predicted[2]}${skip ? ` (skipping ${skip} nonce(s) to avoid reusing a Robinhood Chain address)` : ""}`);

if (!DRY) await confirmMainnet("deploy the GME CHAIN exchange (WGME, UniswapV2Factory, UniswapV2Router02)");
for (let i = 0; i < skip; i++) {
  const h = await wallet.sendTransaction({ to: me.address, value: 0n });
  await pub.waitForTransactionReceipt({ hash: h });
  console.log(`  nonce skip ${i + 1}/${skip}: ${h}`);
}

async function deploy(label, abi, bytecode, args = []) {
  const hash = await wallet.deployContract({ abi, bytecode: hex(bytecode), args });
  const r = await pub.waitForTransactionReceipt({ hash, timeout: 120_000 });
  if (r.status !== "success") throw new Error(`${label} deploy reverted (${hash})`);
  const addr = getAddress(r.contractAddress);
  console.log(`  ${label}: ${addr}  gas ${r.gasUsed}  tx ${hash}`);
  return addr;
}

const want = await deploy("WrappedGME", WGME.abi, bc(WGME));
const factory = await deploy("UniswapV2Factory", FACTORY.abi, bc(FACTORY), [me.address]);
const router = await deploy("UniswapV2Router02", ROUTER.abi, bc(ROUTER), [factory, want]);

// ---------- checks ----------
const fAbi = parseAbi(["function feeToSetter() view returns (address)", "function feeTo() view returns (address)", "function allPairsLength() view returns (uint256)", "function getPair(address,address) view returns (address)"]);
const rAbi = parseAbi(["function factory() view returns (address)", "function WETH() view returns (address)", "function addLiquidityETH(address,uint256,uint256,uint256,address,uint256) payable returns (uint256,uint256,uint256)", "function swapExactETHForTokens(uint256,address[],address,uint256) payable returns (uint256[])", "function getAmountsOut(uint256,address[]) view returns (uint256[])"]);
const [rf, rw, fs_, ft] = await Promise.all([
  pub.readContract({ address: router, abi: rAbi, functionName: "factory" }),
  pub.readContract({ address: router, abi: rAbi, functionName: "WETH" }),
  pub.readContract({ address: factory, abi: fAbi, functionName: "feeToSetter" }),
  pub.readContract({ address: factory, abi: fAbi, functionName: "feeTo" }),
]);
const ok = (c, m) => { if (!c) throw new Error("CHECK FAILED: " + m); console.log("  ✓", m); };
ok(getAddress(predicted[0]) === want && getAddress(predicted[2]) === router, "addresses match the prediction");
ok(rf === factory, "router.factory() is the factory");
ok(rw === want, "router.WETH() is Wrapped GME");
ok(fs_ === me.address, "feeToSetter is the deployer");
ok(ft === "0x0000000000000000000000000000000000000000", "protocol fee is off (all 0.3% goes to LPs)");

if (DRY) {
  // Smoke test: a throwaway token, add liquidity against GME, swap GME -> token.
  const TOKEN = art("node_modules/@uniswap/v2-core/build/ERC20.json");
  const tAbi = [...TOKEN.abi];
  const tok = await deploy("test ERC20", tAbi, bc(TOKEN), [parseEther("1000000")]);
  const eAbi = parseAbi(["function approve(address,uint256) returns (bool)", "function balanceOf(address) view returns (uint256)"]);
  const deadline = BigInt(Math.floor(Date.now() / 1000) + 3600);
  const send = async (req) => { const h = await wallet.writeContract(req); const r = await pub.waitForTransactionReceipt({ hash: h }); if (r.status !== "success") throw new Error("tx reverted " + h); return r; };
  await send({ address: tok, abi: eAbi, functionName: "approve", args: [router, parseEther("1000")] });
  await send({ address: router, abi: rAbi, functionName: "addLiquidityETH", args: [tok, parseEther("1000"), 0n, 0n, me.address, deadline], value: parseEther("0.001") });
  const pair = await pub.readContract({ address: factory, abi: fAbi, functionName: "getPair", args: [want, tok] });
  ok(pair !== "0x0000000000000000000000000000000000000000", `pair created at ${pair}`);
  const amountIn = parseEther("0.0001");
  const [, quoted] = await pub.readContract({ address: router, abi: rAbi, functionName: "getAmountsOut", args: [amountIn, [want, tok]] });
  const before = await pub.readContract({ address: tok, abi: eAbi, functionName: "balanceOf", args: [me.address] });
  await send({ address: router, abi: rAbi, functionName: "swapExactETHForTokens", args: [0n, [want, tok], me.address, deadline], value: amountIn });
  const after = await pub.readContract({ address: tok, abi: eAbi, functionName: "balanceOf", args: [me.address] });
  ok(after - before === quoted, `swap 0.0001 GME -> ${formatEther(quoted)} TEST matches the quote`);
  console.log("\nFork rehearsal passed. Nothing was sent to the real GME CHAIN.");
  console.log(JSON.stringify({ forkDex: { wrappedGme: want, factory, router, testToken: tok, pair } }));
  anvil?.kill();
  process.exit(0);
}

saveDeployment({ dex: { wrappedGme: want, factory, router, initCodeHash: "0x96e8ac4277198ff8b6f785478aa9a39f403cb768dd02cbee326c3e7da348845f", deployedAt: new Date().toISOString() } });
console.log(`\nSaved to ${S.deploymentFile}`);

if (TESTNET) {
  // Testnet only: a dollar stand-in (tUSD, with its own faucet) and a seeded tGME/tUSD pool so testers can swap at once.
  const TUSD = art("out/TestUSD.sol/TestUSD.json");
  const tusd = await deploy("TestUSD", TUSD.abi, bc(TUSD), [me.address]);
  const eAbi = parseAbi(["function mint(address,uint256)", "function approve(address,uint256) returns (bool)"]);
  const send = async (req) => { const h = await wallet.writeContract(req); const r = await pub.waitForTransactionReceipt({ hash: h }); if (r.status !== "success") throw new Error("tx reverted " + h); return r; };
  const gmeIn = parseEther(process.env.SEED_TGME || "1000"), usdIn = parseEther(process.env.SEED_TUSD || "26740");
  await send({ address: tusd, abi: eAbi, functionName: "mint", args: [me.address, usdIn * 10n] });
  await send({ address: tusd, abi: eAbi, functionName: "approve", args: [router, usdIn] });
  const deadline = BigInt(Math.floor(Date.now() / 1000) + 3600);
  await send({ address: router, abi: rAbi, functionName: "addLiquidityETH", args: [tusd, usdIn, 0n, 0n, me.address, deadline], value: gmeIn });
  const pair = await pub.readContract({ address: factory, abi: fAbi, functionName: "getPair", args: [want, tusd] });
  console.log(`  seeded tGME/tUSD pool ${pair}: ${formatEther(gmeIn)} tGME + ${formatEther(usdIn)} tUSD`);
  saveDeployment({ dex: { ...loadDeployment().dex, testUsd: tusd, seedPair: pair } });
}
const left = await pub.getBalance({ address: me.address });
console.log(`deployer left: ${formatEther(left)} GME (spent ${formatEther(bal - left)})`);
