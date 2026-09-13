import type { ExecutionPlan } from "../trade/useRouteQuote";
import { coverageBand, type CoverageBand } from "./coverage";
import { executableDepth, type LiquiditySource, type StrategyMode } from "./types";

/**
 * Everything the marketplace displays that is *computed* rather than read.
 *
 * Kept out of components so the swap card and the marketplace page cannot drift: both derive their
 * figures here, from the same `LiquiditySource[]`, at the same block. A second copy of "what share
 * did Aqua take" living inside a component is how the old build ended up with two panels
 * disagreeing about the same trade.
 *
 * Nothing in this file invents a value. Where a figure cannot be derived from what the chain
 * returned, it is `undefined` and renders as "-".
 */

const BPS = 10_000n;

/** One source, plus its part in the current route. */
export interface SourceAllocation {
  source: LiquiditySource;
  /** Amount the solver routed here, or 0n when it was not used. */
  amountIn: bigint;
  expectedOut: bigint;
  /** Share of the order, 0–100. */
  sharePct: number;
  included: boolean;
  /** Per-leg spread from the plan, which can differ from the snapshot's quoted spread. */
  legSpreadBps: number | undefined;
}

export function allocationsFor(
  sources: LiquiditySource[],
  plan: ExecutionPlan | undefined
): SourceAllocation[] {
  const total = plan?.legs.reduce((sum, leg) => sum + leg.amountIn, 0n) ?? 0n;

  return sources.map((source) => {
    const leg = plan?.legs.find((l) => l.venue.toLowerCase() === source.address.toLowerCase());
    const amountIn = leg?.amountIn ?? 0n;
    return {
      source,
      amountIn,
      expectedOut: leg?.expectedAmountOut ?? 0n,
      sharePct: total === 0n ? 0 : Number((amountIn * 10_000n) / total) / 100,
      included: leg !== undefined && amountIn > 0n,
      legSpreadBps: leg?.spreadBps,
    };
  });
}

/**
 * The strategy's current liquidity multiplier, in bps.
 *
 * Derived, not read: `conditionalLiquidity = deliverableLiquidity * liquidityBps / 10000`, so the
 * multiplier falls straight out of two figures the venue already returned. This is the number that
 * moves when a strategy goes defensive, which makes it the honest way to show "how much of what it
 * could deliver is it currently willing to quote" without reading the rule program.
 *
 * `undefined` when there is nothing deliverable - a multiplier on zero is meaningless, and 0%
 * would wrongly suggest the strategy is holding liquidity back.
 */
export function currentLiquidityBps(source: LiquiditySource): number | undefined {
  const exec = source.executable;
  if (!exec || exec.deliverableLiquidity === 0n) return undefined;
  return Number((exec.conditionalLiquidity * BPS) / exec.deliverableLiquidity);
}

/**
 * The four depth layers, as the "no phantom liquidity" explainer walks them.
 *
 * Each is a real figure returned by `executableLiquidity`; the chain applies them in exactly this
 * order. The point of listing them is that each step can only ever shrink the number.
 */
export interface DepthLayers {
  advertised: bigint;
  wallet: bigint;
  allowance: bigint;
  deliverable: bigint;
  conditional: bigint;
  /** Largest of the layers, for scaling bars against a common axis. */
  scale: bigint;
}

export function depthLayers(source: LiquiditySource): DepthLayers | undefined {
  const e = source.executable;
  if (!e) return undefined;
  const scale = [e.virtualLiquidity, e.walletLiquidity, e.deliverableLiquidity, e.conditionalLiquidity].reduce(
    (max, v) => (v > max ? v : max),
    0n
  );
  return {
    advertised: e.virtualLiquidity,
    wallet: e.walletLiquidity,
    allowance: e.allowance,
    deliverable: e.deliverableLiquidity,
    conditional: e.conditionalLiquidity,
    scale,
  };
}

export interface MarketSummary {
  totalExecutable: bigint;
  totalAdvertised: bigint;
  /** Aggregate executable ÷ advertised. `undefined` when nothing is advertised. */
  marketCoverageBps: number | undefined;
  marketBand: CoverageBand | undefined;
  healthySources: number;
  /** Sources that returned data at all - the denominator for "healthy". */
  readableSources: number;
  /** Lowest spread among sources that can actually fill something. `undefined` if none can. */
  bestSpreadBps: number | undefined;
  bestPricedSource: LiquiditySource | undefined;
  regime: StrategyMode;
  /**
   * How much of what this market *could* deliver its strategies are currently willing to quote,
   * in bps - the tightest limit in force across readable sources.
   *
   * Derived, never read: `conditional / deliverable` per source, then the minimum. The minimum
   * rather than an average, for the same reason `regime` is the worst rather than the mean - one
   * source pulling back to 25% is the fact a trader needs, and averaging it against a pool sitting
   * at 100% would report 62% and hide it.
   *
   * `undefined` when nothing is deliverable, because a fraction of zero says nothing.
   */
  liquidityCapacityBps: number | undefined;
}

/**
 * Whole-market figures.
 *
 * Sums `conditionalLiquidity`, never advertised depth - a headline "total liquidity" built from
 * advertisements would make the interface itself a source of phantom liquidity, which is the exact
 * failure the product exists to prevent.
 */
export function summarize(sources: LiquiditySource[]): MarketSummary {
  let totalExecutable = 0n;
  let totalAdvertised = 0n;
  let healthySources = 0;
  let readableSources = 0;
  let bestSpreadBps: number | undefined;
  let bestPricedSource: LiquiditySource | undefined;

  const severity = { NORMAL: 0, RECOVERY: 1, DEFENSIVE: 2 } as const;
  let regime: StrategyMode = "NORMAL";
  let liquidityCapacityBps: number | undefined;

  for (const source of sources) {
    if (source.unavailable || !source.executable) continue;
    readableSources += 1;

    totalExecutable += source.executable.conditionalLiquidity;
    totalAdvertised += source.executable.virtualLiquidity;

    if (coverageBand(source.executable.coverageBps) === "HEALTHY") healthySources += 1;

    // "Best priced" only counts sources that could actually fill something. A source with the
    // tightest spread and nothing to sell is not the best price, it is not a price at all.
    const spread = source.snapshot?.spreadBps;
    if (spread !== undefined && executableDepth(source) > 0n && (bestSpreadBps === undefined || spread < bestSpreadBps)) {
      bestSpreadBps = spread;
      bestPricedSource = source;
    }

    const capacity = currentLiquidityBps(source);
    if (capacity !== undefined && (liquidityCapacityBps === undefined || capacity < liquidityCapacityBps)) {
      liquidityCapacityBps = capacity;
    }

    const mode = source.snapshot?.mode;
    if (mode && severity[mode] > severity[regime]) regime = mode;
  }

  const marketCoverageBps =
    totalAdvertised === 0n
      ? undefined
      : Math.min(10_000, Number((totalExecutable * BPS) / totalAdvertised));

  return {
    totalExecutable,
    totalAdvertised,
    marketCoverageBps,
    marketBand: marketCoverageBps === undefined ? undefined : coverageBand(marketCoverageBps),
    healthySources,
    readableSources,
    bestSpreadBps,
    bestPricedSource,
    regime,
    liquidityCapacityBps,
  };
}
