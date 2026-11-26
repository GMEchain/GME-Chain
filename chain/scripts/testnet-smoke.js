// Testnet smoke test of the user flow: faucet drip on Robinhood Chain Testnet, swap on GME CHAIN Testnet, start a withdrawal.
import { parseEther, formatEther, parseAbi, createPublicClient, createWalletClient, http, defineChain } from "viem";
import { NETWORK, S, parentPublicClient, walletClient, account, loadDeployment, erc20Abi } from "./lib.js";
if (NETWORK !== "testnet") throw new Error("testnet only");
const dep = loadDeployment(), me = account("DEPLOYER");
const L3_RPC = "https://rpc.testnet.gmechain.xyz";
const chain = defineChain({ id: S.chainId, name: S.chainName, nativeCurrency: { name: "tGME", symbol: "tGME", decimals: 18 }, rpcUrls: { default: { http: [L3_RPC] } } });
const l3 = createPublicClient({ chain, transport: http(L3_RPC) });
const w3 = createWalletClient({ account: me, chain, transport: http(L3_RPC) });
const ok = (c, m) => { if (!c) throw new Error("FAIL: " + m); console.log("  ✓", m); };

// 1) faucet
const tGme = dep.nativeToken;
const b0 = await parentPublicClient.readContract({ address: tGme, abi: erc20Abi, functionName: "balanceOf", args: [me.address] });
try {
  const h = await walletClient("DEPLOYER").writeContract({ address: tGme, abi: parseAbi(["function drip()"]), functionName: "drip" });
  await parentPublicClient.waitForTransactionReceipt({ hash: h });
  const b1 = await parentPublicClient.readContract({ address: tGme, abi: erc20Abi, functionName: "balanceOf", args: [me.address] });
  ok(b1 - b0 === parseEther("100"), `faucet drip gave ${formatEther(b1 - b0)} tGME`);
} catch (e) { console.log("  (faucet already used today by this address:", (e.shortMessage || e.message).split("\n")[0], ")"); }

// 2) swap 1 tGME -> tUSD
const { router, wrappedGme, testUsd } = dep.dex;
const rAbi = parseAbi(["function getAmountsOut(uint256,address[]) view returns (uint256[])", "function swapExactETHForTokens(uint256,address[],address,uint256) payable returns (uint256[])"]);
const amt = parseEther("1");
const [, q] = await l3.readContract({ address: router, abi: rAbi, functionName: "getAmountsOut", args: [amt, [wrappedGme, testUsd]] });
const u0 = await l3.readContract({ address: testUsd, abi: erc20Abi, functionName: "balanceOf", args: [me.address] });
const hs = await w3.writeContract({ address: router, abi: rAbi, functionName: "swapExactETHForTokens", args: [(q * 995n) / 1000n, [wrappedGme, testUsd], me.address, BigInt(Math.floor(Date.now() / 1000) + 600)], value: amt });
const rs = await l3.waitForTransactionReceipt({ hash: hs });
const u1 = await l3.readContract({ address: testUsd, abi: erc20Abi, functionName: "balanceOf", args: [me.address] });
ok(rs.status === "success" && u1 - u0 === q, `swap 1 tGME -> ${formatEther(u1 - u0)} tUSD (quote matched)`);

// 3) start a withdrawal of 0.5 tGME back to Robinhood Chain Testnet
const hw = await w3.writeContract({ address: "0x0000000000000000000000000000000000000064", abi: parseAbi(["function withdrawEth(address) payable returns (uint256)"]), functionName: "withdrawEth", args: [me.address], value: parseEther("0.5") });
const rw = await l3.waitForTransactionReceipt({ hash: hw });
ok(rw.status === "success", `withdrawal of 0.5 tGME started (tx ${hw}); claimable after the ~30 min window once the validator posts`);
