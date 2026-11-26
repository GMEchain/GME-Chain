# Roadmap

What is done, what comes next, and what is planned. Statuses are kept up to date in this file and on [gmechain.xyz/roadmap](https://gmechain.xyz/roadmap/).

- **Done / live**: you can check it today.
- **Next**: the launch now being prepared.
- **Planned**: intended, not promised. No dates until they are certain, and nothing here is an offer.

## 1. Groundwork (done)

| Item | Status |
| --- | --- |
| GME Stock Token verified on chain: `0x1b0E319c6A659F002271B69dB8A7df2F911c153E`, same Robinhood beacon as every stock token | Done |
| Live GME price on the site, from the Uniswap v3 GME/USDG pool on Robinhood Chain | Live |
| Fee keeper reads a 30-minute TWAP from the deepest GME pool, checked against a second pool | Live |
| Bridge with ETH: `GmeGasRouter` swaps ETH to GME and deposits it in one transaction; GME back to ETH after a withdrawal | Done |
| Full mainnet deployment rehearsed on a fork of Robinhood Chain (`npm run rehearse`) | Done |

## 2. Testnet, then mainnet (now)

| Item | Status |
| --- | --- |
| GME CHAIN Testnet (chain 12822): tGME as gas, bridge, exchange, explorer, one-click test kit | Live |
| Mainnet contracts on Robinhood Chain: rollup, bridge with ETH, fee pricer, token bridge | Done, verified |
| Mainnet node at `rpc.gmechain.xyz`, validator staked, monitoring | Live |
| Mainnet exchange (Uniswap V2) and Wrapped GME on GME CHAIN | Done |
| Mainnet apps open on gmechain.xyz | Next |

## 3. $GMEC (planned)

| Item | Status |
| --- | --- |
| $GMEC launch on Robinhood Chain; the only contract is the one published on gmechain.xyz | Planned |

## 4. After launch (planned)

| Item | Status |
| --- | --- |
| Chain ownership moved to a multisig; external audit of the GME CHAIN contracts | Planned |
| Fast withdrawals through liquidity providers | Planned |

## Not changing

- **Gas stays GME.** $GMEC is for the chain's own economy, not a replacement for GME as gas.
- **The mainnet challenge window stays about 7 days.** It protects the funds in the bridge.
- **GME CHAIN is independent** of GameStop Corp., Robinhood Markets, Inc. and Offchain Labs.
