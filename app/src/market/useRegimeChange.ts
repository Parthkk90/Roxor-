import { useCallback, useEffect, useRef, useState } from "react";

import type { MarketSummary } from "./derive";
import type { StrategyMode } from "./types";

export interface RegimeChange {
  id: number;
  from: StrategyMode;
  to: StrategyMode;
  /** Total executable depth either side of the transition, in `tokenIn` base units. */
  executableFrom: bigint;
  executableTo: bigint;
}

/**
 * Notice when the market's regime actually changes, and remember what it cost.
 *
 * This is the moment the whole product is about: volatility crosses a threshold, the on-chain
 * engine moves the strategy, executable depth collapses, and the Solver reallocates. Between two
 * renders that happens silently, and a judge watching the screen would have to have been staring at
 * the right two numbers to catch it.
 *
 * Deliberately narrow. It watches one thing - `summary.regime` - and captures the depth from the
 * render *before* the change, so the pair reported is a genuine before and after rather than the
 * same block read twice. No thresholds, no smoothing: a regime transition is discrete, on-chain,
 * and always worth announcing.
 *
 * Unlike the route-shift watcher, this does NOT reset when the user changes their own order size:
 * the regime is a property of the market, not of the order, so an amount edit cannot manufacture
 * one.
 */
export interface RegimeChangeState {
  change: RegimeChange | null;
  dismiss: () => void;
}

export function useRegimeChange(summary: MarketSummary): RegimeChangeState {
  const previous = useRef<{ regime: StrategyMode; executable: bigint } | null>(null);
  const nextId = useRef(0);
  const [change, setChange] = useState<RegimeChange | null>(null);

  const { regime, totalExecutable, readableSources } = summary;

  useEffect(() => {
    // Nothing readable yet: do not treat the first successful read as a transition from NORMAL.
    if (readableSources === 0) return;

    const before = previous.current;
    previous.current = { regime, executable: totalExecutable };
    if (before === null || before.regime === regime) return;

    nextId.current += 1;
    setChange({
      id: nextId.current,
      from: before.regime,
      to: regime,
      executableFrom: before.executable,
      executableTo: totalExecutable,
    });
  }, [regime, totalExecutable, readableSources]);

  // Deliberately NOT on a timer.
  //
  // A regime transition is the single thing this product exists to show, and it is the thing a
  // viewer is most likely to have looked away from - a shock is instant, and the recovery leg takes
  // ten real minutes. An earlier version cleared this after thirty seconds, which meant the
  // explanation of the most important event on the screen could expire before anyone read it.
  // It stays until the reader dismisses it or the market moves again, which is how an explanation
  // should behave; the transient banner is the route-shift one, where drift is ordinary.
  return { change, dismiss: useCallback(() => setChange(null), []) };
}
