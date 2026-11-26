// Opens gas-credit claims on mainnet:
//   1. GmecStaking.setRedeemer(REDEEMER_ADDRESS)          (owner = DEPLOYER, on Robinhood Chain)
//   2. a little ETH to the redeemer on Robinhood Chain    (to record claims with spendCredits)
//   3. GME to the redeemer on GME CHAIN                    (the gas it hands out)
//   REDEEMER_ADDRESS=0x… node scripts/09-credits-setup.js --mainnet     asks you to type "deploy mainnet"
// The gas pot is paid by users, not by the project: step 3 only moves launchpad fee income (the treasury half of
// the 1% fee, which the deployer receives as Wrapped GME). It unwraps up to FUND_GME of that WGME and sends it;
// the deployer's own GME is never used. With no fee income yet nothing is sent and claims stay closed (the
// claim service only opens when the pot holds at least one claim). Run it again later to top the pot up.
// Env: FUND_ETH (default 0.0005, records claims on Robinhood Chain), FUND_GME (default 0.05, at most the fee income)
import { createPublicClient, createWalletClient, defineChain, http, parseAbi, parseEther, formatEther, isAddress, getAddress } from "viem";
import { NETWORK, S, parentPublicClient as l2, walletClient, account, loadDeployment, confirmMainnet } from "./lib.js";

if (!["mainnet", "testnet"].includes(NETWORK)) throw new Error("Run with --mainnet.");
const dep = loadDeployment();
const STAKING = process.env.STAKING_ADDRESS || dep.gmecStaking?.address; // STAKING_ADDRESS: fork rehearsal only
if (!STAKING) throw new Error("No staking contract in the deployment file.");
const L3_RPC = process.env.L3_RPC || (NETWORK === "testnet" ? "https://rpc.testnet.gmechain.xyz" : "https://rpc.gmechain.xyz");
const l3chain = defineChain({ id: S.chainId, name: S.chainName, nativeCurrency: { name: "GME", symbol: "GME", decimals: 18 }, rpcUrls: { default: { http: [L3_RPC] } } });
const l3 = createPublicClient({ chain: l3chain, transport: http(L3_RPC) });
const deployer = account("DEPLOYER");
// the redeemer key is generated on the server (deploy/vps/update-server.sh) and never leaves it: pass its address
const redeemerArg = process.env.REDEEMER_ADDRESS;
if (!redeemerArg || !isAddress(redeemerArg)) throw new Error("Set REDEEMER_ADDRESS to the address update-server.sh printed for the gas credits service.");
const redeemer = getAddress(redeemerArg);
const dl2 = walletClient("DEPLOYER");
const dl3 = createWalletClient({ account: deployer, chain: l3chain, transport: http(L3_RPC) });
const abi = parseAbi(["function setRedeemer(address)", "function redeemer() view returns (address)", "function owner() view returns (address)"]);
const FUND_ETH = parseEther(process.env.FUND_ETH || "0.0005");
const FUND_GME = parseEther(process.env.FUND_GME || "0.05");
const WGME = dep.dex?.wrappedGme;
if (!WGME) throw new Error("No Wrapped GME in the deployment file.");
const wAbi = parseAbi(["function balanceOf(address) view returns (uint256)", "function withdraw(uint256)"]);

const [owner, current, eth, gme, income] = await Promise.all([
  l2.readContract({ address: STAKING, abi, functionName: "owner" }),
  l2.readContract({ address: STAKING, abi, functionName: "redeemer" }),
  l2.getBalance({ address: redeemer }),
  l3.getBalance({ address: redeemer }),
  l3.readContract({ address: WGME, abi: wAbi, functionName: "balanceOf", args: [deployer.address] }), // launchpad fee income
]);
const want = gme < FUND_GME ? FUND_GME - gme : 0n;
const fromFees = want < income ? want : income;
if (owner.toLowerCase() !== deployer.address.toLowerCase()) throw new Error(`The staking owner is ${owner}, not the deployer.`);
console.log(`staking ${STAKING}\nredeemer now ${current}\nnew redeemer ${redeemer}: ${formatEther(eth)} ETH on Robinhood Chain, ${formatEther(gme)} GME on GME CHAIN`);
console.log(`launchpad fee income (WGME held by the treasury): ${formatEther(income)} GME`);
console.log(`will: setRedeemer, send ${formatEther(FUND_ETH)} ETH (Robinhood Chain), and ${formatEther(fromFees)} GME of fee income to the gas pot (GME CHAIN)`);
if (want > 0n && fromFees < want) console.log(`  NOTE: the pot gets ${formatEther(fromFees)} of the ${formatEther(want)} GME asked; the rest waits for more fee income.`);
// both RPCs on this machine = a fork rehearsal (scripts/rehearse-credits.js): nothing real is sent, no confirmation
const REHEARSAL = [process.env.PARENT_RPC, L3_RPC].every((u) => /^http:\/\/(127\.0\.0\.1|localhost)[:/]/.test(u || ""));
if (!REHEARSAL) await confirmMainnet(`open gas-credit claims: redeemer ${redeemer}, fund ${formatEther(FUND_ETH)} ETH + ${formatEther(fromFees)} GME from fee income`);

const ok = async (client, h, label) => { const r = await client.waitForTransactionReceipt({ hash: h }); if (r.status !== "success") throw new Error(`${label} reverted ${h}`); console.log(`  ${label}: ${h}`); };
if (current.toLowerCase() !== redeemer.toLowerCase()) await ok(l2, await dl2.writeContract({ address: STAKING, abi, functionName: "setRedeemer", args: [redeemer] }), "setRedeemer");
if (eth < FUND_ETH) await ok(l2, await dl2.sendTransaction({ to: redeemer, value: FUND_ETH - eth }), "fund ETH");
if (fromFees > 0n) {
  await ok(l3, await dl3.writeContract({ address: WGME, abi: wAbi, functionName: "withdraw", args: [fromFees] }), "unwrap fee income");
  await ok(l3, await dl3.sendTransaction({ to: redeemer, value: fromFees }), "fund the gas pot from fee income");
}
console.log("done. Redeemer:", redeemer);
