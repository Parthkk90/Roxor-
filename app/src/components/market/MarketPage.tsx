import { useMemo } from "react";
import { TriangleAlert } from "lucide-react";

import { useMarket } from "../../market/useMarket";
import { allocationsFor, summarize } from "../../market/derive";
import { useMarketList } from "../../market/useMarkets";
import { useRouteQuote } from "../../trade/useRouteQuote";
import { useTradeActions, useTradePair } from "../../trade/useTrade";
import { fmt } from "../../format";
import { CoverageIndicator } from "../liquidity/CoverageIndicator";
import { MarketDepthBar } from "../liquidity/DepthChart";
import { LiquiditySourceCard } from "../liquidity/LiquiditySourceCard";
import { NoPhantomLiquidity } from "../liquidity/NoPhantomLiquidity";
import { MarketSelector } from "./MarketSelector";
import { MarketOverviewTable } from "./MarketOverviewTable";

/**
 * The marketplace.
 *
 * Renders the same normalized `LiquiditySource[]` and the same `allocationsFor` output the swap
 * screen uses, from the same cached query. There is deliberately no second representation of venue
 * state anywhere in the app - that duplication is what let the old build show a route computed at
 * one block beside depth summed at another.
 */
export function MarketPage() {
  const pair = useTradePair();
  const { selectMarket } = useTradeActions();
  const marketList = useMarketList();
  const market = useMarket(pair.tokenIn.address, pair.tokenOut.address, pair.market.aquaVenue, pair.market.uniswapV4Venue);
  const quote = useRouteQuote();

  const summary = useMemo(() => summarize(market.sources), [market.sources]);
  const allocations = useMemo(
    () => allocationsFor(market.sources, quote.plan),
    [market.sources, quote.plan]
  );

  return (
    <div className="page">
      <div className="page-head">
        <h1>Liquidity marketplace</h1>
        <p>Discover and compare liquidity that can actually settle your trade.</p>
      </div>

      <MarketSelector />

      <section className="msec">
        <span className="label">Compare markets</span>
        <MarketOverviewTable markets={marketList} activeIndex={pair.marketIndex} onSelect={selectMarket} />
      </section>

      {market.isError && (
        <div className="notice notice-bad" style={{ marginBottom: "var(--s5)" }}>
          <TriangleAlert size={16} aria-hidden="true" />
          <div>
            <strong>Liquidity data unavailable</strong>
            <p>Unable to verify current on-chain liquidity. These figures aren&apos;t live.</p>
          </div>
        </div>
      )}

      {/* ---- summary: every figure computed from what actually loaded ---- */}
      <section className="msummary">
        <div className="msum-stat">
          <span className="label">Total executable</span>
          <span className="msum-big">
            {market.isLoading ? (
              <span className="skeleton" style={{ width: 110, height: 30 }}>0</span>
            ) : (
              <>
                {fmt(summary.totalExecutable)} <em>{pair.tokenIn.symbol}</em>
              </>
            )}
          </span>
          {!market.isLoading && summary.totalAdvertised > summary.totalExecutable && (
            <span className="msum-sub">
              of <span className="lsc-advertised">{fmt(summary.totalAdvertised)}</span> advertised
            </span>
          )}
        </div>

        <div className="msum-stat">
          <span className="label">Healthy sources</span>
          <span className="msum-big">
            {market.isLoading || summary.readableSources === 0
              ? "-"
              : `${summary.healthySources}/${summary.readableSources}`}
          </span>
          <span className="msum-sub">covering ≥90% of what they advertise</span>
        </div>

        <div className="msum-stat">
          <span className="label">Best fee</span>
          <span className="msum-big">
            {summary.bestSpreadBps === undefined ? "-" : `${(summary.bestSpreadBps / 100).toFixed(2)}%`}
          </span>
          <span className="msum-sub">{summary.bestPricedSource?.name ?? "no source can fill right now"}</span>
        </div>

        <div className="msum-stat msum-cov">
          <span className="label">Market coverage</span>
          <CoverageIndicator bps={summary.marketCoverageBps} size="lg" />
        </div>
      </section>

      {!market.isLoading && summary.totalExecutable > 0n && (
        <section className="msec">
          <header className="disco-head">
            <span className="label">Executable depth by source</span>
            <NoPhantomLiquidity sources={market.sources} symbol={pair.tokenIn.symbol} />
          </header>
          <MarketDepthBar
            sources={market.sources}
            total={summary.totalExecutable}
            symbol={pair.tokenIn.symbol}
          />
        </section>
      )}

      <section className="msec">
        <span className="label">Sources</span>
        {market.isLoading ? (
          <div className="disco-sources">
            {[0, 1].map((i) => (
              <div className="lsc" key={i}>
                <span className="skeleton" style={{ height: 20, width: "50%" }} />
                <span className="skeleton" style={{ height: 38, width: "70%" }} />
                <span className="skeleton" style={{ height: 48 }} />
              </div>
            ))}
          </div>
        ) : (
          <div className="disco-sources">
            {allocations.map((a) => (
              <LiquiditySourceCard
                key={a.source.key}
                allocation={a}
                symbolIn={pair.tokenIn.symbol}
                symbolOut={pair.tokenOut.symbol}
              />
            ))}
          </div>
        )}
      </section>
    </div>
  );
}
