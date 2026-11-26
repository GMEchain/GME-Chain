// Turns on the exchange's protocol fee and sends it to a FeeBurner that burns it as $GMEC.
//
//   node scripts/11-fee-burner.js --mainnet
//
// 1. deploys FeeBurner on GME CHAIN ($GMEC on GME CHAIN, the exchange router, owner = deployer,
//    operator = the keeper)
// 2. points the exchange factory's feeTo at it (the deployer is the factory's feeToSetter)
// 3. gives the keeper a little GME on GME CHAIN for gas if it has none
// Asks you to type "deploy mainnet". Traders keep paying 0.3% per swap; 0.05% of volume goes to the
// FeeBurner and 0.25% stays with liquidity providers.
//
// Rehearsal: with L3_RPC pointing at a local Anvil fork of GME CHAIN (http://127.0.0.1:…) nothing is
// confirmed or saved; scripts/rehearse-launchpad.js does this for you.
// Env: FUND_KEEPER_GME  GME to send the keeper on GME CHAIN if it has less than 0.0002 (default 0.0005)
import fs from "node:fs";
import path from "node:path";
import { createPublicClient, createWalletClient, defineChain, http, parseAbi, parseEther, formatEther, getAddress } from "viem";
import { privateKeyToAccount } from "viem/accounts";
import { ROOT, NETWORK, S, account, env, loadDeployment, saveDeployment, confirmMainnet, parentPublicClient } from "./lib.js";

if (NETWORK !== "mainnet") throw new Error("Run with --mainnet (use scripts/rehearse-launchpad.js to rehearse on a fork).");
const L3_RPC = process.env.L3_RPC || "https://rpc.gmechain.xyz";
const REHEARSAL = /^http:\/\/(127\.0\.0\.1|localhost)[:/]/.test(L3_RPC);
const GMEC_ON_ROBINHOOD = process.env.GMEC_TOKEN || (() => { throw new Error("Set GMEC_TOKEN to the $GMEC contract on Robinhood Chain (not launched yet)."); })();

const dep = loadDeployment();
if (dep.feeBurner && !REHEARSAL) { console.log("FeeBurner already deployed:", dep.feeBurner.address); process.exit(0); }
if (!dep.dex?.factory || !dep.tokenBridge) throw new Error("The exchange and the token bridge must exist first.");

const art = JSON.parse(fs.readFileSync(path.join(ROOT, "out/FeeBurner.sol/FeeBurner.json"), "utf8"));
const chain = defineChain({ id: S.chainId, name: S.chainName, nativeCurrency: { name: "GME", symbol: "GME", decimals: 18 }, rpcUrls: { default: { http: [L3_RPC] } } });
const pub = createPublicClient({ chain, transport: http(L3_RPC, { timeout: 60_000 }) });
const me = account("DEPLOYER");
const wallet = createWalletClient({ account: me, chain, transport: http(L3_RPC, { timeout: 60_000 }) });
const keeper = getAddress(process.env.KEEPER_ADDRESS || privateKeyToAccount(env("KEEPER_PRIVATE_KEY")).address);

const factoryAbi = parseAbi(["function feeTo() view returns (address)", "function feeToSetter() view returns (address)", "function setFeeTo(address)"]);
const routerAbi = parseAbi(["function factory() view returns (address)"]);
const tokenAbi = parseAbi(["function l1Address() view returns (address)", "function symbol() view returns (string)"]);
const { factory, router } = dep.dex;
// $GMEC on GME CHAIN: fixed by the standard gateway. It exists once someone bridges $GMEC in; until then the
// FeeBurner just holds what it receives, and burns it once $GMEC and a route to it exist.
const gmec = getAddress(await parentPublicClient.readContract({ address: dep.tokenBridge.parentChainContracts.router, abi: parseAbi(["function calculateL2TokenAddress(address) view returns (address)"]), functionName: "calculateL2TokenAddress", args: [GMEC_ON_ROBINHOOD] }));
const gmecLive = ((await pub.getBytecode({ address: gmec })) || "0x") !== "0x";

let failed = false;
const check = (ok, label) => { console.log(`${ok ? "OK  " : "FAIL"} ${label}`); if (!ok) failed = true; };
const eq = (a, b) => String(a).toLowerCase() === String(b).toLowerCase();

