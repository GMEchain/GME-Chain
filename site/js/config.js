// GME CHAIN public configuration. Addresses only, never keys.
//
// Two profiles; ACTIVE picks the one the apps use. Every address below marked `null` is filled in from
// chain/deployment.<network>.json after that contract is deployed. Until a network's inbox is set, that
// network counts as not launched (LIVE = false) and the app pages show a pre-launch panel instead.
//
// Addresses that already exist on Robinhood Chain (4663), each checked on-chain on 2026-11-26:
//   GME Stock Token  0x1b0E…153E  name "GameStop • Robinhood Token", symbol GME, 18 decimals; same Robinhood
//                    beacon proxy (0xe10b…1b00) and the same bytecode as every Robinhood stock token.
//   Uniswap v3       SwapRouter02, QuoterV2, factory and WETH from Uniswap's Robinhood Chain deployment list;
//                    SwapRouter02.factory() is the factory of every GME pool below.
const PROFILES = {
  testnet: {
    NETWORK: "testnet",
    TOKEN: "tGME",
    L3: { id: 12822, hex: "0x3216", name: "GME CHAIN Testnet", rpc: "https://rpc.testnet.gmechain.xyz" },
    L2: { id: 46630, hex: "0xb626", name: "Robinhood Chain Testnet", rpcs: ["https://gmechain.xyz/rpc/rh-testnet", "https://rpc.testnet.chain.robinhood.com"], walletRpc: "https://gmechain.xyz/rpc/rh-testnet" },
    ADDR: {
      gme: "0x65325eee8c55a7a0f8977863a4e5397490cd38c7", // tGME, valueless test token with a public faucet (scripts/01-deploy-tgme.js)
      inbox: "0x80FE43145A1EE63E355D93d30086B5F2eBF0F998",
      bridge: "0x0A259F55FF61d16D9e167CF09FecdDBA09C80CC7",
      outbox: "0x6e632e7E6555d015186811222bfd80993bD86d1E",
      rollup: "0x6580C8799D2Fe611b7169cb75a8C883B38ED25Da",
      sequencerInbox: "0x0AB4c01F328214B9f52D80AceaA14e4a10a05A6F",
      pricer: "0x070a576383feeed2f66a74dd3238b0de54609fe9",
      validator: "0x6C4c14b65a0DDC01047541A983D94c5E687C77e6",
      gasRouter: null, // the ETH bridge uses real Uniswap pools, so it exists on mainnet only
      arbSys: "0x0000000000000000000000000000000000000064",
      nodeInterface: "0x00000000000000000000000000000000000000C8",
    },
    DEX: { wrappedGme: "0xe05553A07674EcDAcFC34d71851496FA8792d3D3", factory: "0xc86C5f2bcf07a95485636f252cE959b38B0E4970", router: "0xaaf27Fe96a0944e29C4919830388c1d66Ad2A9de", testUsd: "0x03626Eff4afd998Fae80556dceB98F7910eEAB36" },
    CONFIRM_BLOCKS: 150, // ~30 minutes of 12 s Ethereum blocks
    LAUNCHPAD: { address: null, quote: null, quoteSymbol: "tGME", fromBlock: 0 }, // mainnet only for now
  },
  mainnet: {
    NETWORK: "mainnet",
    TOKEN: "GME",
    L3: { id: 12821, hex: "0x3215", name: "GME CHAIN", rpc: "https://rpc.gmechain.xyz" },
    L2: { id: 4663, hex: "0x1237", name: "Robinhood Chain", rpcs: ["https://robinhood.drpc.org", "https://rpc.mainnet.chain.robinhood.com"], walletRpc: "https://rpc.mainnet.chain.robinhood.com" },
    ADDR: {
      gme: "0x1b0E319c6A659F002271B69dB8A7df2F911c153E", // GameStop • Robinhood Token (the gas token)
      inbox: "0x3Bf1fBA0f56eC5e5F3150bd6c54d4d85dac4cf51",
      bridge: "0x3eC38611C8a03bFC68C39a54C00972197cAA4085",
      outbox: "0x2C31e5ABCB0b06F2869a3A1bBC2a1dDD83B4ac33",
      rollup: "0xf154270F2c2A5E42846C77C73f56f01Eb8b02f8b",
      sequencerInbox: "0x5eF54C7bDc546E8faC8D3fcd425f91c94d583cf9",
      pricer: "0x97dcc10f4f99dc0643540921efea2ee043502c24",
      validator: "0x96013907aF557E9F1692801DC7474cF8E7a63127",
      gasRouter: "0x150415997ad7b9a4bf724dfb552c63fe50f33ecd", // GmeGasRouter: ETH in -> GME gas on GME CHAIN; GME -> ETH after a withdrawal
      arbSys: "0x0000000000000000000000000000000000000064",
      nodeInterface: "0x00000000000000000000000000000000000000C8",
    },
    // usdg: Global Dollar bridged from Robinhood Chain through the canonical token bridge (address fixed by the gateway).
    // The GME/USDG pool opened on 2026-11-27.
    DEX: { wrappedGme: "0xF47680692201c5c1615FAdc69db4A8Ad6fFA0B01", factory: "0x4eCCaB543cD16949c40bE19bbAA2542c3a0EA074", router: "0x14B24b2ef37e3C9b39D8942fDe9666281E54d8b7", testUsd: null, usdg: "0x70B8053E45C6273f573a788299EF667677F4C9e5", usdgPair: "0x0cc257A03a13d4B01c0Ec573aD2Fc755b9F1B85f" },
    CONFIRM_BLOCKS: 7200, // about one day of 12 s Ethereum blocks (set on chain 2026-11-27; was 50400)
    // launchpad: every trade in GME (quote = the exchange's WGME); address filled in by scripts/08-launchpad.js
    LAUNCHPAD: { address: "0xB7C9B7dE689738218CF20379646fB54c251a5053", quote: "0xF47680692201c5c1615FAdc69db4A8Ad6fFA0B01", quoteSymbol: "GME", fromBlock: 31 },
  },
};

