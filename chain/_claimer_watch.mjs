// Runs the claimer on testnet (testnet deployer pays) and exits once it has delivered a withdrawal.
await import("./scripts/lib.js");
process.env.CLAIMER_PRIVATE_KEY = process.env.DEPLOYER_PRIVATE_KEY;
process.env.CLAIMER_ADDRESS = process.env.DEPLOYER_ADDRESS;
process.env.INTERVAL_SEC = process.env.INTERVAL_SEC || "120";
await import("./scripts/claimer.js");
const t0 = Date.now();
setInterval(async () => {
  const s = await fetch("http://127.0.0.1:8080/").then((r) => r.json()).catch(() => null);
  if (s && s.claimed > 0) { console.log("WATCH: delivered", JSON.stringify(s.lastClaim)); process.exit(0); }
  if (Date.now() - t0 > 150 * 60_000) { console.log("WATCH: gave up after 150 min", JSON.stringify(s)); process.exit(2); }
}, 30_000);
