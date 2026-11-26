// Writes one small env file per VPS service into deploy/vps/secrets/, each with only what that service needs:
//   keeper.env   KEEPER key (updates the fee pricer) + parent RPC
//   monitor.env  public operator addresses only (no keys) + optional alert settings
// The deployer key never goes to the server. Run it where .env.mainnet is:  node scripts/vps-env.js --mainnet
import { mkdirSync, writeFileSync } from "node:fs";
import path from "node:path";
import { ROOT, env } from "./lib.js";

const dir = path.resolve(ROOT, "..", "deploy", "vps", "secrets");
mkdirSync(dir, { recursive: true });
const rpc = process.env.SERVICE_PARENT_RPC || "https://rpc.mainnet.chain.robinhood.com";
const write = (name, lines) => {
  writeFileSync(path.join(dir, name), lines.join("\n") + "\n", { mode: 0o600 });
  console.log(`wrote deploy/vps/secrets/${name}`);
};

write("keeper.env", [
  "# GME CHAIN keeper: the only key here is the keeper's. Never share this file.",
  "NETWORK=mainnet",
  `PARENT_RPC=${rpc}`,
  `KEEPER_ADDRESS=${env("KEEPER_ADDRESS")}`,
  `KEEPER_PRIVATE_KEY=${env("KEEPER_PRIVATE_KEY")}`,
]);
write("monitor.env", [
  "# GME CHAIN monitor: public addresses only, no keys.",
  "NETWORK=mainnet",
  `PARENT_RPC=${rpc}`,
  `DEPLOYER_ADDRESS=${env("DEPLOYER_ADDRESS")}`,
  `BATCH_POSTER_ADDRESS=${env("BATCH_POSTER_ADDRESS")}`,
  `VALIDATOR_ADDRESS=${env("VALIDATOR_ADDRESS")}`,
  `KEEPER_ADDRESS=${env("KEEPER_ADDRESS")}`,
  "# optional alerts",
  "TELEGRAM_BOT_TOKEN=",
  "TELEGRAM_CHAT_ID=",
  "DISCORD_WEBHOOK_URL=",
]);
