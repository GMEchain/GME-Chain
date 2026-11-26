# GME CHAIN: chain

Arbitrum Nitro L3 (Rollup mode, BoLD) settling to Robinhood Chain, with the **GME Stock Token** as the gas token.

| | Mainnet | Fork rehearsal | Testnet |
| --- | --- | --- |---|
| Chain ID | 12821 | 12821 | 12822 |
| Parent | Robinhood Chain (4663) | local Anvil fork of 4663 | Robinhood Chain Testnet (46630) |
| Gas token | GME `0x1b0E319c6A659F002271B69dB8A7df2F911c153E` | real GME on the fork | tGME |
| Keys | `../.env.mainnet` | `../.env.mainnet` (no real funds spent) | `../.env` |

## Contracts

- `contracts/GmeFeeTokenPricer.sol`: tells the SequencerInbox how many raw GME equal 1 ETH (ETH/USD from Chainlink `0x78F3556b67E17Df817D51Ef5a990cDaF09E8d3A9`, GME/USD from the keeper). `getExchangeRate()` never reverts; 11 tests including fuzzing.
- `contracts/GmeGasRouter.sol`: the bridge with ETH. `depositEth` wraps ETH, swaps WETH → GME on Uniswap v3 (SwapRouter02) along a path that must start with WETH and end with GME, then opens a retryable ticket on the GME CHAIN inbox to the receiver. `swapGmeToEth` does the way back after a withdrawal. No owner, no fee, holds nothing between calls. 9 tests run against a fork of Robinhood Chain mainnet (`ROBINHOOD_RPC=https://robinhood.drpc.org forge test`).
- `contracts/WrappedGME.sol`: the exchange's base asset (a WETH9 port).
- `contracts/TestGME.sol`, `TestUSD.sol`: testnet-only tokens.
- `contracts/dev/*Mock.sol`: Arbitrum precompile stand-ins, used **only** on the local fork.

## Mainnet flow

```bash
npm run rehearse                                   # full deployment on a mainnet fork + checks; unlocks mainnet
npm run mainnet:check                              # ETH and GME balances of the operator wallets
INITIAL_GME_USD=26.74 npm run mainnet:rollup       # pricer + core contracts; asks you to type "deploy mainnet"
node scripts/06-gas-router.js --mainnet            # GmeGasRouter (bridge with ETH), bound to the new inbox
NODE_PARENT_RPC=<archive RPC> npm run mainnet:node-config   # nodeConfig.mainnet.json for the Nitro node (contains keys)
node scripts/04-token-bridge.js --mainnet          # token bridge (once the node is running)
node scripts/05-dex.js --mainnet                   # Wrapped GME + Uniswap V2 on GME CHAIN
node scripts/vps-env.js --mainnet                  # per-service key files for the server (deploy/vps/secrets)
```

Mainnet scripts refuse to run until `npm run rehearse` has passed with the real, funded operator wallets (`rehearsal.json`). Use the current GME/USDG TWAP for `INITIAL_GME_USD` (the site shows it, and the keeper corrects it within minutes).

After deploying, copy the addresses from `deployment.mainnet.json` into `site/js/config.js` (the `mainnet` profile). The site switches each app page from pre-launch to live on its own.

## Testnet flow

The order used for GME CHAIN Testnet. `PARENT_RPC` must reach Robinhood Chain Testnet (an Alchemy URL works).

```bash
node scripts/01-deploy-tgme.js                          # tGME on Robinhood Chain Testnet
node scripts/01b-deploy-mock-feed.js                    # mock ETH/USD feed (testnet has no Chainlink feed)
FUND_FAUCET=0.0015 FUND_FAUCET_TGME=200000 node scripts/fund-operators.js
INITIAL_GME_USD=26.74 node scripts/02-create-rollup.js  # pricer + core contracts
NODE_PARENT_RPC=$PARENT_RPC node scripts/03-node-config.js
node scripts/wrap-stake.js                              # WETH bond for the validator
# start nitro-testnet on the server, then:
DEPOSIT=50000 node scripts/deposit.js                   # tGME into GME CHAIN Testnet, for gas
node scripts/05-dex.js                                  # Wrapped tGME, Uniswap V2, tUSD, seeded pool
```

## Services

| Service | Script | Runs |
| --- | --- | --- |
| Nitro node (sequencer, batch poster, validator) | `nodeConfig.mainnet.json` | `deploy/vps/docker-compose.coolify.yml`, service `nitro` |
| Price keeper (GME/USD from the Uniswap v3 TWAP) | `scripts/keeper.js` | service `keeper` |
| Monitor and alerts | `scripts/monitor.js` | service `monitor` |
| Testnet node | `nodeConfig.testnet.json` | service `nitro-testnet` |
| Testnet faucet ("Get test kit") | `scripts/faucet.js` | service `faucet` |
| Testnet pulse (keeps the explorer busy) | `scripts/testnet-pulse.js` | service `pulse` |

Server guide: [../docs/vps-guide.md](../docs/vps-guide.md).

## Keys

Never commit or share `.env`, `.env.mainnet`, `nodeConfig.*.json` or `deploy/vps/secrets/` (all gitignored). The deployer key never needs to be on the server. Move the chain owner role to a Safe after launch.

## DNS note

Some ISPs hijack DNS for `*.robinhood.com`, even plain UDP to 1.1.1.1. `scripts/lib.js` resolves through Cloudflare DNS-over-HTTPS and still verifies TLS certificates, and mainnet scripts default to `https://robinhood.drpc.org`.
