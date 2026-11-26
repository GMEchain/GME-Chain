# Using GME CHAIN mainnet

> **Status: deployed, opening at launch.** The contracts are live on chain; the website's mainnet apps open at launch. Until then try the same flow on the [testnet](testnet-guide.md).

GME CHAIN mainnet is an Arbitrum chain on Robinhood Chain where every fee is paid in **GME**, the GME Stock Token. This guide covers adding the network, bridging ETH (or GME) in, using it, and withdrawing back to ETH.

The free testnet is live now: [testnet-guide.md](testnet-guide.md).

## Network

| | |
|---|---|
| Network name | GME CHAIN |
| Chain ID | `12821` (`0x3215`) |
| RPC | `https://rpc.gmechain.xyz` |
| Currency | GME, 18 decimals |
| Explorer | [gmechain.xyz/explorer](https://gmechain.xyz/explorer/) |
| Parent chain | Robinhood Chain, chain ID `4663` |
| GME on Robinhood Chain | `0x1b0E319c6A659F002271B69dB8A7df2F911c153E` |

Every contract address is in [contracts.md](contracts.md).

## What you need

- **ETH on Robinhood Chain.** The bridge swaps it to GME for you and pays the deposit's gas from it.
- Or, if you already hold it, **GME on Robinhood Chain** plus a little ETH for gas.

## 1. Bridge in

1. Open [gmechain.xyz/bridge](https://gmechain.xyz/bridge/) and press **Connect wallet**. MetaMask, Rabby, Coinbase Wallet and mobile wallets (through WalletConnect) work.
2. Under **Deposit**, keep **Pay with ETH** selected and enter an amount of ETH. The page quotes every Uniswap v3 route and shows how much GME will arrive, and the minimum with the 1% price limit.
3. Press **Swap and deposit** and confirm **one** transaction on Robinhood Chain. The GmeGasRouter contract swaps your ETH to GME and deposits it to your own address. If the price moved more than 1% the transaction reverts and your ETH stays where it was.
4. The GME arrives on GME CHAIN as gas, usually within a minute.
5. Press **Add network** to see GME CHAIN and your GME in your wallet.

Already hold GME on Robinhood Chain? Choose **Pay with GME**: approve once, then deposit.

## 2. Use it

- **Send and deploy** like on any EVM chain. Fees are paid in GME and are a fraction of a cent for a transfer.
- **Trade** on the [exchange](https://gmechain.xyz/swap/) (Uniswap V2 contracts). Mainnet pools are created by their liquidity providers; if a pair has no pool yet, the page says so.
- **Look anything up** in the [explorer](https://gmechain.xyz/explorer/).

## 3. Withdraw GME back to Robinhood Chain

Withdrawing has two steps, and the second one comes about **a day** later.

1. On the bridge page, open **Withdraw**, enter an amount and confirm one transaction on GME CHAIN.
2. The withdrawal appears under **Your withdrawals** with a countdown. It waits for the challenge window: the validator's claim about the chain's state has to stand for about a day (7,200 Ethereum blocks). This is what keeps the bridge safe.
3. When the countdown ends, press **Claim** and confirm one transaction on Robinhood Chain. Your GME is back on Robinhood Chain.
4. Want ETH instead? Under **Receive ETH: convert claimed GME**, enter the amount (the page fills it in after a claim), approve once and confirm. You get ETH in one transaction, with the same 1% price limit.

Nobody can speed up a withdrawal or cancel it once it has started. The claim stays available, so you can claim later as well.

## Fees

| | |
|---|---|
| Transfer on GME CHAIN | A fraction of a cent, paid in GME |
| Deposit / claim | Normal Robinhood Chain gas, paid in ETH |
| Bridge fee | None. Paying with ETH, the Uniswap pool fee (0.05% on WETH/GME) is already inside the quote |

The fee pricer converts the chain's ETH costs into GME using Chainlink's ETH/USD feed and the GME market price from the USDG/GME pool on Robinhood Chain, kept current by the price keeper.

## Know the risks

- **One operator** runs the sequencer, the batch poster and the validator today. The validator posts a bond; while the allowlist is on, only our validator can post or dispute state claims.
- **GME is issued by Robinhood.** If the issuer pauses GME, deposits and withdrawals of GME pause too.
- **The contracts have not had an external audit yet.** Start with amounts you are comfortable with.
- GME CHAIN is independent and is not affiliated with GameStop Corp., Robinhood Markets, Inc. or Offchain Labs. Nothing here is an offer or investment advice.

## Common problems

| Problem | Fix |
|---|---|
| "Insufficient funds" on Robinhood Chain | You need a little ETH there for the approve and deposit, not only GME. |
| Deposit sent but no GME on GME CHAIN | Wait a minute and refresh. Check that your wallet is on GME CHAIN (12821), not testnet (12822). |
| The bridge shows tGME | The switch is on Testnet. Press **Mainnet** at the top of the page. |
| The Claim button is not there | The 7 day window has not ended yet; the countdown shows when it does. |
