# Security policy

## Reporting a vulnerability

Please do not open a public issue for anything that could put funds at risk.

Report privately through GitHub: **Security → Report a vulnerability** on this repository (private advisory).

Include what is affected (contract address, page or script), how to reproduce it, and the impact you expect. We will acknowledge the report, keep you informed, and credit you once it is fixed, unless you prefer to stay anonymous.

## Scope

- Contracts in [`chain/contracts`](chain/contracts) and their deployments listed in [docs/contracts.md](docs/contracts.md)
- The website and apps at [gmechain.xyz](https://gmechain.xyz) (bridge, swap, explorer)
- Deployment and operator scripts in [`chain/scripts`](chain/scripts)

Out of scope: the Arbitrum Nitro software and contracts (report to Offchain Labs), Uniswap V2 bytecode, the GME Stock Token (issued by Robinhood), and third-party wallets.

## How the code is checked

- Every push runs the [CI workflow](.github/workflows/ci.yml): Foundry unit and fuzz tests for the contracts, syntax checks for every script, and a check that no keys or node configs are committed.
- Mainnet deployment scripts refuse to run until a full rehearsal on a fork of the live chain has passed, and they ask the operator to type a confirmation before sending anything.
- Operator keys and node configuration are never committed.

The contracts have not had an external audit yet.
