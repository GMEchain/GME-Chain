// Turns the exchange's protocol fee into burned $GMEC (FeeBurner on GME CHAIN). Used by the keeper, and by
// scripts/rehearse-launchpad.js on a fork.
//
// One run:
//   1. for each exchange pool where the FeeBurner holds pool shares: unwind them (the tokens stay in the FeeBurner)
//   2. for each token the FeeBurner holds other than $GMEC: pick the route to $GMEC that gives the most,
//      cap the size so the price impact stays under maxImpact, and call swapAndBurn with a minimum
//      of (quote - slippage). The $GMEC goes straight to 0xdEaD.
//   3. send any $GMEC the FeeBurner holds to 0xdEaD (burnGmec)
// Small amounts that are not worth the gas wait for a later run. Every call is simulated before it is sent.
import { parseAbi, formatEther } from "viem";

export const burnerAbi = parseAbi([
  "function operator() view returns (address)",
  "function gmec() view returns (address)",
  "function totalBurned() view returns (uint256)",
  "function unwind(address pair) returns (uint256, uint256)",
  "function swapAndBurn(address[] path, uint256 amountIn, uint256 minGmecOut, uint256 deadline) returns (uint256)",
  "function burnGmec() returns (uint256)",
]);
const factoryAbi = parseAbi(["function allPairsLength() view returns (uint256)", "function allPairs(uint256) view returns (address)", "function feeTo() view returns (address)"]);
const pairAbi = parseAbi(["function token0() view returns (address)", "function token1() view returns (address)", "function getReserves() view returns (uint112, uint112, uint32)", "function totalSupply() view returns (uint256)", "function balanceOf(address) view returns (uint256)"]);
const routerAbi = parseAbi(["function getAmountsOut(uint256 amountIn, address[] path) view returns (uint256[])"]);
const ercAbi = parseAbi(["function balanceOf(address) view returns (uint256)", "function symbol() view returns (string)"]);

const same = (a, b) => a.toLowerCase() === b.toLowerCase();

/**
 * @param {object} o
 * @param {import("viem").PublicClient} o.pub   GME CHAIN public client
 * @param {import("viem").WalletClient} o.wallet GME CHAIN wallet client of the operator (keeper)
 * @param {{burner:string,factory:string,router:string,gmec:string,want:string}} o.addr
 * @param {(msg:string, extra?:object)=>void} o.log
 * @param {{maxImpact?:number, slippage?:number, minGasMultiple?:number, minOperatorGas?:bigint}} [o.opts]
 */
