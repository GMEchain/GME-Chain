# Staking $GMEC for gas credits

> **Status: opening.** $GMEC is live on Robinhood Chain at `0xa8c53b1dAcFbd07895dC8D2c638F1bFDe10C0122`. The staking contract passed a rehearsal on a fork of Robinhood Chain mainnet with the real $GMEC; its address is filled in below when it is deployed.

Stake $GMEC on Robinhood Chain and earn gas credits every second. Spend credits on free GME gas on GME CHAIN. You can unstake at any time.

Page: [gmechain.xyz/stake](https://gmechain.xyz/stake/)

## What you need

| | |
|---|---|
| Network | Robinhood Chain, chain ID `4663` |
| RPC (if your wallet asks) | `https://robinhood.drpc.org` |
| $GMEC | `0xa8c53b1dAcFbd07895dC8D2c638F1bFDe10C0122` (trade it on [FOMO](https://fomo.family/tokens/robinhood/0xa8c53b1dacfbd07895dc8d2c638f1bfde10c0122?r=NeatTightBass) or [Pons](https://ponsfamily.com/launchpad/0xa8c53b1dacfbd07895dc8d2c638f1bfde10c0122)) |
| Staking contract | _(at deployment)_ |
| Gas | A little ETH on Robinhood Chain for the approve and stake transactions |

Only the two addresses above are ours. Other tokens with the name "GME Chain" are not $GMEC.

## Stake

1. **Open** [gmechain.xyz/stake](https://gmechain.xyz/stake/) and press **Connect wallet**. MetaMask, Rabby, Coinbase Wallet and mobile wallets (through WalletConnect) work.
2. **Switch network.** If your wallet is on another chain, the page asks it to switch to Robinhood Chain, and adds the network if the wallet does not know it yet. Approve that in your wallet.
3. **Enter an amount**, or press **10%** to **100%** of what is in your wallet.
4. **Approve, then stake.** The first time, your wallet asks for two transactions: *Approve* lets the staking contract take $GMEC from you, then *Stake* moves it in. Later stakes need only the second one.
5. **Watch credits grow.** The page shows your staked amount and your credits, counting up every second.

## How credits are counted

Credits are **token-days**: 1 $GMEC staked for 1 day earns 1 credit. 100 $GMEC staked for 3 days earns 300. Adding or removing $GMEC changes the rate from that moment; credits already earned stay.

## Use credits: claim gas

On the Stake page, the **Claim gas on GME CHAIN** card turns credits into gas:

1. Press **Claim gas**. Your wallet asks you to **sign a message**. It is free and is not a transaction; it only proves the wallet is yours, so nobody can spend your credits.
2. The credits service checks your credits on chain, records the use with `spendCredits` on the staking contract, and sends GME to the same address on GME CHAIN.
3. One claim per wallet per day, and a daily limit for everyone together. The card shows how many credits a claim costs and how much gas it gives.

The gas comes from a pot that is filled only from launchpad fee income (the treasury half of the 1% [launchpad](launchpad.md) fee), never from the project's own funds. While the pot is empty, claims are closed; your credits keep counting and nothing is lost by waiting.

Every use is recorded on chain (`spentOf` and the `CreditsSpent` event), so anyone can check it. The service's code is [`chain/scripts/credits.js`](../chain/scripts/credits.js).

## Unstake

Switch to the **Unstake** tab, enter an amount (or **100%**) and confirm one transaction. The $GMEC returns to your wallet right away.

- No lock and no fee: you can unstake at any time.
- Credits you have earned are kept after you unstake.
- Nobody, including the GME CHAIN team, can move staked tokens or block an unstake.

## What the owner can and cannot do

The contract owner can only:
- pause **new** stakes (unstaking always works);
- choose the *redeemer*, the account that records credit use when gas is paid;
- recover tokens sent to the contract by mistake, but never the $GMEC that people staked.

The source is [`chain/contracts/GmecStaking.sol`](../chain/contracts/GmecStaking.sol), covered by 23 tests including fuzzing.

## What credits are not

Credits are not a token. They cannot be transferred, sold or traded, and they pay no yield or reward. They are only a right to use gas on GME CHAIN. Nothing here is an offer or a promise of value. $GMEC has no connection to GameStop Corp..

## Common problems

| Problem | Fix |
|---|---|
| "Insufficient funds" | You need a little ETH on Robinhood Chain for gas, not just $GMEC. |
| The button keeps asking to switch network | Add Robinhood Chain manually: chain ID `4663`, RPC `https://robinhood.drpc.org`, currency ETH. |
| My $GMEC balance shows 0 | Check that you hold the real $GMEC (`0xa8c5…0122`) and that the wallet is on Robinhood Chain. |
| Credits are not counting | Credits only grow while something is staked. Refresh the page after the stake transaction confirms. |
