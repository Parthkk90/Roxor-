import { useState } from "react";

import { MarketSelector } from "../market/MarketSelector";
import { useTradePair } from "../../trade/useTrade";
import { useStrategy } from "../../strategy/useStrategy";
import { StrategyMonitor } from "./StrategyMonitor";
import { StrategyBuilder } from "./StrategyBuilder";
import { NETWORK_LABEL } from "../../config/contracts";

/**
 * The maker's screen: what the deployed strategy is doing right now, and how to register a new one.
 *
 * Deliberately split in two. The monitor is the authority - every figure on it is read back from
 * the registry, the engine and the market-state provider, including the strategy's thresholds,
 * which are decoded from the rule-program bytes the registry stores rather than from anything this
 * app remembers. The builder is the only place a number originates in the browser, and even there
 * the numbers only become a *program*; the chain decides what that program then does.
 */
export function StrategyPage() {
  const pair = useTradePair();
  const { strategy, isLoading } = useStrategy(pair.market);
  const [builderOpen, setBuilderOpen] = useState(false);



  return (
    <main className="page">
      <header className="page-head">
        <div>
          <h1>Conditional strategy</h1>
          <p className="dim">
            The rules this market&apos;s Aqua maker committed to on-chain, and the state they are in
            right now. <span className="badge">{NETWORK_LABEL}</span>
          </p>
        </div>
        <MarketSelector />
      </header>

      {isLoading && !strategy && <div className="skeleton" style={{ height: 320, borderRadius: "var(--r-lg)" }} />}

      {!isLoading && !strategy && (
        <p className="dim">
          This market&apos;s strategy could not be read from chain. Nothing is shown rather than a
          placeholder, because a plausible number here would be indistinguishable from a real one.
        </p>
      )}

      {strategy && <StrategyMonitor strategy={strategy} token={pair.tokenIn} />}

      <section className="dsec" style={{ marginTop: "var(--s6)" }}>
        <button className="btn btn-primary" onClick={() => setBuilderOpen(true)}>
          Configure a strategy
        </button>
        <p className="faint" style={{ fontSize: "var(--fs-xs)", lineHeight: 1.55, marginTop: "var(--s2)" }}>
          Registers a new strategy of your own against this pair, compiled from your parameters into
          the same rule-program bytecode the engine already runs. It does not change the strategy
          above - a registered strategy is immutable by design.
        </p>
      </section>

      <StrategyBuilder open={builderOpen} onClose={() => setBuilderOpen(false)} market={pair.market} />
    </main>
  );
}
