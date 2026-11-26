// Publishes the source of our Robinhood Chain contracts on Sourcify (https://sourcify.dev), so anyone can
// read the verified code next to the deployed address. GME CHAIN (12821) is not a Sourcify chain; its
// contracts are checked with scripts/verify-bytecode.js instead.
//
//   cd chain && forge build && node scripts/verify-sourcify.js
//
// It sends the compiler metadata from the Foundry build plus every source file the metadata lists, the same
// files `forge verify-contract --verifier sourcify` sends. No keys, no transactions.
import fs from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
const API = "https://sourcify.dev/server";
const CHAIN = 4663;
const dep = JSON.parse(fs.readFileSync(path.join(ROOT, "deployment.mainnet.json"), "utf8"));
const CONTRACTS = [
  { name: "GmeFeeTokenPricer", file: "GmeFeeTokenPricer.sol", address: dep.feeTokenPricer },
  { name: "GmeGasRouter", file: "GmeGasRouter.sol", address: dep.gasRouter },
  { name: "GmecStaking", file: "GmecStaking.sol", address: dep.gmecStaking?.address },
].filter((c) => c.address);
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

async function status(address) {
  const r = await fetch(`${API}/v2/contract/${CHAIN}/${address}`);
  return r.ok ? r.json() : null;
}

for (const c of CONTRACTS) {
  const before = await status(c.address);
  if (before?.match) { console.log(`${c.name} ${c.address}: already verified (${before.match})`); continue; }
  const art = JSON.parse(fs.readFileSync(path.join(ROOT, "out", c.file, `${c.name}.json`), "utf8"));
  const metadata = art.rawMetadata;
  const meta = JSON.parse(metadata);
  const sources = {};
  for (const p of Object.keys(meta.sources)) {
    const local = path.join(ROOT, p);
    if (!fs.existsSync(local)) throw new Error(`missing source ${p}`);
    sources[p] = fs.readFileSync(local, "utf8");
  }
  const r = await fetch(`${API}/v2/verify/metadata/${CHAIN}/${c.address}`, {
    method: "POST", headers: { "content-type": "application/json" },
    body: JSON.stringify({ sources, metadata: meta }),
  });
  const j = await r.json().catch(() => ({}));
  if (!r.ok || !j.verificationId) { console.log(`${c.name}: submit failed (${r.status}) ${JSON.stringify(j).slice(0, 300)}`); process.exitCode = 1; continue; }
  let job;
  for (let i = 0; i < 40; i++) {
    await sleep(3000);
    job = await (await fetch(`${API}/v2/verify/${j.verificationId}`)).json();
    if (job.isJobCompleted) break;
  }
  if (job?.error) { console.log(`${c.name}: ${job.error.customCode || ""} ${job.error.message || JSON.stringify(job.error).slice(0, 300)}`); process.exitCode = 1; continue; }
  const after = await status(c.address);
  console.log(`${c.name} ${c.address}: ${after?.match ? `verified (${after.match})` : "not verified yet"} · https://repo.sourcify.dev/${CHAIN}/${c.address}`);
}
