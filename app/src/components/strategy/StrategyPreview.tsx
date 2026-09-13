import { ArrowDown } from "lucide-react";

import { fmtBps, fmtDuration } from "../../format";
import type { StrategyParams } from "../../strategy/params";

/**
 * What the configured parameters will do, as the state machine they describe.
 *
 * Informational only, and that distinction is load-bearing: this is a rendering of the parameters
 * the maker just typed, NOT a simulation and NOT a second implementation of the rule engine. The
 * rule that actually runs is compiled by the project's CLF backend and executed on-chain by
 * `RuleEngineLib`; the builder shows the compiled program decoded back from those same bytes
 * directly underneath this, which is the authoritative view.
 *
 * It exists because a column of ten numeric fields does not tell a maker what they have built. A
 * threshold only means something once you can see which way it moves liquidity.
 */
export function StrategyPreview({ params }: { params: StrategyParams }) {
  return (
    <div className="spreview" aria-label="What this strategy will do">
      <Step tone="normal" label="Normal" value={fmtBps(params.normalLiquidityBps, 0)} note={`liquidity available, ${fmtBps(params.normalSpreadBps)} fee`} />

      <Edge text={`volatility rises to ${fmtBps(params.enterDefensiveBps, 0)} or above`} />

      <Step
        tone="defensive"
        label="Defensive"
        value={fmtBps(params.defensiveLiquidityBps, 0)}
        note={`liquidity available, ${fmtBps(params.defensiveSpreadBps)} fee`}
      />

      <Edge
        text={`volatility falls below ${fmtBps(params.leaveDefensiveBps, 0)} and stays there for ${fmtDuration(params.calmPeriodSeconds)}`}
      />

      <Step
        tone="recovery"
        label="Recovering"
        value={fmtBps(params.recoveryLiquidityBps, 0)}
        note={`liquidity available, ${fmtBps(params.recoverySpreadBps)} fee`}
      />

      <Edge text={`recovery holds for ${fmtDuration(params.recoveryPeriodSeconds)}`} />

      <Step tone="normal" label="Normal" value={fmtBps(params.normalLiquidityBps, 0)} note="back to full size" />

      <p className="spreview-note">
        A fresh shock outranks the recovery timer: if volatility returns to{" "}
        {fmtBps(params.enterDefensiveBps, 0)} while recovering, the strategy goes straight back to
        defensive.
      </p>
    </div>
  );
}

function Step({
  tone,
  label,
  value,
  note,
}: {
  tone: "normal" | "defensive" | "recovery";
  label: string;
  value: string;
  note: string;
}) {
  return (
    <div className={`spreview-step spreview-${tone}`}>
      <span className="spreview-label">{label}</span>
      <span className="spreview-value">{value}</span>
      <span className="spreview-note-inline">{note}</span>
    </div>
  );
}

function Edge({ text }: { text: string }) {
  return (
    <div className="spreview-edge">
      <ArrowDown size={14} strokeWidth={2.25} aria-hidden="true" />
      <span>{text}</span>
    </div>
  );
}
