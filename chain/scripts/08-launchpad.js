// Deploys the GME CHAIN launchpad (GmeLaunchpad), where every trade is paid in GME, the chain's gas token.
//
//   node scripts/08-launchpad.js --mainnet    deploys the launchpad on GME CHAIN (asks you to type "deploy mainnet")
//   node scripts/08-launchpad.js --testnet    the same on GME CHAIN Testnet, then a create / buy / sell smoke test
//
// The quote token is the exchange's Wrapped GME; users pay and are paid in native GME (the contract wraps it).
// Half of each 1% fee goes to the FeeBurner (scripts/11-fee-burner.js, deploy it first), which can only turn
// what it holds into burned $GMEC; the other half goes to the treasury (the deployer).
// Env: LAUNCH_TARGET      GME a curve raises before it graduates (whole GME, default 100)
//      LAUNCH_CREATE_FEE  GME to create a token (default 0)
//      L3_RPC             a local fork (http://127.0.0.1:…) makes this a rehearsal: no confirmation, nothing saved
import fs from "node:fs";
import path from "node:path";
import { createPublicClient, createWalletClient, defineChain, http, parseEther, formatEther, getAddress } from "viem";
import { ROOT, NETWORK, S, account, loadDeployment, saveDeployment, confirmMainnet } from "./lib.js";

if (!["mainnet", "testnet"].includes(NETWORK)) throw new Error("Run with --testnet or --mainnet.");
const TESTNET = NETWORK === "testnet";
const L3_RPC = process.env.L3_RPC || (TESTNET ? "https://rpc.testnet.gmechain.xyz" : "https://rpc.gmechain.xyz");
const REHEARSAL = /^http:\/\/(127\.0\.0\.1|localhost)[:/]/.test(L3_RPC);

const dep = loadDeployment();
if (dep.launchpad && !REHEARSAL) { console.log("Launchpad already deployed:", dep.launchpad); process.exit(0); }
if (!dep.dex?.factory || !dep.dex?.wrappedGme) throw new Error("Deploy the exchange first (scripts/05-dex.js).");
const burnSink = process.env.BURN_SINK || dep.feeBurner?.address || (TESTNET ? null : undefined);
if (burnSink === undefined) throw new Error("Deploy the FeeBurner first (scripts/11-fee-burner.js): half of each fee goes to it.");

const PAD = JSON.parse(fs.readFileSync(path.join(ROOT, "out/GmeLaunchpad.sol/GmeLaunchpad.json"), "utf8"));
const chain = defineChain({ id: S.chainId, name: S.chainName, nativeCurrency: { name: "GME", symbol: "GME", decimals: 18 }, rpcUrls: { default: { http: [L3_RPC] } } });
const pub = createPublicClient({ chain, transport: http(L3_RPC, { timeout: 60_000 }) });
const me = account("DEPLOYER");
const wallet = createWalletClient({ account: me, chain, transport: http(L3_RPC, { timeout: 60_000 }) });

async function mined(label, hash) {
  const r = await pub.waitForTransactionReceipt({ hash });
  if (r.status !== "success") throw new Error(`${label} failed: ${hash}`);
  console.log(`  ${label}: ${hash}`);
  return r;
}

const target = parseEther(process.env.LAUNCH_TARGET || "100");
const createFee = parseEther(process.env.LAUNCH_CREATE_FEE || "0");
const quote = getAddress(dep.dex.wrappedGme);
const sink = getAddress(burnSink || me.address); // testnet without a FeeBurner: the burn share goes to the deployer
console.log(`deployer ${me.address} on ${S.chainName}${REHEARSAL ? " (fork rehearsal)" : ""}: ${formatEther(await pub.getBalance({ address: me.address }))} GME`);
console.log(`quote WGME ${quote}, factory ${dep.dex.factory}`);
console.log(`graduation target ${formatEther(target)} GME, fee 1% (half to ${sink === me.address ? "the deployer" : `the FeeBurner ${sink}`}, half to the treasury ${me.address}), create fee ${formatEther(createFee)} GME`);
if (!REHEARSAL) await confirmMainnet(`deploy GmeLaunchpad on GME CHAIN (paid in GME, target ${formatEther(target)} GME)`);

const r = await mined("GmeLaunchpad", await wallet.deployContract({ abi: PAD.abi, bytecode: PAD.bytecode.object, args: [quote, dep.dex.factory, me.address, sink, target, me.address] }));
const pad = getAddress(r.contractAddress);
const rd = (functionName) => pub.readContract({ address: pad, abi: PAD.abi, functionName });
const checks = [
  [(await rd("quote")).toLowerCase() === quote.toLowerCase(), "quote is WGME"],
  [(await rd("factory")).toLowerCase() === dep.dex.factory.toLowerCase(), "factory is the exchange factory"],
  [(await rd("burnSink")).toLowerCase() === sink.toLowerCase(), "burn sink"],
  [(await rd("treasury")).toLowerCase() === me.address.toLowerCase(), "treasury is the deployer"],
  [(await rd("owner")).toLowerCase() === me.address.toLowerCase(), "owner is the deployer"],
  [(await rd("graduationTarget")) === target, "graduation target"],
  [Number(await rd("feeBps")) === 100 && Number(await rd("burnShareBps")) === 5000, "fee 1%, half to the burn sink"],
];
for (const [ok, label] of checks) console.log(`${ok ? "OK  " : "FAIL"} ${label}`);
if (checks.some(([ok]) => !ok)) throw new Error(`GmeLaunchpad ${pad} does not match; do not use it.`);
if (createFee > 0n) await mined("setParams (create fee)", await wallet.writeContract({ address: pad, abi: PAD.abi, functionName: "setParams", args: [100, 5000, createFee, target, me.address] }));
const record = { address: pad, quote, factory: dep.dex.factory, burnSink: sink, target: target.toString(), tx: r.transactionHash, deployedAt: new Date().toISOString() };
if (REHEARSAL) console.log(JSON.stringify({ rehearsalLaunchpad: record }));
else saveDeployment({ launchpad: record });

if (TESTNET && !REHEARSAL) {
  // smoke test in native GME: create with a first buy, buy, sell half back
  const deadline = () => BigInt(Math.floor(Date.now() / 1000) + 600);
  await mined("create GMTEST + buy with 1 GME", await wallet.writeContract({ address: pad, abi: PAD.abi, functionName: "createWithGme", args: ["GME CHAIN Test", "GMTEST", '{"description":"Smoke test token for the GME CHAIN launchpad on testnet."}', 1n, deadline()], value: parseEther("1") }));
  const token = (await pub.readContract({ address: pad, abi: PAD.abi, functionName: "tokensPage", args: [0n, 1n] }))[0];
  await mined("buy with 2 GME", await wallet.writeContract({ address: pad, abi: PAD.abi, functionName: "buyWithGme", args: [token, 1n, deadline()], value: parseEther("2") }));
  const erc = [{ type: "function", name: "approve", stateMutability: "nonpayable", inputs: [{ type: "address" }, { type: "uint256" }], outputs: [{ type: "bool" }] }, { type: "function", name: "balanceOf", stateMutability: "view", inputs: [{ type: "address" }], outputs: [{ type: "uint256" }] }];
  const held = await pub.readContract({ address: token, abi: erc, functionName: "balanceOf", args: [me.address] });
  await mined("approve", await wallet.writeContract({ address: token, abi: erc, functionName: "approve", args: [pad, held] }));
  await mined("sell half for GME", await wallet.writeContract({ address: pad, abi: PAD.abi, functionName: "sellForGme", args: [token, held / 2n, 1n, deadline()] }));
}
console.log("done:", pad);
