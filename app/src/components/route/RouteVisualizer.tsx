import { memo } from "react";

import type { SourceAllocation } from "../../market/derive";
import { fmt } from "../../format";

const SEG = ["var(--accent)", "var(--info)", "var(--ok)"];

/**
 * The order being assembled from available liquidity.
 *
 * Order → solver → sources → output, drawn top to bottom. The layout is doing real work: it shows
 * that the trade is *composed*, which a "60% / 40%" text line does not. When the market moves and
 * the split changes, the bars animate to their new widths, so a shift from Aqua to Uniswap is
 * something you watch happen rather than something you notice by re-reading two numbers.
 *
 * Memoised, since it redraws only when the plan actually changes - never while the amount field is
 * being typed into.
 */
export const RouteVisualizer = memo(function RouteVisualizer({
  allocations,
  amountIn,
  expectedOut,
  symbolIn,
  symbolOut,
  isStale,
}: {
  allocations: SourceAllocation[];
  amountIn: bigint | undefined;
  expectedOut: bigint | undefined;
  symbolIn: string;
  symbolOut: string;
  isStale: boolean;
}) {
  const used = allocations.filter((a) => a.included);
  if (used.length === 0 || amountIn === undefined) return null;

  return (
    <div className={`rviz${isStale ? " is-stale" : ""}`}>
      <div className="rviz-node rviz-in">
        <span className="label">Your order</span>
        <strong>
          {fmt(amountIn)} {symbolIn}
        </strong>
      </div>

      <span className="rviz-stem" aria-hidden="true" />

      <div className="rviz-node rviz-solver">
        <span>Solver</span>
        <small>splits across verified liquidity</small>
      </div>

      <span className="rviz-stem" aria-hidden="true" />

      {/* One row per source, bar width = its share. This is the bit that animates on a re-split. */}
      <ul className="rviz-legs">
        {used.map((a, i) => (
          <li className="rviz-leg" key={a.source.key}>
            <span className="rviz-leg-head">
              <span className="rviz-leg-name">
                <i style={{ background: SEG[i % SEG.length] }} aria-hidden="true" />
                {a.source.name}
              </span>
              <span className="rviz-leg-num num">
                {fmt(a.amountIn)} {symbolIn}
                <b>{a.sharePct.toFixed(0)}%</b>
              </span>
            </span>
            <span className="rviz-leg-track">
              <i
                style={{ width: `${Math.max(a.sharePct, 1)}%`, background: SEG[i % SEG.length] }}
              />
            </span>
          </li>
        ))}
      </ul>

      <span className="rviz-stem" aria-hidden="true" />

      <div className="rviz-node rviz-out">
        <span className="label">You receive at least</span>
        <strong>
          {fmt(expectedOut, 4)} {symbolOut}
        </strong>
      </div>
    </div>
  );
});

/**
 * Compact allocation bar for the swap card's summary line.
 *
 * Same data, same colours, a tenth of the height - so the summary and the full diagram can never
 * disagree about who got what.
 */
export const RouteAllocationBar = memo(function RouteAllocationBar({
  allocations,
}: {
  allocations: SourceAllocation[];
}) {
  const used = allocations.filter((a) => a.included);
  if (used.length === 0) return null;

  return (
    <span className="ralloc">
      <span className="ralloc-bar">
        {used.map((a, i) => (
          <i
            key={a.source.key}
            style={{ flexGrow: Math.max(a.sharePct, 0.5), background: SEG[i % SEG.length] }}
          />
        ))}
      </span>
      <span className="ralloc-text">
        {used.map((a) => `${a.source.name} ${a.sharePct.toFixed(0)}%`).join(" · ")}
      </span>
    </span>
  );
});
