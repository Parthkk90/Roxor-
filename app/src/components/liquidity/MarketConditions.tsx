import { ArrowDown, ArrowRight, ArrowUp, Zap } from "lucide-react";

import type { MarketSummary } from "../../market/derive";
import type { RouteChange } from "../../market/useRouteChange";
import type { StrategyMode } from "../../market/types";
import { fmt } from "../../format";

const MODE_WORD: Record<StrategyMode, string> = {
  NORMAL: "Normal",
  DEFENSIVE: "Defensive",
  RECOVERY: "Recovering",
};
const MODE_COLOR: Record<StrategyMode, string> = {
  NORMAL: "var(--ok)",
  DEFENSIVE: "var(--bad)",
  RECOVERY: "var(--warn)",
};

/**
 * Market posture, and an announcement when the route moves because of it.
 *
 * The regime shown is the *worst* among readable sources, never an average - one maker going
 * defensive is precisely the signal a trader needs, and averaging it against a healthy pool would
 * hide it.
 *
 * The "Route updated" banner is the demo's payoff: shock the market, a strategy pulls back, and the
 * shift in allocation is announced with its before and after rather than quietly redrawn.
 */
export function MarketConditions({
  summary,
  change,
  symbol,
}: {
  summary: MarketSummary;
  change: RouteChange | null;
  symbol: string;
}) {
  const stressed = summary.regime !== "NORMAL";

  return (
    <section className={`mcond${stressed ? " mcond-stressed" : ""}`}>
      <header className="mcond-head">
        <span className="label">Market conditions</span>
        <span className="badge" style={{ color: MODE_COLOR[summary.regime], borderColor: "currentColor" }}>
          <span className="dot" />
          {MODE_WORD[summary.regime]}
        </span>
      </header>

      <div className="mcond-grid">
        <div className="metric">
          <span className="k">Executable now</span>
          <span className="v mcond-big">
            {fmt(summary.totalExecutable)} <em>{symbol}</em>
          </span>
        </div>
        <div className="metric">
          <span className="k">Healthy sources</span>
          <span className="v mcond-big">
            {summary.readableSources === 0 ? "-" : `${summary.healthySources}/${summary.readableSources}`}
          </span>
        </div>
        <div className="metric">
          <span className="k">Best fee</span>
          <span className="v mcond-big">
            {summary.bestSpreadBps === undefined ? "-" : `${(summary.bestSpreadBps / 100).toFixed(2)}%`}
          </span>
          {summary.bestPricedSource && <span className="k">{summary.bestPricedSource.name}</span>}
        </div>
      </div>

      {stressed && (
        <p className="mcond-note">
          {summary.regime === "DEFENSIVE"
            ? "A source has reduced how much it will trade to protect against elevated risk. Less liquidity is executable than usual."
            : "A source is restoring liquidity after elevated risk. It will return to full size once calm holds."}
        </p>
      )}

      {change && (
        // Keyed on the change id so a new announcement restarts the entrance animation rather than
        // silently swapping its contents.
        <div className="rupd" key={change.id} role="status">
          <span className="rupd-head">
            <Zap size={13} strokeWidth={2.5} aria-hidden="true" />
            Route updated
          </span>
          <ul className="rupd-list">
            {change.shifts.map((shift) => {
              const up = shift.toPct > shift.fromPct;
              return (
                <li key={shift.name}>
                  <span>{shift.name}</span>
                  <span className="rupd-nums num">
                    <span className="faint">{shift.fromPct.toFixed(0)}%</span>
                    <ArrowRight size={12} strokeWidth={2.5} aria-hidden="true" />
                    <b style={{ color: up ? "var(--ok)" : "var(--bad)" }}>{shift.toPct.toFixed(0)}%</b>
                    {up ? (
                      <ArrowUp size={12} strokeWidth={2.5} color="var(--ok)" aria-hidden="true" />
                    ) : (
                      <ArrowDown size={12} strokeWidth={2.5} color="var(--bad)" aria-hidden="true" />
                    )}
                  </span>
                </li>
              );
            })}
          </ul>
        </div>
      )}
    </section>
  );
}
