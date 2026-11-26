// Writes nodeConfig.<network>.json for the Nitro node (sequencer + batch poster + validator).
// The file contains private keys: it is gitignored and must never be shared.
//
// The output is ready for deploy/vps/docker-compose.coolify.yml: HTTP RPC on 8449, WebSocket on 8548, chain data under
// /home/user/.arbitrum (the image's own data folder), archive mode for the explorer, 250 ms blocks.
//   NODE_PARENT_RPC  Robinhood Chain RPC the node uses (default: the official RPC). It needs eth_getLogs over wide
//                    block ranges, so free plans that cap log ranges (such as dRPC's free tier) do not work here.
import { writeFileSync } from "node:fs";
import path from "node:path";
import { prepareNodeConfig } from "@arbitrum/chain-sdk";
import { NETWORK, ROOT, CHAIN_NAME, parentChain, env, loadDeployment } from "./lib.js";

const dep = loadDeployment();
if (!dep.coreContracts) throw new Error("Run 02-create-rollup.js first.");

const nodeConfig = prepareNodeConfig({
  chainName: CHAIN_NAME,
  chainConfig: dep.chainConfig,
  coreContracts: dep.coreContracts,
  batchPosterPrivateKey: env("BATCH_POSTER_PRIVATE_KEY"),
  validatorPrivateKey: env("VALIDATOR_PRIVATE_KEY"),
  stakeToken: dep.stakeToken,
  parentChainId: parentChain.id,
  parentChainRpcUrl: process.env.NODE_PARENT_RPC || parentChain.rpcUrls.default.http[0],
});

// Production settings for one VPS.
nodeConfig.http = { ...nodeConfig.http, addr: "0.0.0.0", port: 8449, vhosts: ["*"], corsdomain: ["*"], api: ["eth", "net", "web3", "arb"] };
nodeConfig.ws = { addr: "0.0.0.0", port: 8548, api: ["eth", "net", "web3", "arb"] };
nodeConfig.persistent = { "global-config": "/home/user/.arbitrum", chain: "/home/user/.arbitrum/chain" };
nodeConfig.execution = {
  ...nodeConfig.execution,
  sequencer: { ...(nodeConfig.execution?.sequencer || {}), enable: true, "max-block-speed": "250ms", "max-tx-data-size": 85000 },
  caching: { ...(nodeConfig.execution?.caching || {}), archive: true },
};
nodeConfig.node["batch-poster"] = { ...nodeConfig.node["batch-poster"], "max-calldata-batch-size": 90000 };
nodeConfig.metrics = true;
nodeConfig["metrics-server"] = { addr: "0.0.0.0", port: 6070 };

const out = path.join(ROOT, `nodeConfig.${NETWORK}.json`);
writeFileSync(out, JSON.stringify(nodeConfig, null, 2), { mode: 0o600 });
console.log(`Wrote ${out} (contains the batch poster and validator keys: never share it)`);