// ---------- checks before anything is sent ----------
const [setter, feeTo, rFactory, l1, sym, bal] = await Promise.all([
  pub.readContract({ address: factory, abi: factoryAbi, functionName: "feeToSetter" }),
  pub.readContract({ address: factory, abi: factoryAbi, functionName: "feeTo" }),
  pub.readContract({ address: router, abi: routerAbi, functionName: "factory" }),
  gmecLive ? pub.readContract({ address: gmec, abi: tokenAbi, functionName: "l1Address" }) : GMEC_ON_ROBINHOOD,
  gmecLive ? pub.readContract({ address: gmec, abi: tokenAbi, functionName: "symbol" }) : "GMEC",
  pub.getBalance({ address: me.address }),
]);
console.log(`deployer ${me.address} on ${S.chainName}${REHEARSAL ? " (fork rehearsal)" : ""}: ${formatEther(bal)} GME`);
check(eq(setter, me.address), `deployer is the factory's feeToSetter (${setter})`);
check(eq(feeTo, "0x0000000000000000000000000000000000000000"), `fee switch is off now (feeTo ${feeTo})`);
check(eq(rFactory, factory), "router belongs to this factory");
check(eq(l1, GMEC_ON_ROBINHOOD) && sym === "GMEC", gmecLive ? `$GMEC on GME CHAIN ${gmec} is bridged from ${GMEC_ON_ROBINHOOD}` : `$GMEC on GME CHAIN will be ${gmec} (fixed by the gateway; not bridged in yet, burning starts once it is)`);
check(!eq(keeper, me.address), `operator is the keeper ${keeper}`);
if (failed) throw new Error("Checks failed; nothing was sent.");

if (!REHEARSAL) await confirmMainnet(`deploy FeeBurner on GME CHAIN and turn on the exchange fee switch (0.05% of swap volume -> burned $GMEC; operator ${keeper})`);

async function mined(label, hash) {
  const r = await pub.waitForTransactionReceipt({ hash });
  if (r.status !== "success") throw new Error(`${label} failed: ${hash}`);
  console.log(`  ${label}: ${hash}`);
  return r;
}

// ---------- 1. deploy ----------
const deployTx = await wallet.deployContract({ abi: art.abi, bytecode: art.bytecode.object, args: [gmec, router, me.address, keeper] });
const burner = getAddress((await mined("FeeBurner", deployTx)).contractAddress);
console.log(`  FeeBurner at ${burner}`);
const rd = (fn) => pub.readContract({ address: burner, abi: art.abi, functionName: fn });
check(eq(await rd("gmec"), gmec), "FeeBurner.gmec() is $GMEC");
check(eq(await rd("router"), router), "FeeBurner.router() is the exchange router");
check(eq(await rd("factory"), factory), "FeeBurner.factory() is the exchange factory");
check(eq(await rd("operator"), keeper), "FeeBurner.operator() is the keeper");
check(eq(await rd("owner"), me.address), "FeeBurner.owner() is the deployer");
if (failed) throw new Error(`FeeBurner ${burner} does not match; the fee switch was NOT turned on.`);

// ---------- 2. fee switch ----------
await mined("factory.setFeeTo", await wallet.writeContract({ address: factory, abi: factoryAbi, functionName: "setFeeTo", args: [burner] }));
check(eq(await pub.readContract({ address: factory, abi: factoryAbi, functionName: "feeTo" }), burner), "factory.feeTo() is the FeeBurner");

// ---------- 3. keeper gas on GME CHAIN ----------
const keeperBal = await pub.getBalance({ address: keeper });
const fund = parseEther(process.env.FUND_KEEPER_GME || "0.0005");
if (keeperBal < parseEther("0.0002")) {
  const left = await pub.getBalance({ address: me.address });
  if (left > fund * 2n) await mined(`send ${formatEther(fund)} GME to the keeper`, await wallet.sendTransaction({ to: keeper, value: fund }));
  else console.log(`  NOTE: send the keeper ${keeper} about ${formatEther(fund)} GME on GME CHAIN for gas (deployer has ${formatEther(left)}).`);
}

if (failed) throw new Error("A check after deployment failed; see above.");
const record = { address: burner, operator: keeper, owner: me.address, gmec, factory, router, tx: deployTx, deployedAt: new Date().toISOString() };
if (REHEARSAL) console.log(JSON.stringify({ rehearsalFeeBurner: record }));
else saveDeployment({ feeBurner: record });
console.log("done:", burner);
