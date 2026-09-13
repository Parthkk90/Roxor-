import { useState } from "react";
import { ArrowRight } from "lucide-react";

import { currentLiquidityBps, type SourceAllocation } from "../../market/derive";
import type { StrategyMode } from "../../market/types";
import { fmtBps, fmtToken, type TokenDisplay } from "../../format";
import { StrategyDrawer } from "./StrategyDrawer";

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
 * Conditional liquidity is the point of this product, so it belongs on the main screen.
 *
 * It used to live only inside a drawer, which meant a first-time visitor had to go looking for the
 * one mechanism that makes the marketplace different. Three lines here - the state, the multiplier
 * it implies, and a sentence saying what that means for their trade - carry the whole idea, and the
 * drawer stays exactly where it was for anyone who wants the rest.
 *
 * Everything shown is read from the venue: the mode from a live engine re-evaluation, the
 * multiplier derived from `conditional / deliverable`. Nothing here is a stored guess about what a
 * strategy is "supposed" to do.
 */
export function StrategySummary({
  allocation,
  tokenIn,
  tokenOut,
}: {
  allocation: SourceAllocation;
  tokenIn: TokenDisplay;
  tokenOut: TokenDisplay;
}) {
  const [open, setOpen] = useState(false);
  const { source } = allocation;
  const snapshot = source.snapshot;
  const executable = source.executable;
  const bps = currentLiquidityBps(source);

  if (source.unavailable || !snapshot || !executable) return null;

  const mode = snapshot.mode;
  const meaning: Record<StrategyMode, string> = {
    NORMAL: "Trading at full capacity.",
    DEFENSIVE: "Liquidity reduced because market conditions crossed the strategy threshold.",
    RECOVERY: "Liquidity is being restored. It returns to full size once calm has held.",
  };

  return (
    <>
      <section className={`strsum${mode !== "NORMAL" ? " strsum-stressed" : ""}`}>
        <div className="strsum-main">
          <span className="label">Aqua strategy</span>
          <div className="strsum-state">
            <span className="badge" style={{ color: MODE_COLOR[mode], borderColor: "currentColor" }}>
              <span className="dot" />
              {MODE_WORD[mode]}
            </span>
            <span className="strsum-pct">{fmtBps(bps, 0)} executable</span>
          </div>
          <p className="strsum-say">{meaning[mode]}</p>
          <p className="strsum-num num">
            {fmtToken(executable.conditionalLiquidity, tokenIn)} can settle right now
          </p>
        </div>

        <button type="button" className="btn btn-ghost strsum-link" onClick={() => setOpen(true)}>
          View strategy
          <ArrowRight size={14} strokeWidth={2.25} aria-hidden="true" />
        </button>
      </section>

      <StrategyDrawer
        open={open}
        onClose={() => setOpen(false)}
        allocation={allocation}
        tokenIn={tokenIn}
        tokenOut={tokenOut}
      />
    </>
  );
}