// Uniswap v3 on Robinhood Chain: used by the ETH bridge (quotes and swaps) and the live GME price.
export const UNISWAP = {
  swapRouter02: "0xcaf681a66d020601342297493863e78c959e5cb2",
  quoterV2: "0x33e885ed0ec9bf04ecfb19341582aadcb4c8a9e7",
  weth: "0x0Bd7D308f8E1639FAb988df18A8011f41EAcAD73",
  usdg: "0x5fc5360D0400a0Fd4f2af552ADD042D716F1d168",
  // routes tried for ETH <-> GME; the bridge quotes each and uses the best
  routes: [
    { name: "WETH/GME 0.05%", hops: [500] },
    { name: "WETH/USDG 0.05% → GME/USDG 1%", hops: [500, 10000], via: "usdg" },
  ],
  pools: {
    gmeUsdg1: "0xe9713f453adb9245b19559790c96f470a18f2fdf", // deepest GME pool (~$370k), token0 GME, token1 USDG
    gmeUsdg005: "0xe2b46c905e12ab8e2f864e4821a4325884c1b126",
    wethGme005: "0xc6bcc95043dc48c204bb2d57fb264a10efe0a607", // token0 WETH, token1 GME
  },
};

export { PROFILES };
// MAINNET SWITCH. false = before launch: the whole site runs on GME CHAIN Testnet and mainnet stays hidden, even though
// its addresses above are filled in. Set to true on launch day; mainnet becomes the default and ?net=testnet stays.
export const MAINNET_OPEN = true;
// Which network the apps use. Mainnet by default once open; ?net=testnet switches.
function pickNetwork() {
  if (!MAINNET_OPEN) return "testnet"; // before launch the site runs on testnet
  // the explorer's network is in its URL: /explorer/... is mainnet, /explorer/testnet/... is testnet
  if (typeof location !== "undefined" && /^\/explorer(\/|$)/.test(location.pathname)) return /^\/explorer\/testnet(\/|$)/.test(location.pathname) ? "testnet" : "mainnet";
  // Mainnet unless the URL says ?net=testnet. The choice is not remembered between visits, so nobody lands on
  // testnet by accident; links inside testnet pages carry ?net=testnet along (netui.js).
  try { localStorage.removeItem("gmechain.net"); } catch { /* storage blocked */ }
  const q = typeof location !== "undefined" ? new URLSearchParams(location.search).get("net") : null;
  return q === "testnet" ? "testnet" : "mainnet";
}
export const ACTIVE = pickNetwork();

