# Launchpad

> **Status: live** since 27 November 2026, after a full rehearsal on a fork of GME CHAIN mainnet.

The GME CHAIN launchpad lets anyone create a token in one transaction. Every trade on it is paid in **GME**, the gas token of GME CHAIN: you pay GME to buy and get GME back when you sell.

Page: [gmechain.xyz/launch](https://gmechain.xyz/launch/) · Contract: [`chain/contracts/GmeLaunchpad.sol`](../chain/contracts/GmeLaunchpad.sol)

| Network | Address |
|---|---|
| GME CHAIN mainnet | [`0xB7C9B7dE689738218CF20379646fB54c251a5053`](https://gmechain.xyz/explorer/address/0xB7C9B7dE689738218CF20379646fB54c251a5053) |

## How a token works

1. **Create.** Pick a name, a ticker, an optional description, image and link. You can add a first buy in the same transaction, so you are the first holder. Creating is free (no creation fee).
2. **Supply.** Every token has 1,000,000,000 units and 18 decimals. Nobody can mint more, and the token has no owner, no tax and no blacklist.
3. **Bonding curve.** 800,000,000 tokens are sold on a curve priced in GME. Each buy raises the price, each sell lowers it. You can sell back to the curve at any time.
4. **Graduation.** When all 800,000,000 are sold, **100 GME** has been raised. The remaining 200,000,000 tokens and the 100 GME go into a Uniswap V2 pool on the [GME CHAIN exchange](https://gmechain.xyz/swap/). The pool tokens are sent to `0x…dEaD`, so that liquidity is locked forever. From then on the token trades on the exchange.

All the money in a curve and in a graduated pool comes from the people who buy the token. GME CHAIN does not seed or own any of it.

Under the hood the launchpad trades against Wrapped GME (WGME, the exchange's wrapped form of GME). It wraps the GME you send and unwraps the GME it pays you, so you only ever see GME. If a buy is larger than what is left on the curve, the unused GME is sent back in the same transaction.

## Fees

| | |
|---|---|
| Trading fee | 1% of each buy and sell, in GME. Half goes to the [FeeBurner](fee-burn.md), which can only turn it into $GMEC sent to `0x…dEaD`. Half goes to the treasury (the deployer). |
| Creating a token | Free. |
| Exchange fee after graduation | 0.3% per swap (standard Uniswap V2): 0.25% to liquidity providers, 0.05% to the FeeBurner. |

The treasury half also pays for the gas that $GMEC stakers can claim with their [gas credits](staking-guide.md): the gas pot is filled from this fee income only.

## What the owner can and cannot do

The owner (the deployer) can:

- change the trading fee (never above 2%), the share sent to the FeeBurner, the creation fee, the treasury address and the graduation target. These apply to **new** tokens only for the target; fee changes apply to trades from then on. Every change emits `ParamsChanged`.
- change where the burn share goes (`setBurnSink`, emits `BurnSinkSet`).
- pause and resume the creation of **new** tokens (`setLaunchesOpen`). Trading on existing curves is never paused.

The owner can never move the GME held by a curve, mint tokens, stop anyone from selling, or touch a graduated pool.

## Before you buy

Anyone can create a token here, including copies of real projects and tokens made to lose you money. GME CHAIN does not review or endorse any of them. Check the creator and the contract address, and only spend what you can lose. Nothing here is investment advice.

## Check it yourself

- `launches(token)` returns the curve of a token: creator, raised GME, tokens sold, target, pool, graduated.
- `feeBps()`, `burnShareBps()`, `createFee()`, `graduationTarget()`, `treasury()`, `burnSink()` return the current settings.
- `node scripts/verify-bytecode.js` (in `chain/`) compares the deployed bytecode with this repository's source.
- `node scripts/rehearse-launchpad.js --mainnet` replays the whole flow (create, buy, sell, graduate) on a local fork of GME CHAIN mainnet.
