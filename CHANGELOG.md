# Changelog

What has been built on GME CHAIN, newest first. Dates are UTC. Every on-chain value below can be checked against the contracts listed in [docs/contracts.md](docs/contracts.md). What comes next is on the [roadmap](docs/roadmap.md).

## 2026-11-27 · Mainnet launch

### Mainnet is open
- **gmechain.xyz runs on GME CHAIN mainnet:** bridge ETH in as GME gas, swap on the exchange, explore blocks and withdraw back. The testnet stays open for trying everything for free.


### Withdrawals in about a day
- The mainnet challenge window is now **7,200 Ethereum blocks (about one day)**, down from 50,400 (about 7 days). Set on the rollup through its UpgradeExecutor, tx [`0xddaaac3b…a748`](https://robinhoodchain.blockscout.com/tx/0xddaaac3be7b85b8ee48531930985281bc8d6a6037751dcc5dc78b9b8c63da748). Check it with `confirmPeriodBlocks()` on the rollup.
- Assertions confirm in order and each keeps its parent's window, so the few assertions made around the change still carry the 7-day window. They are moved onto the new window with the owner's `forceConfirmAssertion`, each only after standing for at least a day ([chain/scripts/force-confirm.js](chain/scripts/force-confirm.js)), so withdrawals are about a day from the first days on.
- The site, the docs, the bridge countdown and the roadmap all show the new time.

### $GMEC
- **$GMEC is published:** [`0xa8c53b1dAcFbd07895dC8D2c638F1bFDe10C0122`](https://robinhoodchain.blockscout.com/token/0xa8c53b1dAcFbd07895dC8D2c638F1bFDe10C0122) on Robinhood Chain (name GME Chain, symbol GMEC, 18 decimals, 1,000,000,000 supply; not a proxy, so its code cannot be swapped). It is the only official contract; the site shows it in the footer, the FAQ and the docs. Gas stays GME.

### Tested on mainnet with real funds
- The day-one user flow ran on mainnet from the deployer with small amounts ([chain/scripts/mainnet-smoke.js](chain/scripts/mainnet-smoke.js)): 0.001 ETH bridged through GmeGasRouter and arrived as GME gas, 0.01 GME swapped for USDG on the exchange, a GME transfer, and a 0.01 GME withdrawal started back to Robinhood Chain (the first mainnet withdrawal, tx `0x7807e5e3d22464d112c2182206af1ec1ce6264383d781f58c8f8058401eba4d4` on GME CHAIN). That withdrawal is delivered after the challenge window.

### Exchange
- **First pool: GME/USDG.** A starter pool of 2 GME and 53.47 USDG, opened at the market price of Robinhood Chain's deepest GME pool (pair [`0x0cc2…B85f`](docs/contracts.md)). USDG is Global Dollar bridged from Robinhood Chain through the canonical token bridge. The deployer holds the LP tokens; anyone can add liquidity.

### Bridge
- **Withdrawal delivery.** After the window, a delivery wallet claims confirmed withdrawals on Robinhood Chain for their owners and pays the claim gas, so nobody has to come back to press Claim. The funds always go to the withdrawal's own destination. Only plain GME withdrawals (from 0.01 GME) and token withdrawals through GME CHAIN's own gateways are delivered, with a gas cap per claim and a daily cap. Anyone can still claim their own withdrawal at any time. Code: [chain/scripts/claimer.js](chain/scripts/claimer.js).
- **One card.** Bring in and take out share one card: the arrow between the two sides flips the direction, a history button opens your withdrawals, and each side says when the money arrives.

## 2026-11-26

### Mainnet on Robinhood Chain
- **GME CHAIN mainnet deployed** (chain 12821) as a Layer 3 on Robinhood Chain (4663), with the GME stock token [`0x1b0E…153E`](https://robinhoodchain.blockscout.com/token/0x1b0E319c6A659F002271B69dB8A7df2F911c153E) as its gas: rollup, bridge, inbox, outbox, sequencer inbox, fee pricer, ETH gas router, token bridge, and the exchange (Uniswap V2 with Wrapped GME). The validator is staked and posting. Addresses: [docs/contracts.md](docs/contracts.md).
- **Fee pricer limits tightened.** The price keeper may move the GME price at most **3% per update, once every 15 minutes** (was 10% every minute), so even a leaked keeper key cannot move gas prices quickly. Check `maxDeviationBps()` (300) and `minUpdateInterval()` (900) on the pricer.
- **Validator allowlist stated plainly.** At launch only our validator can post or dispute state claims; the site, the docs and [TRANSPARENCY.md](TRANSPARENCY.md) say so.
- The mainnet apps stay closed until launch; the site runs on testnet until then.

### Testnet
- **GME CHAIN Testnet** (chain 12822) is live with tGME as gas: bridge, exchange (tGME/tUSD), explorer and a one-click test kit faucet. A public test wallet (the "pulse") makes small transactions so the explorer always shows activity; it holds test tokens only.

### gmechain.xyz
- **Design.** A game look in GameStop red on black: pixel type (Jersey 25, Micro 5, Pixelify Sans), a 3D ASCII cartridge, a particle wordmark, game buttons and a tilted tape.
- **Explorer, the "game log".** A scoreboard (level, moves, players, gas, cost, GME spent as gas), a stage-select grid of the latest 48 blocks, and live screens for blocks and transactions that update every few seconds.
- **Docs, the "player's manual".** Numbered pages, contents with page numbers, hint and warning boxes.
- **Roadmap, the "world map".** Every phase as a world with its progress, every item marked clear, live, next or locked, including what comes after mainnet.
- **Home.** Live GME price from Uniswap v3, a market clock (NYSE hours next to GME CHAIN, open 24/7), the official GME token contract set apart from look-alikes, and a place for the $GMEC contract, which is published on this site only.
- Links to X ([@GMEChainXYZ](https://x.com/GMEChainXYZ)) and this repository in the footer.

### Security and operations
- Content-Security-Policy on the site and a per-IP rate limit on the public RPCs.
- No code from a CDN: the wallet libraries and the fonts are served by the site itself.
- The website deploys itself from this repository; server settings are applied with [deploy/vps/update-server.sh](deploy/vps/update-server.sh).
- CI on every change: contract tests (unit, fuzz, and the gas router against a fork of Robinhood Chain), a check that the deployed bytecode matches this source, script syntax and a secrets check.

### Launch tooling
- [launch-check.js](chain/scripts/launch-check.js): a read-only readiness check of the chain, operators, keeper, bridge and site config.
- [gmec-check.js](chain/scripts/gmec-check.js) and [tools/launch.py](tools/launch.py): check the $GMEC contract, then publish it and open mainnet in one step.
- [seed-usdg-pool.js](chain/scripts/seed-usdg-pool.js): the first mainnet pool, GME/USDG, seeded at the market price of Robinhood Chain's deepest GME pool. It refuses to run when prices disagree or when someone has pre-priced the pair; rehearsed end to end on forks.
- [pricer-params.js](chain/scripts/pricer-params.js) and [rollup-window.js](chain/scripts/rollup-window.js): the two parameter changes above, each rehearsed on a fork before being sent.