const P = PROFILES[ACTIVE];
export const NETWORK = P.NETWORK;
export const TOKEN = P.TOKEN;
export const L3 = P.L3;
export const L2 = P.L2;
export const ADDR = P.ADDR;
export const DEX = P.DEX;
export const CONFIRM_BLOCKS = P.CONFIRM_BLOCKS;
export const LAUNCHPAD = P.LAUNCHPAD;
// $GMEC staking contract on Robinhood Chain mainnet. Filled in by scripts/07-gmec-staking.js.
const STAKING_CONTRACT = "0x9f29714405422ba1f962c1fff678c6f3ac076a8b";
// Launch state, per app. A page whose app is not live shows the pre-launch panel (js/prelaunch.js).
const OPEN = ACTIVE !== "mainnet" || MAINNET_OPEN;
export const LIVE = {
  chain: OPEN && !!(ADDR.inbox && ADDR.outbox && ADDR.bridge),
  bridge: OPEN && !!(ADDR.inbox && ADDR.outbox && ADDR.bridge),
  swap: OPEN && !!(ADDR.inbox && DEX.router && DEX.factory && DEX.wrappedGme),
  explorer: OPEN && !!(ADDR.inbox && DEX.router && DEX.factory && DEX.wrappedGme),
  launch: OPEN && !!(ADDR.inbox && LAUNCHPAD.address),
  stake: !!(STAKING_CONTRACT),
};
// $GMEC staking for gas credits, on Robinhood Chain mainnet (contract: STAKING_CONTRACT above).
export const STAKING = {
  chain: { id: 4663, hex: "0x1237", name: "Robinhood Chain", rpcs: PROFILES.mainnet.L2.rpcs, walletRpc: PROFILES.mainnet.L2.walletRpc },
  contract: STAKING_CONTRACT,
  token: "0xa8c53b1dAcFbd07895dC8D2c638F1bFDe10C0122", // $GMEC
  symbol: "$GMEC",
  test: false,
  buyUrl: "https://fomo.family/tokens/robinhood/0xa8c53b1dacfbd07895dc8d2c638f1bfde10c0122?r=NeatTightBass",
};

// Where the site reads the live GME price: the Uniswap v3 GME/USDG pool on Robinhood Chain (the same pool the
// keeper uses), and once GME CHAIN mainnet exists, its fee pricer as a fallback. Read-only.
export const PRICE_SOURCE = { pool: UNISWAP.pools.gmeUsdg1, pricer: PROFILES.mainnet.ADDR.pricer, rpcs: PROFILES.mainnet.L2.rpcs };

// $GMEC, the GME CHAIN token on Robinhood Chain. null until launch; once set, the footer, the FAQ and the docs
// show this contract (js/site.js). This is the only place the official address lives.
export const GMEC = {
  address: "0xa8c53b1dAcFbd07895dC8D2c638F1bFDe10C0122", chainId: 4663, explorer: "https://robinhoodchain.blockscout.com/token/",
  // where to trade it (shown next to the contract in the footer, the FAQ and the docs)
  links: [
    { name: "FOMO", url: "https://fomo.family/tokens/robinhood/0xa8c53b1dacfbd07895dc8d2c638f1bfde10c0122?r=NeatTightBass" },
    { name: "Pons", url: "https://ponsfamily.com/launchpad/0xa8c53b1dacfbd07895dc8d2c638f1bfde10c0122" },
  ],
};

// WalletConnect Cloud project id (cloud.reown.com), allow-listed for gmechain.xyz. Empty = browser wallets only.
export const WALLETCONNECT_PROJECT_ID = "ea1a8f037bfb827e204cc89e6ef534dd";
