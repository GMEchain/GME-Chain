# When the swap fee is burned

> **Status: opening.** The FeeBurner passed a rehearsal on a fork of GME CHAIN mainnet. Addresses below are filled in when it is deployed.

0.05% of every swap on the GME CHAIN exchange, taken from the 0.3% pool fee, is turned into $GMEC and sent to the dead address `0x000000000000000000000000000000000000dEaD`. Traders pay nothing extra (0.25% still goes to liquidity providers) and the bridge has no fee.

The FeeBurner has a second source: half of the 1% [launchpad](launchpad.md) trading fee. That arrives directly as Wrapped GME, with no pool step, and is burned the same way in step 3.

**A burn needs a GME / $GMEC pool on GME CHAIN.** The keeper turns GME into $GMEC by swapping on the GME CHAIN exchange. Until someone bridges $GMEC to GME CHAIN and provides GME / $GMEC liquidity, the FeeBurner simply holds what it receives; nothing can take it out, and the first burn happens once that pool exists.

A burn does not happen on every swap. It happens in three steps.

1. **Swaps: the fee builds up inside the pool.** Each swap pays 0.3%. The 0.05% part stays in the pool for now; this is how Uniswap V2 keeps swaps cheap.
2. **A liquidity event: the fee is handed to the FeeBurner.** When anyone adds or removes liquidity in that pool, the pool works out the fee earned since the last such event and mints it to the FeeBurner as pool shares (Uniswap V2 `_mintFee`). Adding or removing liquidity, a launchpad token graduating, and the keeper's own unwinding all count. The first event in a pool after the fee was switched on only sets the starting point (`kLast`).
3. **The keeper runs (every 6 hours): the burn.** It unwinds the FeeBurner's pool shares into their two tokens, swaps everything that is not $GMEC to $GMEC with the output sent straight to `0x…dEaD`, and sends any $GMEC the FeeBurner holds to `0x…dEaD`. A step waits for a later run until it is worth at least three times its gas, and each swap is sized so it moves the price by at most 3%. Code: [fee-burner-job.js](../chain/scripts/fee-burner-job.js).

## Example

| Time | What happens | Burn status |
|---|---|---|
| Monday 10:00 | People swap $1,000 in total on the GME / $GMEC pool | 0.05% = $0.50 builds up in the pool |
| Monday 14:00 | Someone adds liquidity to that pool | The $0.50 now belongs to the FeeBurner |
| Monday 17:45 | The keeper runs | Swapped to $GMEC and sent to `0x…dEaD` |

## Check it yourself

| | |
|---|---|
| FeeBurner | _(at deployment)_ ([source](../chain/contracts/FeeBurner.sol), bytecode checked in CI) |
| Total burned | `totalBurned()` on the FeeBurner |
| Each burn | a $GMEC transfer to `0x…dEaD`, with a `SwappedAndBurned` or `Burned` event |
| Fee switch | `feeTo()` on the exchange factory _(at deployment)_ returns the FeeBurner |

## What can and cannot change

- The FeeBurner can only burn. Nothing can be taken out of it: $GMEC can only go to `0x…dEaD`, and other tokens can only be swapped to $GMEC sent to `0x…dEaD`.
- Its operator (the keeper, _(at deployment)_) can only choose when and along which route to swap. The owner (the deployer) can only change the operator.
- The deployer is the exchange factory's `feeToSetter`: it can point the fee elsewhere or turn it off. It cannot change the 0.3% fee or touch liquidity in any pool.
