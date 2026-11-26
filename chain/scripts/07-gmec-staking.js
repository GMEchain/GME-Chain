// Deploys GmecStaking (stake $GMEC on Robinhood Chain, earn gas credits for GME CHAIN).
//   node scripts/07-gmec-staking.js --testnet                     rehearsal: tGME stands in for $GMEC, then stake/unstake check
//   GMEC_TOKEN=0x... node scripts/07-gmec-staking.js --mainnet    real deployment on Robinhood Chain (asks you to type "deploy mainnet")
// The owner is the DEPLOYER key. The owner can only choose the redeemer and pause NEW stakes;
// it can never move staked tokens or block unstaking.
import { readFileSync } from "node:fs";
import path from "node:path";
import { parseAbi, formatEther, parseEther, isAddress, getAddress } from "viem";
import { NETWORK, ROOT, parentPublicClient as pub, walletClient, account, loadDeployment, saveDeployment, confirmMainnet } from "./lib.js";

if (!["mainnet", "testnet"].includes(NETWORK)) throw new Error("Run with --testnet (rehearsal) or --mainnet.");
// PARENT_RPC pointing at a local fork (http://127.0.0.1:…) makes a mainnet run a rehearsal: no confirmation, nothing saved
const REHEARSAL = /^http:\/\/(127\.0\.0\.1|localhost)[:/]/.test(process.env.PARENT_RPC || "");
const dep = loadDeployment();
const me = account("DEPLOYER");
const w = walletClient("DEPLOYER");
const art = JSON.parse(readFileSync(path.join(ROOT, "out", "GmecStaking.sol", "GmecStaking.json"), "utf8"));
const erc = parseAbi([
  "function name() view returns (string)", "function symbol() view returns (string)", "function decimals() view returns (uint8)",
  "function balanceOf(address) view returns (uint256)", "function approve(address,uint256) returns (bool)",
]);

let tokenAddr;
if (NETWORK === "mainnet") {
  if (!isAddress(process.env.GMEC_TOKEN || "")) throw new Error("Set GMEC_TOKEN to the $GMEC contract address on Robinhood Chain.");
  tokenAddr = getAddress(process.env.GMEC_TOKEN);
} else {
  tokenAddr = getAddress(process.env.GMEC_TOKEN || dep.nativeToken); // tGME stands in for $GMEC on testnet
}
const code = await pub.getBytecode({ address: tokenAddr });
if (!code || code === "0x") throw new Error(`No contract at ${tokenAddr} on ${NETWORK}.`);
const [name, symbol, decimals] = await Promise.all(["name", "symbol", "decimals"].map((f) => pub.readContract({ address: tokenAddr, abi: erc, functionName: f })));
console.log(`network ${NETWORK} | staking token ${tokenAddr} = "${name}" (${symbol}), ${decimals} decimals`);
if (Number(decimals) !== 18) throw new Error("Expected an 18-decimal token; credits are reported with 18 decimals.");
console.log(`deployer/owner ${me.address}: ${formatEther(await pub.getBalance({ address: me.address }))} ETH for gas`);

if (!REHEARSAL && dep.gmecStaking?.address && dep.gmecStaking.token?.toLowerCase() === tokenAddr.toLowerCase()) {
  throw new Error(`Already deployed for this token at ${dep.gmecStaking.address}. Remove gmecStaking from deployment.${NETWORK}.json to deploy again.`);
}

if (!REHEARSAL) await confirmMainnet(`deploy GmecStaking for ${symbol} at ${tokenAddr}, owned by ${me.address}`);

const hash = await w.deployContract({ abi: art.abi, bytecode: art.bytecode.object, args: [tokenAddr, me.address] });
const r = await pub.waitForTransactionReceipt({ hash });
if (r.status !== "success") throw new Error(`deploy reverted: ${hash}`);
const staking = r.contractAddress;
console.log(`GmecStaking deployed at ${staking} (tx ${hash})`);
const record = { address: staking, token: tokenAddr, owner: me.address, tx: hash, deployedAt: new Date().toISOString() };
if (REHEARSAL) console.log(JSON.stringify({ rehearsalStaking: record }));
else saveDeployment({ gmecStaking: record });

// read back what the chain holds
const read = (f, args = []) => pub.readContract({ address: staking, abi: art.abi, functionName: f, args });
const [onToken, onOwner, open] = await Promise.all([read("token"), read("owner"), read("stakingOpen")]);
const ok = (cond, msg) => { if (!cond) throw new Error(`check failed: ${msg}`); console.log(`  ✓ ${msg}`); };
ok(onToken.toLowerCase() === tokenAddr.toLowerCase(), "token is the one requested");
ok(onOwner.toLowerCase() === me.address.toLowerCase(), "owner is the deployer");
ok(open === true, "staking is open");

if (NETWORK === "testnet" || REHEARSAL) {
  // live rehearsal: stake 1 token, watch credits grow, unstake it all (on a fork: time moves one day)
  const amt = parseEther("1");
  const bal0 = await pub.readContract({ address: tokenAddr, abi: erc, functionName: "balanceOf", args: [me.address] });
  ok(bal0 >= amt, "deployer holds at least 1 token to stake");
  await pub.waitForTransactionReceipt({ hash: await w.writeContract({ address: tokenAddr, abi: erc, functionName: "approve", args: [staking, amt] }) });
  await pub.waitForTransactionReceipt({ hash: await w.writeContract({ address: staking, abi: art.abi, functionName: "stake", args: [amt] }) });
  ok((await read("stakedOf", [me.address])) === amt, "stake recorded");
  if (REHEARSAL) {
    const call = (method, params) => fetch(process.env.PARENT_RPC, { method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify({ jsonrpc: "2.0", id: 1, method, params }) });
    await call("evm_increaseTime", [86400]); await call("evm_mine", []);
  } else await new Promise((res) => setTimeout(res, 20_000));
  const earned = await read("earnedOf", [me.address]);
  ok(earned > 0n, `credits grow while staked (${formatEther(earned)} token-days after ${REHEARSAL ? "one day" : "~20 s"})`);
  await pub.waitForTransactionReceipt({ hash: await w.writeContract({ address: staking, abi: art.abi, functionName: "unstake", args: [amt] }) });
  ok((await read("stakedOf", [me.address])) === 0n, "unstake returned everything");
  const bal1 = await pub.readContract({ address: tokenAddr, abi: erc, functionName: "balanceOf", args: [me.address] });
  ok(bal1 === bal0, "token balance back to where it started");
  ok((await read("creditsOf", [me.address])) >= earned, "credits kept after unstaking");
}
console.log("done");
