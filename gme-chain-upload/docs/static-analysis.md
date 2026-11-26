# Static analysis

Every push runs [Slither](https://github.com/crytic/slither) 0.11.6 on `chain/contracts` in [CI](../.github/workflows/ci.yml). The job fails on any High finding, and all findings are published in the repository's **Security → Code scanning** tab. The complete report of every run is on that run's Summary page.

Run it yourself:

```bash
cd chain && npm ci && forge build
pipx install slither-analyzer==0.11.6
slither . --config-file slither.config.json
```

## Expected findings and why they are fine

| Finding | Where | Verdict |
|---|---|---|
| `return-bomb`, `low-level-calls` | `GmeFeeTokenPricer._refreshEth` | **Intended.** A gas-capped `staticcall` to the Chainlink ETH/USD feed, whose address is immutable. The cap is there so a broken feed cannot make fee pricing revert; the pricer then keeps its last good price. |
| `missing-zero-check` | `GmeFeeTokenPricer.setKeeper` and constructor | **Intended.** Setting the keeper to `address(0)` is how keeper updates are switched off. |
| `timestamp` | freshness checks in `GmeFeeTokenPricer`, test-token faucets | **By design.** Windows are minutes to days; a sequencer can shift `block.timestamp` by seconds at most. |
| `low-level-calls` | `WrappedGME.withdraw`, `GmeGasRouter.swapGmeToEth` | **Standard pattern.** The balance is settled before the native transfer, and a failed transfer reverts. `GmeGasRouter` only accepts ETH from WETH (`receive`), so nothing can be stranded. |
| `arbitrary-send-eth` | `GmeGasRouter.swapGmeToEth` | **Intended.** It sends the ETH from the caller's own swap to the receiver the caller names, in the same call. The router holds no funds between transactions. |
| `naming-convention`, `unindexed-event-address` | various | Style only. |

## What is not covered here

Static analysis is not an audit. The contracts are also covered by unit, fuzz and fork tests (`forge test`); an external audit is on the [roadmap](roadmap.md).
