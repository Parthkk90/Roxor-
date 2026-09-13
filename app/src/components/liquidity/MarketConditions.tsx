import { ArrowRight, X, Zap } from "lucide-react";

import type { MarketSummary } from "../../market/derive";
import type { RegimeChange } from "../../market/useRegimeChange";
import type { RouteChange } from "../../market/useRouteChange";
import type { StrategyMode } from "../../market/types";
import { fmt, fmtBps, type TokenDisplay } from "../../format";

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
 * Market posture: the regime, what is driving it, and what it has cost the market's depth.
 *
 * The regime shown is the *worst* among readable sources, never an average - one maker going
 * defensive is precisely the signal a trader needs, and averaging it against a healthy pool would
 * hide it. Liquidity capacity follows the same rule for the same reason.
 *
 * Volatility is the market-state figure the strategies are actually evaluated against, read from
 * the deployed provider. It is `undefined`, and renders as a dash, when that read fails - this card
 * never fills a gap with a plausible number.
 */
export function MarketConditions({
  summary,
  change,
  regimeChange,
  onDismissRegimeChange,
  volatilityBps,
  token,
}: {
  summary: MarketSummary;
  change: RouteChange | null;
  regimeChange: RegimeChange | null;
  onDismissRegimeChange: () => void;
  volatilityBps: number | undefined;
  token: TokenDisplay;
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
        <Metric
          k="Volatility"
          v={fmtBps(volatilityBps, 0)}
          sub={volatilityBps === undefined ? "provider unreadable" : "as the strategy sees it"}
        />
        <Metric
          k="Liquidity capacity"
          v={fmtBps(summary.liquidityCapacityBps, 0)}
          sub="of what sources could deliver"
        />
        <Metric
          k="Executable now"
          v={fmt(summary.totalExecutable, token.decimals)}
          unit={token.symbol}
          sub="across all sources"
        />
        <Metric
          k="Sources healthy"
          v={summary.readableSources === 0 ? "-" : `${summary.healthySources}/${summary.readableSources}`}
          sub="covering 90%+ of what they advertise"
        />
      </div>

      {stressed && (
        <p className="mcond-note">
          {summary.regime === "DEFENSIVE"
            ? "A source has reduced how much it will trade to protect against elevated risk. Less liquidity is executable than usual."
            : "A source is restoring liquidity after elevated risk. It will return to full size once calm holds."}
        </p>
      )}

      {/* The demo's payoff: a shock lands, and what it did is stated rather than quietly redrawn. */}
      {(regimeChange || change) && (
        <WhatChanged
          regimeChange={regimeChange}
          route={change}
          token={token}
          onDismiss={onDismissRegimeChange}
        />
      )}
    </section>
  );
}

function Metric({ k, v, unit, sub }: { k: string; v: string; unit?: string; sub: string }) {
  return (
    <div className="metric">
      <span className="k">{k}</span>
      <span className="v mcond-big">
        {v}
        {unit && <em> {unit}</em>}
      </span>
      <span className="k mcond-sub">{sub}</span>
    </div>
  );
}

/**
 * What just changed, and why - expandable, because it is an explanation rather than an alert.
 *
 * Everything in here is a before/after pair captured from two real chain reads. The "reason" line
 * is the only interpretation, and it says only what the protocol itself asserts: the engine moved
 * the strategy because a market condition crossed a threshold in its compiled program.
 */
function WhatChanged({
  regimeChange,
  route,
  token,
  onDismiss,
}: {
  regimeChange: RegimeChange | null;
  route: RouteChange | null;
  token: TokenDisplay;
  onDismiss: () => void;
}) {
  return (
    <details className="rupd" open key={regimeChange?.id ?? route?.id} role="status">
      <summary className="rupd-head">
        <span style={{ display: "inline-flex", alignItems: "center", gap: 6 }}>
          <Zap size={13} strokeWidth={2.5} aria-hidden="true" />
          {regimeChange ? "Market conditions changed" : "Route updated"}
        </span>
        <span style={{ display: "inline-flex", alignItems: "center", gap: 8 }}>
          <span className="rupd-more">What changed?</span>
          {regimeChange && (
            <button
              type="button"
              className="rupd-x"
              aria-label="Dismiss"
              onClick={(e) => {
                e.preventDefault();
                onDismiss();
              }}
            >
              <X size={13} strokeWidth={2.5} aria-hidden="true" />
            </button>
          )}
        </span>
      </summary>

      <ul className="rupd-list">
        {regimeChange && (
          <>
            <li>
              <span>Strategy</span>
              <span className="rupd-nums num">
                <span className="faint">{MODE_WORD[regimeChange.from]}</span>
                <ArrowRight size={12} strokeWidth={2.5} aria-hidden="true" />
                <b style={{ color: MODE_COLOR[regimeChange.to] }}>{MODE_WORD[regimeChange.to]}</b>
              </span>
            </li>
            <li>
              <span>Executable liquidity</span>
              <span className="rupd-nums num">
                <span className="faint">{fmt(regimeChange.executableFrom, token.decimals)}</span>
                <ArrowRight size={12} strokeWidth={2.5} aria-hidden="true" />
                <b
                  style={{
                    color: regimeChange.executableTo >= regimeChange.executableFrom ? "var(--ok)" : "var(--bad)",
                  }}
                >
                  {fmt(regimeChange.executableTo, token.decimals)} {token.symbol}
                </b>
              </span>
            </li>
          </>
        )}

        {route?.shifts.map((shift) => (
          <li key={shift.name}>
            <span>{shift.name} allocation</span>
            <span className="rupd-nums num">
              <span className="faint">{shift.fromPct.toFixed(0)}%</span>
              <ArrowRight size={12} strokeWidth={2.5} aria-hidden="true" />
              <b style={{ color: shift.toPct > shift.fromPct ? "var(--ok)" : "var(--bad)" }}>
                {shift.toPct.toFixed(0)}%
              </b>
            </span>
          </li>
        ))}
      </ul>

      <p className="rupd-why">
        {regimeChange
          ? "The market condition crossed a threshold in the strategy's compiled rule program, so the on-chain engine changed its liquidity regime. The Solver re-read the reduced executable depth and reallocated."
          : "Executable depth moved, so the Solver rebuilt the split. It only ever allocates against what a source can actually settle."}
      </p>
    </details>
  );
}
