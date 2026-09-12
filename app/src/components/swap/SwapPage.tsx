import { useMemo } from "react";

import { useMarket } from "../../market/useMarket";
import { allocationsFor, summarize } from "../../market/derive";
import { useRouteChange } from "../../market/useRouteChange";
import { useRouteQuote } from "../../trade/useRouteQuote";
import { useTradePair } from "../../trade/useTrade";
import { DemoPanel } from "../demo/DemoPanel";
import { LiquidityDiscovery } from "./LiquidityDiscovery";
import { SwapCard } from "./SwapCard";

/**
 * The trade screen: the order on the left, the liquidity it is being assembled from on the right.
 *
 * Two columns on desktop because the two halves answer different questions and a trader reads them
 * together — "what am I trading" and "where can it actually execute". On mobile they stack in that
 * same order, so the narrative survives the loss of the second column.
 *
 * `useRouteQuote` and `useMarket` are both called here and again inside `SwapCard`. That is not
 * duplicated work: both resolve to the same react-query keys, so it is one cached read each. Doing
 * it this way rather than threading props through means the card and the discovery column
 * physically cannot be looking at different blocks.
 */
export function SwapPage() {
  const pair = useTradePair();
  const market = useMarket(pair.tokenIn.address, pair.tokenOut.address);
  const quote = useRouteQuote();

  const allocations = useMemo(
    () => allocationsFor(market.sources, quote.plan),
    [market.sources, quote.plan]
  );
  const summary = useMemo(() => summarize(market.sources), [market.sources]);
  const change = useRouteChange(allocations, quote.amountWei);

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
