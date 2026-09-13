import { useMemo } from "react";

import { useMarket } from "../../market/useMarket";
import { allocationsFor, summarize } from "../../market/derive";
import { useRegimeChange } from "../../market/useRegimeChange";
import { useRouteChange } from "../../market/useRouteChange";
import { useStrategy } from "../../strategy/useStrategy";
import { useRouteQuote } from "../../trade/useRouteQuote";
import { useTradePair } from "../../trade/useTrade";
import { DemoPanel } from "../demo/DemoPanel";
import { LiquidityDiscovery } from "./LiquidityDiscovery";
import { SwapCard } from "./SwapCard";

/**
 * The trade screen: the order on the left, the liquidity it is being assembled from on the right.
 *
 * Two columns on desktop because the two halves answer different questions and a trader reads them
 * together - "what am I trading" and "where can it actually execute". On mobile they stack in that
 * same order, so the narrative survives the loss of the second column.
 *
 * `useRouteQuote`, `useMarket` and `useStrategy` are each called here and again inside child
 * components. That is not duplicated work: every one resolves to the same react-query key, so it is
 * one cached read each. Doing it this way rather than threading props means the card, the discovery
 * column and the strategy panel physically cannot be looking at different blocks.
 */
export function SwapPage() {
  const pair = useTradePair();
  const market = useMarket(pair.tokenIn.address, pair.tokenOut.address, pair.market.aquaVenue, pair.market.uniswapV4Venue);
  const quote = useRouteQuote();
  const { strategy } = useStrategy(pair.market);

  const allocations = useMemo(
    () => allocationsFor(market.sources, quote.plan),
    [market.sources, quote.plan]
  );
  const summary = useMemo(() => summarize(market.sources), [market.sources]);
  const change = useRouteChange(allocations, quote.amountWei);
  const regime = useRegimeChange(summary);

  return (
    <div className="page trade-page">
      <div className="trade-grid">
        <div className="trade-left">
          <SwapCard />
          <DemoPanel />
        </div>

        <div className="trade-right">
          <LiquidityDiscovery
            status={quote.status}
            result={quote.result}
            allocations={allocations}
            summary={summary}
            change={change}
            regimeChange={regime.change}
            onDismissRegimeChange={regime.dismiss}
            volatilityBps={strategy?.market?.volatilityBps}
            amountWei={quote.amountWei}
            expectedOut={quote.plan?.totalExpectedAmountOut}
            tokenIn={pair.tokenIn}
            tokenOut={pair.tokenOut}
            isStale={quote.isStale}
            marketError={market.isError}
          />
        </div>
      </div>
    </div>
  );
}
