import { StrictMode } from "react";
import { createRoot } from "react-dom/client";
import { PrivyProvider } from "@privy-io/react-auth";
import { WagmiProvider } from "@privy-io/wagmi";
import { QueryClient, QueryClientProvider } from "@tanstack/react-query";
import App from "./App.tsx";
import { ObservedBlockProvider } from "./chain/ObservedBlockContext";
import { TradeProvider } from "./trade/TradeContext";
import { wagmiConfig } from "./config/wagmi";
import { chain } from "./config/contracts";
import "./index.css";

const privyAppId = import.meta.env.VITE_PRIVY_APP_ID;

const queryClient = new QueryClient({
  defaultOptions: {
    queries: {
      // Every chain read in this app is keyed on the observed block and refetched by advancing it,
      // never by a timer. Defaults that refetch on their own schedule would reintroduce exactly the
      // cross-block incoherence the clock exists to remove.
      refetchOnWindowFocus: false,
      retry: 1,
    },
  },
});

if (!privyAppId) {
  // Fails loudly instead of silently rendering a broken connect button.
  console.error(
    "VITE_PRIVY_APP_ID is not set. Create an app at https://dashboard.privy.io and put its App ID in app/.env.local"
  );
}

createRoot(document.getElementById("root")!).render(
  <StrictMode>
    <PrivyProvider
      appId={privyAppId ?? ""}
      config={{
        // Privy's own modal must match the app, not fight it.
        appearance: { theme: "dark", accentColor: "#ff4d5a", walletChainType: "ethereum-only" },
        defaultChain: chain,
        supportedChains: [chain],
        embeddedWallets: { ethereum: { createOnLogin: "users-without-wallets" } },
      }}
    >
      <QueryClientProvider client={queryClient}>
        <WagmiProvider config={wagmiConfig}>
          {/* ObservedBlockProvider must sit inside WagmiProvider — it calls `useBlockNumber`, and it
              is the app's only poll. TradeProvider sits inside it because the trade's query keys are
              built from the block. `<App />` is passed as `children` so provider re-renders do not
              rebuild it; see the note in App.tsx. */}
          <ObservedBlockProvider>
            <TradeProvider>
              <App />
            </TradeProvider>
          </ObservedBlockProvider>
        </WagmiProvider>
      </QueryClientProvider>
    </PrivyProvider>
  </StrictMode>
);
