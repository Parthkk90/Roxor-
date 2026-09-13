/**
 * Types for the discovery layer - LAYER 1 of the three layers of truth.
 *
 * The naming here is deliberate and load-bearing. Every field sourced from the index is prefixed
 * `reported*`, because it describes what a maker advertised at some past block, not what they can
 * pay now. Fields without that prefix are either derived arithmetic or come from a live chain read.
 * If you find yourself passing a `reported*` value into anything that builds a settlement, the
 * prefix is telling you that you have collapsed two layers that must stay separate.
 */

/** Mirrors `IStrategyTypes.StrategyMode`. */
export type StrategyModeName = "NORMAL" | "DEFENSIVE" | "RECOVERY";

/** Which backend a candidate settles on. */
export type VenueKind = "aqua" | "uniswap-v4";

/**
 * Human-facing reliability bands for coverage, as specified by the marketplace UI.
 *
 * Presentation and analytics only. Nothing routes on a label: the solver acts on the underlying
 * bps figure, and ultimately on a live on-chain read rather than on either.
 */
export type CoverageBand = "HEALTHY" | "DEGRADED" | "FRAGILE" | "UNRELIABLE";

/** One liquidity source as discovered from the index. Never sufficient to execute against. */
export interface LiquidityCandidate {
  strategyId: string;
  maker: string;
  venue: string;
  tokenIn: string;
  tokenOut: string;

  mode: StrategyModeName;

  /** Depth the index last saw advertised. An upper bound at best, and often stale. */
  reportedLiquidity: bigint;
  /** Coverage the index last saw. A reliability hint, not a solvency guarantee. */
  reportedCoverageBps: number;
  spreadBps: number;

  /** `successfulFills * 10000 / attemptedFills`, from indexed history. */
  historicalFillRateBps: number;

  /** Unix seconds of the observation these numbers came from, for staleness checks. */
  observedAt: number;
  active: boolean;
}

/**
 * A candidate after it has been re-read on-chain - LAYER 3 evidence attached to a LAYER 1 hint.
 *
 * The separation is the point: `candidate` is what the index claimed, `executable` is what the
 * chain says right now. Keeping both lets the UI explain *why* a route changed, and makes a
 * divergence between them visible rather than silently resolved.
 */
export interface VerifiedCandidate {
  candidate: LiquidityCandidate;

  /** Live solvency breakdown, mirroring `IExecutableLiquidity.ExecutableLiquidity`. */
  executable: {
    virtualLiquidity: bigint;
    walletLiquidity: bigint;
    allowance: bigint;
    deliverableLiquidity: bigint;
    /** The ONLY figure a route may allocate against. */
    conditionalLiquidity: bigint;
    coverageBps: number;
  };

  /** Live venue snapshot values, re-read at verification time. */
  mode: StrategyModeName;
  spreadBps: number;
  referencePrice: bigint;

  /** Address of the venue adapter to settle this candidate through. */
  venueAddress: string;
}

/** The normalized market record served by the Liquidity Health API (Feature 9). */
export interface LiquidityHealthRecord {
  strategyId: string;
  maker: string;
  venue: string;
  mode: StrategyModeName;
  virtualLiquidity: string;
  walletLiquidity: string;
  allowance: string;
  deliverableLiquidity: string;
  effectiveLiquidity: string;
  coverageBps: number;
  coverageBand: CoverageBand;
  spreadBps: number;
  reliabilityBps: number;
}
