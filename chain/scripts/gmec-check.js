// Read-only look at a $GMEC contract on Robinhood Chain before it goes on the website.
//   node scripts/gmec-check.js --mainnet 0x...
// Checks that the address holds code and behaves like an ERC-20 called GMEC. Sends nothing.
import { parseAbi, formatUnits, isAddress, getAddress } from "viem";
import { NETWORK, parentPublicClient as parent } from "./lib.js";

if (NETWORK !== "mainnet") throw new Error("Run with --mainnet.");
const arg = process.argv.find((a) => /^0x[0-9a-fA-F]{40}$/.test(a));
if (!arg || !isAddress(arg)) throw new Error("Give the $GMEC contract address: node scripts/gmec-check.js --mainnet 0x...");
const token = getAddress(arg);
const abi = parseAbi([
  "function name() view returns (string)", "function symbol() view returns (string)", "function decimals() view returns (uint8)",
  "function totalSupply() view returns (uint256)", "function owner() view returns (address)",
]);
const call = (functionName) => parent.readContract({ address: token, abi, functionName }).catch(() => null);

const code = await parent.getBytecode({ address: token });
if (!code || code === "0x") { console.log(`FAIL  ${token} has no contract code on Robinhood Chain (${await parent.getChainId()})`); process.exit(1); }
const [name, symbol, decimals, supply, owner] = await Promise.all(["name", "symbol", "decimals", "totalSupply", "owner"].map(call));
console.log(`Contract   ${token}  (${(code.length - 2) / 2} bytes)`);
console.log(`Name       ${name ?? "(none)"}`);
console.log(`Symbol     ${symbol ?? "(none)"}`);
console.log(`Decimals   ${decimals ?? "(none)"}`);
console.log(`Supply     ${supply != null && decimals != null ? Number(formatUnits(supply, decimals)).toLocaleString("en-US") : "(none)"}`);
console.log(`Owner      ${owner ?? "(no owner() function)"}`);
console.log(`Explorer   https://robinhoodchain.blockscout.com/token/${token}`);
const ok = symbol != null && /GMEC/i.test(symbol) && decimals != null && supply != null;
console.log(ok ? "\nPASS  looks like the $GMEC ERC-20" : "\nFAIL  this does not look like an ERC-20 with the GMEC symbol; check the address");
process.exit(ok ? 0 : 1);
