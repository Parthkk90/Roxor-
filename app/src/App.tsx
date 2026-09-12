import { useRoute } from "./nav/useNav";
import { Header } from "./components/layout/Header";
import { LandingPage } from "./components/landing/LandingPage";
import { SwapPage } from "./components/swap/SwapPage";
import { MarketPage } from "./components/market/MarketPage";
import { ActivityPage } from "./components/activity/ActivityPage";
import { chain } from "./config/contracts";

/**
 * Note what is NOT here: no providers.
 *
 * `TradeProvider` wraps `<App />` in `main.tsx` rather than App rendering it around these screens.
 * That is load-bearing for the re-render strategy — when trade state changes the provider
 * re-renders and returns new context elements, but the `children` element it was handed is
 * unchanged, so React skips these subtrees and re-renders only the components that actually consume
 * a context whose value changed. Moving the provider in here would rebuild `children` on every
 * keystroke and the split contexts would buy nothing.
 */
export default function App() {
  const route = useRoute();

  if (route === "home") {
    return (
      <div className="shell">
        <Header />
        <LandingPage />
      </div>
    );
  }

  return (
    <div className="shell">
      <Header />

      {route === "swap" && <SwapPage />}

      {route === "liquidity" && <MarketPage />}
      {route === "activity" && <ActivityPage />}

      <footer style={{ padding: "var(--s5)", textAlign: "center" }}>
        <span className="label">{chain.name} · demo only, not for real funds</span>
      </footer>
    </div>
  );
}
