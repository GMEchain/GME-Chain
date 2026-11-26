// Shows parent chain status plus ETH and gas-token balances of the operator wallets.
import { formatEther } from "viem";
import { NETWORK, S, erc20Abi, parentPublicClient, env, loadDeployment } from "./lib.js";

const chainId = await parentPublicClient.getChainId();
const block = await parentPublicClient.getBlockNumber();
const token = S.nativeToken || loadDeployment().nativeToken;
console.log(`Network ${NETWORK} | parent chain ${chainId} | block ${block}`);
if (token) console.log(`Gas token ${token}`);

for (const role of ["DEPLOYER", "BATCH_POSTER", "VALIDATOR"]) {
  const addr = env(`${role}_ADDRESS`);
  const bal = await parentPublicClient.getBalance({ address: addr });
  let tok = "";
  if (token) {
    const t = await parentPublicClient.readContract({ address: token, abi: erc20Abi, functionName: "balanceOf", args: [addr] });
    tok = ` | ${formatEther(t)} gas token`;
  }
  console.log(`${role.padEnd(13)} ${addr}  ${formatEther(bal)} ETH${tok}`);
}
