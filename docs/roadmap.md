# Roadmap

What is done, what comes next, and what is planned. Statuses are kept up to date in this file and on [gmechain.xyz/roadmap](https://gmechain.xyz/roadmap/), where each phase is a world on the map.

- **Done / live**: you can check it today.
- **Next**: the launch now being prepared.
- **Planned**: intended, not promised. No dates until they are certain, and nothing here is an offer.

## World 1. Groundwork (done)

| Stage | Item | Status |
| --- | --- | --- |
| 1-1 | GME Stock Token chosen and verified on chain: `0x1b0E319c6A659F002271B69dB8A7df2F911c153E`, same Robinhood beacon as every stock token | Done |
| 1-2 | Live GME price on the site, from the Uniswap v3 GME/USDG pool on Robinhood Chain every 15 seconds | Live |
| 1-3 | Fee keeper reads a 30-minute TWAP from the deepest GME pool, checked against a second pool | Done |
| 1-4 | Rollup with GME as gas created end to end on a fork of Robinhood Chain mainnet (real GME, real RollupCreator, live Chainlink ETH/USD) | Done |
| 1-5 | Bridge with ETH: GmeGasRouter swaps ETH to GME and deposits it in one transaction; GME back to ETH after a withdrawal. Tested on the real Uniswap pools | Done |
| 1-6 | Full mainnet deployment rehearsed on a fork of Robinhood Chain | Done |

## World 2. Testnet, then mainnet (now)

| Stage | Item | Status |
| --- | --- | --- |
| 2-1 | GME CHAIN Testnet (chain 12822): tGME as gas, bridge, exchange, explorer and a one-click test kit | Live |
| 2-2 | Mainnet contracts on Robinhood Chain: rollup, bridge with ETH, fee pricer, token bridge, all verified | Done |
| 2-3 | Mainnet node at rpc.gmechain.xyz, validator staked, monitoring | Live |
| 2-4 | Mainnet exchange (Uniswap V2) and Wrapped GME on GME CHAIN | Done |
| 2-5 | Withdrawals in about a day: the mainnet challenge window set to 7,200 Ethereum blocks, down from 7 days | Done |
| 2-6 | First exchange pool on mainnet: GME/USDG, opened at the market price | Done |
| 2-7 | Mainnet apps open on gmechain.xyz | Next |

## World 3. $GMEC (done)

| Stage | Item | Status |
| --- | --- | --- |
| 3-1 | $GMEC live on Robinhood Chain: 0xa8c5…0122, the only official contract, published on gmechain.xyz | Done |

## World 4. Lock it down (planned)

| Stage | Item | Status |
| --- | --- | --- |
| 4-1 | Chain ownership moved to a multisig behind a timelock, so no upgrade can happen without notice | Planned |
| 4-2 | External audit of the GME CHAIN contracts, report published in full | Planned |
| 4-3 | Public bug bounty | Planned |
| 4-4 | Validator allowlist opened, with a higher bond, so anyone can check the chain and challenge a wrong claim | Planned |
| 4-5 | Public RPC served by its own nodes, separate from the sequencer | Planned |

## World 5. More to play (planned)

| Stage | Item | Status |
| --- | --- | --- |
| 5-1 | Bridge more Robinhood stock tokens to GME CHAIN, not only GME | Planned |
| 5-2 | Stock-token pairs on the exchange, with price charts on the swap page | Planned |
| 5-3 | Fast withdrawals through liquidity providers, instant instead of a day | Planned |
| 5-4 | First transaction free: a new wallet gets its first gas covered, so it can start without buying GME first | Planned |
| 5-5 | GME CHAIN listed in wallet network lists, so it can be added with one tap | Planned |

## World 6. Builders (planned)

| Stage | Item | Status |
| --- | --- | --- |
| 6-1 | Explorer upgrades: token pages, holders and verified contract source | Planned |
| 6-2 | Public API and indexer for blocks, transactions and token transfers | Planned |
| 6-3 | Contract templates and step-by-step guides for building on GME CHAIN | Planned |
| 6-4 | Public status page for the chain, the bridge and the RPC | Planned |

## Not changing

- **Gas stays GME.** $GMEC is for the chain's own economy, not a replacement for GME as gas.
- **The mainnet challenge window is about one day.** It protects the funds in the bridge; instant withdrawals will come from liquidity providers instead.
- **GME CHAIN is independent** of GameStop Corp., Robinhood Markets, Inc. and Offchain Labs.
