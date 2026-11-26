// RainbowKit wallet modal for the GME CHAIN site (bundled with esbuild into site/js/walletkit.js).
// The vanilla pages talk to it through window.gmeWallet:
//   gmeWallet.open()        connect modal, or the account modal when already connected
//   gmeWallet.provider      EIP-1193 provider of the connected wallet (null when disconnected)
//   gmeWallet.address / chainId
//   window event "gmewallet:change" fires on every connect, disconnect, account or network change
import React, { useEffect } from "react";
import { createRoot } from "react-dom/client";
import { RainbowKitProvider, darkTheme, connectorsForWallets, useConnectModal, useAccountModal } from "@rainbow-me/rainbowkit";
import { metaMaskWallet, rabbyWallet, coinbaseWallet, okxWallet, phantomWallet, trustWallet, bitgetWallet, binanceWallet, rainbowWallet, ledgerWallet, walletConnectWallet, injectedWallet } from "@rainbow-me/rainbowkit/wallets";
import { WagmiProvider, createConfig, http, useAccount } from "wagmi";
import { QueryClient, QueryClientProvider } from "@tanstack/react-query";
import { defineChain } from "viem";
import { PROFILES, ACTIVE, WALLETCONNECT_PROJECT_ID } from "../config.js";

const P = PROFILES[ACTIVE];
const l3 = defineChain({
  id: P.L3.id, name: P.L3.name,
  nativeCurrency: { name: P.TOKEN, symbol: P.TOKEN, decimals: 18 },
  rpcUrls: { default: { http: [P.L3.rpc] } },
  blockExplorers: { default: { name: "GME CHAIN Explorer", url: `${location.origin}${ACTIVE === "testnet" ? "/explorer/testnet" : "/explorer"}` } },
  testnet: ACTIVE === "testnet",
});
const l2 = defineChain({
  id: P.L2.id, name: P.L2.name,
  nativeCurrency: { name: "Ether", symbol: "ETH", decimals: 18 },
  rpcUrls: { default: { http: [P.L2.walletRpc] } },
  blockExplorers: { default: { name: "Blockscout", url: ACTIVE === "testnet" ? "https://explorer.testnet.chain.robinhood.com" : "https://robinhoodchain.blockscout.com" } },
  testnet: ACTIVE === "testnet",
});

// Wallets that connect over WalletConnect (QR codes, mobile apps) need the Reown project id (cloud.reown.com, with this
// site's domain on the project's allow list so wallets show it as verified). Without it only browser wallets are offered.
const hasWC = typeof WALLETCONNECT_PROJECT_ID === "string" && WALLETCONNECT_PROJECT_ID.length >= 32;
const projectId = hasWC ? WALLETCONNECT_PROJECT_ID : "00000000000000000000000000000000";
const groups = hasWC
  ? [
      { groupName: "Popular", wallets: [metaMaskWallet, rabbyWallet, coinbaseWallet, okxWallet, phantomWallet, trustWallet] },
      { groupName: "More wallets", wallets: [bitgetWallet, binanceWallet, rainbowWallet, ledgerWallet, walletConnectWallet, injectedWallet] },
    ]
  : [{ groupName: "Browser wallets", wallets: [injectedWallet, metaMaskWallet, rabbyWallet, coinbaseWallet] }];
const connectors = connectorsForWallets(groups, {
  appName: "GME CHAIN", projectId,
  appDescription: "GME CHAIN: bridge ETH from Robinhood Chain and pay every fee in GME.",
  appUrl: location.origin, appIcon: `${location.origin}/icon.png`,
});

const config = createConfig({
  connectors,
  chains: [l2, l3],
  transports: { [l2.id]: http(P.L2.rpcs[0]), [l3.id]: http(P.L3.rpc) },
  ssr: false,
});
const queryClient = new QueryClient();

const api = { provider: null, address: null, chainId: null, open: () => {} };
window.gmeWallet = api;

function Bridge() {
  const { address, chainId, connector, status } = useAccount();
  const { openConnectModal } = useConnectModal();
  const { openAccountModal } = useAccountModal();
  useEffect(() => {
    api.open = () => (address ? openAccountModal?.() : openConnectModal?.());
  }, [address, openConnectModal, openAccountModal]);
  useEffect(() => {
    let alive = true;
    (async () => {
      const provider = address && connector ? await connector.getProvider().catch(() => null) : null;
      if (!alive) return;
      api.provider = provider; api.address = address || null; api.chainId = chainId || null; api.status = status;
      window.dispatchEvent(new CustomEvent("gmewallet:change", { detail: { address: api.address, chainId: api.chainId, status } }));
    })().catch((e) => console.warn(e));
    return () => { alive = false; };
  }, [address, chainId, connector, status]);
  return null;
}

const theme = darkTheme({ accentColor: "#35d3ff", accentColorForeground: "#0a0a0a", borderRadius: "medium", overlayBlur: "small", fontStack: "system" });
theme.colors.modalBackground = "#111111";
theme.colors.modalBorder = "rgba(255,255,255,.1)";
theme.fonts.body = "Geist, 'Segoe UI', system-ui, sans-serif";

const mount = document.createElement("div");
mount.id = "gmewallet-root";
document.body.appendChild(mount);
createRoot(mount).render(
  <WagmiProvider config={config}>
    <QueryClientProvider client={queryClient}>
      <RainbowKitProvider theme={theme} initialChain={l2} modalSize="compact" appInfo={{ appName: "GME CHAIN", learnMoreUrl: `${location.origin}/docs/` }}>
        <Bridge />
      </RainbowKitProvider>
    </QueryClientProvider>
  </WagmiProvider>,
);
window.dispatchEvent(new Event("gmewallet:ready"));

// viem for the vanilla pages, so they do not fetch a second copy from a CDN
export * as viem from "viem";
