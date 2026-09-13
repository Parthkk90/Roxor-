import { useMemo } from "react";
import { TriangleAlert } from "lucide-react";

import { useMarket } from "../../market/useMarket";
import { allocationsFor, summarize } from "../../market/derive";
import { useMarketList } from "../../market/useMarkets";
import { useRouteQuote } from "../../trade/useRouteQuote";
import { useTradeActions, useTradePair } from "../../trade/useTrade";
import { fmt, fmtBps, NO_VALUE } from "../../format";
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
        <p>
          Discover and compare liquidity that can actually settle your trade. Every figure below is
          <strong> executable</strong> depth - what a source can really deliver right now - not what it
          advertises.
        </p>
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

      {/* ---- summary ----
           Executable is the headline and is given its own full-width row: it is the only figure on
           this page a trade can be built from. Advertised appears beneath it, struck through, as a
           comparison - never beside it as a peer. A reader skimming the largest number on the
           screen must land on the honest one. */}
      <section className="mhero">
        <span className="label">Executable liquidity</span>
        <span className="mhero-big">
          {market.isLoading ? (
            <span className="skeleton" style={{ width: 180, height: 44 }}>0</span>
          ) : (
            <>
              {fmt(summary.totalExecutable, pair.tokenIn.decimals)} <em>{pair.tokenIn.symbol}</em>
            </>
          )}
        </span>
        {!market.isLoading && summary.totalAdvertised > summary.totalExecutable && (
          <span className="mhero-sub">
            <span className="lsc-advertised">
              {fmt(summary.totalAdvertised, pair.tokenIn.decimals)} {pair.tokenIn.symbol}
            </span>{" "}
            advertised - the difference cannot be settled
          </span>
        )}
      </section>

      <section className="msummary">
        <div className="msum-stat">
          <span className="label">Healthy sources</span>
          <span className="msum-big">
            {market.isLoading || summary.readableSources === 0
              ? NO_VALUE
              : `${summary.healthySources}/${summary.readableSources}`}
          </span>
          <span className="msum-sub">covering 90%+ of what they advertise</span>
        </div>

        <div className="msum-stat">
          <span className="label">Liquidity capacity</span>
          <span className="msum-big">{fmtBps(summary.liquidityCapacityBps, 0)}</span>
          <span className="msum-sub">tightest strategy limit in force</span>
        </div>

        <div className="msum-stat">
          <span className="label">Best fee</span>
          <span className="msum-big">{fmtBps(summary.bestSpreadBps)}</span>
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
            <NoPhantomLiquidity sources={market.sources} token={pair.tokenIn} />
          </header>
          <MarketDepthBar sources={market.sources} total={summary.totalExecutable} token={pair.tokenIn} />
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
                tokenIn={pair.tokenIn}
                tokenOut={pair.tokenOut}
              />
            ))}
          </div>
        )}
      </section>
    </div>
  );
}
