# Transparency

Everything GME CHAIN runs is listed here: every contract and the source it was built from, every wallet the team operates and what it can do, where fees go, and what is not in place yet. All of it can be checked on chain.

As of 26 November 2026: the mainnet contracts are deployed and verified, and the mainnet apps open at launch. The testnet is live. Every address is in [docs/contracts.md](docs/contracts.md).

## Check it yourself

Every contract we wrote is, on chain, exactly the code in this repository. You can prove it in one command, with no keys:

```bash
cd chain && npm ci && forge build && node scripts/verify-bytecode.js
```

It compiles the sources here and compares them byte for byte with the code deployed on Robinhood Chain and on GME CHAIN. Only constructor-set values may differ. The [CI](.github/workflows/ci.yml) runs it on every push. GmeFeeTokenPricer and GmeGasRouter are also an exact match on Sourcify.

The chain's own core contracts (rollup, bridge, inbox, outbox, token bridge) are the standard Arbitrum Nitro contracts deployed by Offchain Labs' [orbit SDK](https://github.com/OffchainLabs/arbitrum-chain-sdk), not code written here.

## What already exists (not ours)

| What | Address on Robinhood Chain (4663) | Checked |
|---|---|---|
| GME Stock Token, the gas token | `0x1b0E319c6A659F002271B69dB8A7df2F911c153E` | `name()` "GameStop • Robinhood Token", `symbol()` GME, 18 decimals; beacon proxy to Robinhood's stock token beacon `0xe10b6f6b275de231345c20d14ab812db62151b00`, byte-identical to every other Robinhood stock token |
| Uniswap v3 GME/USDG 1% (price source) | `0xe9713f453adb9245b19559790c96f470a18f2fdf` | token0 GME, token1 USDG, factory = Uniswap v3 factory below, 3,601 oracle observations |
| Uniswap v3 WETH/GME 0.05% (ETH bridge route) | `0xc6bcc95043dc48c204bb2d57fb264a10efe0a607` | token0 WETH, token1 GME |
| Uniswap v3 factory / SwapRouter02 / QuoterV2 | `0x1f7d7550…2efa` / `0xcaf681a6…5cb2` / `0x33e885ed…a9e7` | From Uniswap's Robinhood Chain deployment list; `SwapRouter02.factory()` and `WETH9()` match |
| Chainlink ETH/USD | `0x78F3556b67E17Df817D51Ef5a990cDaF09E8d3A9` | Used by the fee pricer |

## Contracts we wrote

| Contract | Chain | Address | Source | Tests |
|---|---|---|---|---|
| GmeGasRouter (bridge with ETH) | Robinhood Chain | `0x150415997ad7b9a4bf724dfb552c63fe50f33ecd` | [GmeGasRouter.sol](chain/contracts/GmeGasRouter.sol) | 9, on a fork of Robinhood Chain mainnet with the real pools |
| GmeFeeTokenPricer | Robinhood Chain | `0x97dcc10f4f99dc0643540921efea2ee043502c24` | [GmeFeeTokenPricer.sol](chain/contracts/GmeFeeTokenPricer.sol) | 11, including fuzzing |
| WrappedGME (WGME) | GME CHAIN | `0xF47680692201c5c1615FAdc69db4A8Ad6fFA0B01` | [WrappedGME.sol](chain/contracts/WrappedGME.sol) | port of WETH9 |

## Operator wallets

Created for GME CHAIN on 26 November 2026, separate from any other project. Mainnet and testnet use different wallets. Only public addresses are listed; keys stay with the operator.

| Role | Mainnet address | Does | Cannot |
|---|---|---|---|
| Deployer / chain owner | `0x9354A2F5DbD6D7F0EF33e678F083C2927690B8D4` | Deploys the contracts and owns them at first | See "What the owner can do" |
| Batch poster | `0x13D8134c2DEF15Eba09a13D65557428C68912c91` | Posts GME CHAIN's transaction batches to Robinhood Chain | Nothing else |
| Validator | `0x96013907aF557E9F1692801DC7474cF8E7a63127` | Posts a bond and asserts the chain's state | Its claims can be challenged |
| Price keeper | `0xB15B14BD07Be83D50a7F652A10fea13C95867b9F` | Keeps the fee pricer's GME price in line with the market | Move the price more than the pricer's per-update limit |

Testnet runs its own wallets, all holding test tokens only. Two of them act in public: the **faucet** `0xA5d24060fAd51e6340Bab4F1D5593ADe6eF3f502` sends test kits, and the **pulse** `0xf84A2cf5c78Cc28e68833e5bf740c153bCA247Ad` makes a small test transaction every few minutes (tGME transfers, swaps, wraps) so the testnet explorer always shows live activity. The pulse never runs on mainnet.

## What the owner can do

| Contract | The owner can | The owner can never |
|---|---|---|
| GME CHAIN (rollup, via its upgrade executor) | Upgrade the chain's core contracts (bridge, inbox, outbox, rollup) and change their settings. An upgrade can change any rule, including withdrawals, and there is no timelock at launch: this is the main trust assumption | — |
| GME CHAIN (chain owner, ArbOS) | Change gas pricing parameters | — |
| GmeGasRouter | No owner | — |
| GmeFeeTokenPricer | Set the GME or ETH price directly (for emergencies and corporate actions); change the keeper and its limits | Set a price outside its hard range |
| Exchange factory (Uniswap V2, `feeToSetter` is the deployer) | Point the protocol fee (`feeTo`) at another address, or turn it off | Change the 0.3% swap fee, or touch liquidity in any pool |

## Where the money goes

| Flow | Destination |
|---|---|
| GME CHAIN gas fees | Network fee account (the deployer); this pays for posting batches to Robinhood Chain |
| Bridge | No fee. Paying with ETH, the only cost besides gas is the Uniswap pool fee inside the quote (0.05% on the WETH/GME pool) |
| Exchange swaps | 0.3% per swap (standard Uniswap V2), all to liquidity providers |

## Not in place yet

- **Mainnet apps are not open yet.** The contracts are deployed; the website switches to them at launch.
- **No external audit.** The contracts are covered by automated tests (unit, fuzz and fork), which are not an audit.
- **No multisig or timelock** at launch. One key controls upgrades and settings.
- **One operator** runs the sequencer, batch poster and validator.
- **Off-chain services** (price keeper, monitor, testnet faucet and pulse) run on the operator's server with only their own keys there; their code is in [chain/scripts](chain/scripts) and the server layout in [deploy/vps](deploy/vps).

## How to report a problem

See [SECURITY.md](SECURITY.md).
