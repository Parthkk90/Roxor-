import { summarize } from "../../market/derive";
import { useMarketLiquidity, type Market } from "../../market/useMarkets";
import { fmt, fmtBps, NO_VALUE } from "../../format";

const MODE_CLASS = { NORMAL: "badge-ok", DEFENSIVE: "badge-bad", RECOVERY: "badge-warn" } as const;

/**
 * One row per configured market: what can actually be traded there, how much of the advertised
 * figure that is, which source is currently cheapest, and what risk state the market is in.
 *
 * Every column is derived from the same `summarize()` every other panel uses, on the same cached
 * read - so a market cannot appear healthier here than it does on its own page. "Best source" and
 * "Best fee" come from `bestPricedSource`/`bestSpreadBps`, which deliberately only consider sources
 * that can fill something: the tightest spread on a source with nothing to sell is not a price.
 *
 * Renders as a table on desktop and as cards on narrow screens, driven by CSS alone - the same DOM
 * either way, so there is no second markup path to keep in sync.
 */
function MarketRow({
  market,
  active,
  onSelect,
}: {
  market: Market;
  active: boolean;
  onSelect: () => void;
}) {
  const liquidity = useMarketLiquidity(market.raw);
  const summary = summarize(liquidity.sources);

  return (
    <tr className={active ? "mrow-active" : undefined}>
      <td data-th="Market">
        <button type="button" className="btn btn-ghost mrow-pick" onClick={onSelect}>
          {market.tokenInSymbol} / {market.tokenOutSymbol}
        </button>
      </td>
      <td data-th="Executable" className="num mrow-lead">
        {liquidity.isLoading
          ? NO_VALUE
          : `${fmt(summary.totalExecutable, market.tokenInDecimals)} ${market.tokenInSymbol}`}
      </td>
      <td data-th="Coverage" className="num">
        {liquidity.isLoading ? NO_VALUE : fmtBps(summary.marketCoverageBps, 0)}
      </td>
      <td data-th="Best source">
        {summary.bestPricedSource?.name ?? NO_VALUE}
      </td>
      <td data-th="Best fee" className="num">
        {fmtBps(summary.bestSpreadBps)}
      </td>
      <td data-th="Risk">
        <span className={`badge ${MODE_CLASS[summary.regime]}`}>
          <span className="dot" />
          {summary.regime.charAt(0) + summary.regime.slice(1).toLowerCase()}
        </span>
      </td>
    </tr>
  );
}

export function MarketOverviewTable({
  markets,
  activeIndex,
  onSelect,
}: {
  markets: Market[];
  activeIndex: number;
  onSelect: (index: number) => void;
}) {
  return (
    <div className="mtable-wrap">
      <table className="mtable">
        <thead>
          <tr>
            <th>Market</th>
            <th>Executable</th>
            <th>Coverage</th>
            <th>Best source</th>
            <th>Best fee</th>
            <th>Risk</th>
          </tr>
        </thead>
        <tbody>
          {markets.map((m, i) => (
            <MarketRow key={m.label} market={m} active={i === activeIndex} onSelect={() => onSelect(i)} />
          ))}
        </tbody>
      </table>
    </div>
  );
}
