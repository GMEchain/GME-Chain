# Contract addresses

Check addresses against this page or [gmechain.xyz](https://gmechain.xyz/#build) before you interact. Anyone can deploy look-alike tokens.

Mainnet contracts are deployed and verified; the mainnet apps on the website open at launch. The testnet is live now.

## Already on Robinhood Chain (4663)

GME CHAIN builds on these. Each was checked on chain on 26 November 2026.

| Contract | Address |
| --- | --- |
| GME Stock Token (gas token, issued by Robinhood) | `0x1b0E319c6A659F002271B69dB8A7df2F911c153E` |
| Robinhood stock token beacon (shared by every stock token) | `0xe10b6f6b275de231345c20d14ab812db62151b00` |
| Uniswap v3 GME/USDG 1% (deepest GME pool, price source) | `0xe9713f453adb9245b19559790c96f470a18f2fdf` |
| Uniswap v3 GME/USDG 0.05% (price cross-check) | `0xe2b46c905e12ab8e2f864e4821a4325884c1b126` |
| Uniswap v3 WETH/GME 0.05% (ETH bridge route) | `0xc6bcc95043dc48c204bb2d57fb264a10efe0a607` |
| Uniswap v3 factory | `0x1f7d7550b1b028f7571e69a784071f0205fd2efa` |
| Uniswap SwapRouter02 | `0xcaf681a66d020601342297493863e78c959e5cb2` |
| Uniswap QuoterV2 | `0x33e885ed0ec9bf04ecfb19341582aadcb4c8a9e7` |
| WETH | `0x0Bd7D308f8E1639FAb988df18A8011f41EAcAD73` |
| USDG | `0x5fc5360D0400a0Fd4f2af552ADD042D716F1d168` |
| Chainlink ETH / USD | `0x78F3556b67E17Df817D51Ef5a990cDaF09E8d3A9` |
| Arbitrum TokenBridgeCreator | `0x8B1EFf64E1eAd493A82C6798f5708183AF91A3AD` |

> **Beware of impostors.** Other tokens on Robinhood Chain also call themselves "GameStop" or "GME", for example `0xc2362aff2a2a4cc1f48cf3dab2c4e2605eb94ba3` (supply 100 billion) and `0x7e86381a763f0ecca2bdf27c54eac403ddd48123` (supply 1 billion). They are not the GME Stock Token and have nothing to do with GME CHAIN.

## Mainnet

Rollup created on Robinhood Chain at block 123,547,462 (26 November 2026).

### On Robinhood Chain (4663)

| Contract | Address |
| --- | --- |
| Rollup | `0xf154270F2c2A5E42846C77C73f56f01Eb8b02f8b` |
| Inbox (deposits) | `0x3Bf1fBA0f56eC5e5F3150bd6c54d4d85dac4cf51` |
| Bridge (GME escrow) | `0x3eC38611C8a03bFC68C39a54C00972197cAA4085` |
| Outbox (claims) | `0x2C31e5ABCB0b06F2869a3A1bBC2a1dDD83B4ac33` |
| Sequencer inbox | `0x5eF54C7bDc546E8faC8D3fcd425f91c94d583cf9` |
| Upgrade executor | `0x6bf544BD69Cab485e47449208Fa855653083fD12` |
| GmeFeeTokenPricer | `0x97dcc10f4f99dc0643540921efea2ee043502c24` |
| GmeGasRouter (bridge with ETH) | `0x150415997ad7b9a4bf724dfb552c63fe50f33ecd` |
| Token bridge router | `0xbabF154cBD39B06BeaC9d533c25eDa9b77E5FE87` |
| Token bridge standard gateway | `0x27CeAef79bC032d65d2005009C794D9F4fD7040d` |

### On GME CHAIN (12821)

| Contract | Address |
| --- | --- |
| ArbSys (withdrawals) | `0x0000000000000000000000000000000000000064` |
| NodeInterface | `0x00000000000000000000000000000000000000C8` |
| Token bridge router | `0x03e1B1ebf8428eb4176c10f604fc222A360Ada50` |
| Token bridge standard gateway | `0x3A033e2Fd4d3a17eb50Ab22709824E57aA6730e1` |
| Multicall | `0x548428916e2f312341B05C9c07CF57D6411D3b0b` |
| Wrapped GME (WGME) | `0xF47680692201c5c1615FAdc69db4A8Ad6fFA0B01` |
| Exchange factory (Uniswap V2) | `0x4eCCaB543cD16949c40bE19bbAA2542c3a0EA074` |
| Exchange router (Uniswap V2 Router02) | `0x14B24b2ef37e3C9b39D8942fDe9666281E54d8b7` |

## Testnet

GME CHAIN Testnet (12822) on Robinhood Chain Testnet (46630). Test tokens only, no value.

### On Robinhood Chain Testnet (46630)

| Contract | Address |
| --- | --- |
| tGME (test gas token, public `drip()`) | `0x65325eee8c55a7a0f8977863a4e5397490cd38c7` |
| Rollup | `0x6580C8799D2Fe611b7169cb75a8C883B38ED25Da` |
| Inbox (deposits) | `0x80FE43145A1EE63E355D93d30086B5F2eBF0F998` |
| Bridge (tGME escrow) | `0x0A259F55FF61d16D9e167CF09FecdDBA09C80CC7` |
| Outbox (claims) | `0x6e632e7E6555d015186811222bfd80993bD86d1E` |
| Sequencer inbox | `0x0AB4c01F328214B9f52D80AceaA14e4a10a05A6F` |
| GmeFeeTokenPricer | `0x070a576383feeed2f66a74dd3238b0de54609fe9` |
| Mock ETH/USD feed (testnet has no Chainlink feed) | `0x9f1b95a498ac25662353931f8e8be444909c41cd` |

### On GME CHAIN Testnet (12822)

| Contract | Address |
| --- | --- |
| Wrapped tGME | `0xe05553A07674EcDAcFC34d71851496FA8792d3D3` |
| Exchange factory (Uniswap V2) | `0xc86C5f2bcf07a95485636f252cE959b38B0E4970` |
| Exchange router (Uniswap V2 Router02) | `0xaaf27Fe96a0944e29C4919830388c1d66Ad2A9de` |
| tUSD (test dollar, public `drip()`) | `0x03626Eff4afd998Fae80556dceB98F7910eEAB36` |
| tGME/tUSD pool | `0xB0038A23057F053593fa0413a512c731A563Fc40` |

## $GMEC, the GME CHAIN token

Not launched. Its contract will be published here, and only here. Other tokens already use the ticker GMEC (for example a Coinbase tokenized GameStop stock); none of them is ours.
