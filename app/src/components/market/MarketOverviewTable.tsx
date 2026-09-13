import type { MarketAddresses } from "../../config/markets";
import { summarize } from "../../market/derive";
import { useMarketLiquidity } from "../../market/useMarkets";
import { fmt } from "../../format";

const MODE_CLASS = { NORMAL: "badge-ok", DEFENSIVE: "badge-bad", RECOVERY: "badge-warn" } as const;

/**
 * "Executable  Coverage  Risk" per market - the whole reason this is a marketplace and not a swap
 * page with a dropdown. One row per configured market, one `useMarket` read each, all from the
 * same `summarize()` every other panel uses.
 */
function MarketRow({
  market,
  symbolIn,
  symbolOut,
  active,
  onSelect,
}: {
  market: MarketAddresses;
  symbolIn: string;
  symbolOut: string;
  active: boolean;
  onSelect: () => void;
}) {
  const liquidity = useMarketLiquidity(market);
  const summary = summarize(liquidity.sources);

  return (
    <tr className={active ? "mrow-active" : undefined}>
      <td>
        <button type="button" className="btn btn-ghost" onClick={onSelect} style={{ minHeight: 0, padding: "4px 8px" }}>
          {symbolIn} / {symbolOut}
        </button>
      </td>
      <td className="num">
        {liquidity.isLoading ? "-" : `${fmt(summary.totalExecutable)} ${symbolIn}`}
      </td>
      <td className="num">
        {liquidity.isLoading || summary.marketCoverageBps === undefined
          ? "-"
          : `${(summary.marketCoverageBps / 100).toFixed(0)}%`}
      </td>
      <td>
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
  markets: Array<{ raw: MarketAddresses; tokenInSymbol: string; tokenOutSymbol: string }>;
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
            <th>Risk</th>
          </tr>
        </thead>
        <tbody>
          {markets.map((m, i) => (
            <MarketRow
              key={m.raw.label}
              market={m.raw}
              symbolIn={m.tokenInSymbol}
              symbolOut={m.tokenOutSymbol}
              active={i === activeIndex}
              onSelect={() => onSelect(i)}
            />
          ))}
        </tbody>
      </table>
    </div>
  );
}
