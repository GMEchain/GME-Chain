# tGME: the testnet gas token

> **Status: live.** tGME is at `0x65325eee8c55a7a0f8977863a4e5397490cd38c7` on Robinhood Chain Testnet.

**tGME** ("Test GME") is the gas token of **GME CHAIN Testnet**. It plays the part that the real GME Stock Token plays on mainnet, so you can try every feature of GME CHAIN without spending anything.

> tGME has **no value**. It cannot be bought, sold or exchanged for real GME, and it never will be. Never send real assets to testnet addresses.

## At a glance

| | |
|---|---|
| Name / symbol | Test GME / `tGME` |
| Standard | ERC-20, 18 decimals, no transfer fees, no rebasing |
| Lives on | Robinhood Chain Testnet (chain ID 46630) |
| Address | _(at deployment)_ |
| On GME CHAIN Testnet | the **native currency**: your wallet balance and every fee |
| Source | [`chain/contracts/TestGME.sol`](../chain/contracts/TestGME.sol) |
| Value | none |

## Why a test token?

GME CHAIN mainnet uses the real GME Stock Token as gas. To let anyone try the chain freely, the testnet runs the same software with a stand-in token that behaves the same way:

- you hold it on the parent chain (Robinhood Chain Testnet),
- you **bridge** it into GME CHAIN, where it becomes the native gas currency,
- every fee, swap and contract call on GME CHAIN Testnet is paid in it,
- you can **withdraw** it back to the parent chain, with the same challenge-window wait that mainnet has (shorter on testnet).

## How to get tGME

**Option 1: the test kit (easiest).** Open the [bridge page](https://gmechain.xyz/bridge/), connect your wallet and press **Get test kit**. Our faucet sends, on Robinhood Chain Testnet:

- a small amount of **testnet ETH** (only if your wallet is short), to pay for the deposit transaction there, and
- **100 tGME**.

One kit per wallet (and per network connection) every 24 hours. You do not need any other faucet.

**Option 2: the contract's own faucet.** If you already have testnet ETH on Robinhood Chain Testnet, call `drip()` on the tGME contract (the bridge page has a button for it). It mints **100 tGME** to the caller, once a day per address.

```bash
cast send (at deployment) "drip()" \
  --rpc-url https://rpc.testnet.chain.robinhood.com --private-key $TEST_KEY
```

## Using tGME

1. **Deposit** tGME through the bridge. The same amount appears on GME CHAIN Testnet as gas, usually within a minute.
2. **Spend** it: transfers, swaps on the exchange, contract deployments. A simple transfer costs about 0.0000028 tGME.
3. **Withdraw** it back to Robinhood Chain Testnet. Claims open after about an hour; the bridge page shows a countdown and a **Claim** button.

On GME CHAIN Testnet there is also **Wrapped tGME** (_(at deployment)_), an ERC-20 version of the native tGME used by the exchange, the same way WETH wraps ETH.

## tUSD

**tUSD** ("Test USD") is a second test token, used to give the exchange a trading pair. It lives on GME CHAIN Testnet at _(at deployment)_, has 18 decimals, and anyone can call `drip()` for 10,000 tUSD a day. It is not pegged to anything and has no value.

## What the contract can do

`TestGME.sol` is a plain OpenZeppelin ERC-20 with two extras:

- `drip()`: public, 100 tGME per address per 24 hours.
- `mint(to, amount)`: **owner only**, used to fund the faucet and seed tests.

There are no transfer hooks, fees, pauses or blocklists. The real GME token on mainnet does have issuer controls (pause, block, burn, upgrade); see [how-it-works.md](how-it-works.md#the-gas-token-on-mainnet).

## FAQ

**Is tGME the same as $GMEC?** No. tGME is a test stand-in for GME, the gas token. $GMEC is the GME CHAIN token, live on Pons at _(at deployment)_.

**Will tGME be converted or airdropped into anything?** No. Testnet balances carry no rights and are not converted into anything.

**The dollar amounts on testnet: are they real?** They use the live GME market price (the USDG/GME pool on Robinhood Chain) to show what the same fee *would* cost on mainnet. Your tGME itself is worth nothing.