export function createBurnerJob({ pub, wallet, addr, log, opts = {} }) {
  const maxImpact = opts.maxImpact ?? 0.03; // 3% price impact per swap at most
  const slippage = opts.slippage ?? 0.01; // minimum out = quote - 1%
  const minGasMultiple = opts.minGasMultiple ?? 3; // a step must be worth 3x its gas
  const minOperatorGas = opts.minOperatorGas ?? 20_000_000_000_000n; // 0.00002 GME
  const status = { runs: 0, lastRun: null, lastError: null, lastBurned: "0", totalBurned: null, operatorGme: null, held: {} };
  const symbols = new Map();

  const read = (address, abi, functionName, args = []) => pub.readContract({ address, abi, functionName, args });
  const symbol = async (t) => {
    if (!symbols.has(t)) symbols.set(t, await read(t, ercAbi, "symbol").catch(() => t.slice(0, 8)));
    return symbols.get(t);
  };
  const quote = async (amount, path) => {
    try {
      const out = await read(addr.router, routerAbi, "getAmountsOut", [amount, path]);
      return out[out.length - 1];
    } catch {
      return 0n; // no pool on this route
    }
  };
  // value of `amount` of `token` in GME (WGME), 0 if there is no route
  const valueInGme = async (token, amount) => {
    if (amount === 0n) return 0n;
    if (same(token, addr.want)) return amount;
    const direct = await quote(amount, [token, addr.want]);
    const viaGmec = same(token, addr.gmec) ? 0n : await quote(amount, [token, addr.gmec, addr.want]);
    return direct > viaGmec ? direct : viaGmec;
  };

  async function send(label, functionName, args) {
    const { request } = await pub.simulateContract({ account: wallet.account, address: addr.burner, abi: burnerAbi, functionName, args });
    const hash = await wallet.writeContract(request);
    const r = await pub.waitForTransactionReceipt({ hash });
    if (r.status !== "success") throw new Error(`${label} reverted: ${hash}`);
    log(`burner: ${label}`, { tx: hash });
    return r;
  }
  // gas cost of a call in GME, from a simulation-backed estimate
  async function gasCost(functionName, args) {
    const [gas, price] = await Promise.all([
      pub.estimateContractGas({ account: wallet.account, address: addr.burner, abi: burnerAbi, functionName, args }),
      pub.getGasPrice(),
    ]);
    return gas * price;
  }

  // largest amount (amount, amount/2, amount/4 …) whose price impact on `path` stays under maxImpact
  async function sizeForImpact(amount, path) {
    for (let a = amount, i = 0; i < 12 && a > 0n; i++, a /= 2n) {
      const probe = a / 1000n;
      if (probe === 0n) return { amount: a, out: await quote(a, path) };
      const [out, small] = await Promise.all([quote(a, path), quote(probe, path)]);
      if (out === 0n || small === 0n) return { amount: 0n, out: 0n };
      // the small trade already pays the 0.3% pool fee on each hop, so this compares impact only
      const ideal = small * (a / probe);
      if (ideal === 0n) return { amount: 0n, out: 0n };
      const impact = 1 - Number(out) / Number(ideal);
      if (impact <= maxImpact) return { amount: a, out };
    }
    return { amount: 0n, out: 0n };
  }

  async function run() {
    status.runs++;
    status.lastRun = new Date().toISOString();
    let burnedThisRun = 0n;
    try {
      const op = await read(addr.burner, burnerAbi, "operator");
      if (!same(op, wallet.account.address)) throw new Error(`FeeBurner operator is ${op}, not ${wallet.account.address}`);
      const feeTo = await read(addr.factory, factoryAbi, "feeTo");
      if (!same(feeTo, addr.burner)) log("burner: WARNING factory feeTo is not the FeeBurner", { feeTo });
      const gasBal = await pub.getBalance({ address: wallet.account.address });
      status.operatorGme = formatEther(gasBal);
      if (gasBal < minOperatorGas) throw new Error(`operator has ${formatEther(gasBal)} GME on GME CHAIN; top it up`);

      // 1. unwind pool shares
      const n = await read(addr.factory, factoryAbi, "allPairsLength");
      const tokens = new Set();
      for (let i = 0n; i < n; i++) {
        const pair = await read(addr.factory, factoryAbi, "allPairs", [i]);
        const [t0, t1, lp] = await Promise.all([read(pair, pairAbi, "token0"), read(pair, pairAbi, "token1"), read(pair, pairAbi, "balanceOf", [addr.burner])]);
        tokens.add(t0);
        tokens.add(t1);
        if (lp === 0n) continue;
        const [[r0, r1], supply] = await Promise.all([read(pair, pairAbi, "getReserves"), read(pair, pairAbi, "totalSupply")]);
        const a0 = (lp * r0) / supply, a1 = (lp * r1) / supply;
        if (a0 === 0n || a1 === 0n) continue; // too small to unwind yet
        const value = (await valueInGme(t0, a0)) + (await valueInGme(t1, a1));
        const cost = await gasCost("unwind", [pair]).catch(() => null);
        if (cost === null || value < cost * BigInt(minGasMultiple)) { log("burner: unwind waits (not worth the gas yet)", { pair, valueGme: formatEther(value), gasGme: cost === null ? "n/a" : formatEther(cost) }); continue; }
        await send(`unwind ${await symbol(t0)}/${await symbol(t1)}`, "unwind", [pair]);
      }

      // 2. swap every other token to burned $GMEC
      const deadline = () => BigInt(Math.floor(Date.now() / 1000) + 600);
      for (const t of tokens) {
        if (same(t, addr.gmec)) continue;
        const held = await read(t, ercAbi, "balanceOf", [addr.burner]);
        status.held[await symbol(t)] = formatEther(held);
        if (held === 0n) continue;
        const routes = [[t, addr.gmec]];
        if (!same(t, addr.want)) routes.push([t, addr.want, addr.gmec]);
        let best = null;
        for (const path of routes) {
          const sized = await sizeForImpact(held, path);
          // best rate (out per token in); a route that can take more at the same rate wins ties
          if (sized.amount === 0n) continue;
          const better = !best || sized.out * best.amount > best.out * sized.amount || (sized.out * best.amount === best.out * sized.amount && sized.amount > best.amount);
          if (better) best = { path, ...sized };
        }
        if (!best) { log("burner: no route to $GMEC within the price-impact limit", { token: t }); continue; }
        const minOut = (best.out * BigInt(Math.round((1 - slippage) * 10_000))) / 10_000n;
        const args = [best.path, best.amount, minOut, deadline()];
        const value = await valueInGme(addr.gmec, best.out);
        const cost = await gasCost("swapAndBurn", args).catch(() => null);
        if (cost === null || value < cost * BigInt(minGasMultiple)) { log("burner: swap waits (not worth the gas yet)", { token: t, valueGme: formatEther(value), gasGme: cost === null ? "n/a" : formatEther(cost) }); continue; }
        const before = await read(addr.burner, burnerAbi, "totalBurned");
        await send(`swap ${formatEther(best.amount)} ${await symbol(t)} -> $GMEC burned`, "swapAndBurn", args);
        burnedThisRun += (await read(addr.burner, burnerAbi, "totalBurned")) - before;
        status.held[await symbol(t)] = formatEther(await read(t, ercAbi, "balanceOf", [addr.burner]));
      }

      // 3. burn $GMEC held
      const gmecHeld = await read(addr.gmec, ercAbi, "balanceOf", [addr.burner]);
      status.held.GMEC = formatEther(gmecHeld);
      if (gmecHeld > 0n) {
        const value = await valueInGme(addr.gmec, gmecHeld);
        const cost = await gasCost("burnGmec", []).catch(() => null);
        if (cost !== null && value >= cost * BigInt(minGasMultiple)) {
          await send(`burn ${formatEther(gmecHeld)} $GMEC`, "burnGmec", []);
          burnedThisRun += gmecHeld;
          status.held.GMEC = "0";
        }
      }
      status.lastError = null;
    } catch (e) {
      status.lastError = { at: new Date().toISOString(), message: e.shortMessage || e.message };
      log("burner: error", status.lastError);
    } finally {
      status.lastBurned = formatEther(burnedThisRun);
      try { status.totalBurned = formatEther(await read(addr.burner, burnerAbi, "totalBurned")); } catch { /* keep last */ }
      log("burner: run done", { burned: status.lastBurned, totalBurned: status.totalBurned });
    }
    return burnedThisRun;
  }

  return { run, status };
}
