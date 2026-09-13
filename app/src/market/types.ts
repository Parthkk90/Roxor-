import type { Address } from "viem";

/** Mirrors `IStrategyTypes.StrategyMode`. Numeric values are part of the on-chain ABI. */
export const STRATEGY_MODES = ["NORMAL", "DEFENSIVE", "RECOVERY"] as const;
export type StrategyMode = (typeof STRATEGY_MODES)[number];

/**
 * Chain data is not trusted to be in range. A mode outside 0-2 previously produced
 * `led-dot undefined` and blank label text via unchecked array indexing; this narrows it once, at
 * the boundary, so nothing downstream has to think about it.
 */
export function toStrategyMode(raw: number): StrategyMode {
  return STRATEGY_MODES[raw] ?? "NORMAL";
}

/** Mirrors `IExecutableLiquidity.ExecutableLiquidity`. */
export interface ExecutableLiquidity {
  /** Advertised. On Aqua this is an allowance against a maker's wallet, not custody. */
  virtualLiquidity: bigint;
  walletLiquidity: bigint;
  allowance: bigint;
  /** `min(virtual, wallet, allowance)`. */
  deliverableLiquidity: bigint;
  /** After the strategy multiplier. The only figure a route may allocate against. */
  conditionalLiquidity: bigint;
  coverageBps: number;
}

/** Mirrors `ILiquidityVenue.VenueSnapshot`. */
export interface VenueSnapshot {
  venue: Address;
  strategyId: `0x${string}`;
  mode: StrategyMode;
  effectiveLiquidity: bigint;
  spreadBps: number;
  referencePrice: bigint;
  coverageBps: number;
}

/**
 * One liquidity source, as the UI thinks about it.
 *
 * `unavailable` is a first-class state, distinct from "loading". The previous build destructured
 * only `{snapshot, isLoading}` and never read `error`, so an unreachable RPC rendered "loading…"
 * forever with no indication anything was wrong.
 */
export interface LiquiditySource {
  key: string;
  name: string;
  venueKind: string;
  address: Address;
  unavailable: boolean;
  snapshot?: VenueSnapshot;
  executable?: ExecutableLiquidity;
  /** From the subgraph, so optional by nature. `undefined` renders as "-", never as a guess. */
  reliabilityBps?: number;
}

/** Depth a source can actually settle right now. Zero for anything unavailable or insolvent. */
export function executableDepth(source: LiquiditySource): bigint {
  return source.executable?.conditionalLiquidity ?? 0n;
}

/** True when a source advertises more than it can deliver - the phantom-liquidity gap. */
export function hasPhantomGap(source: LiquiditySource): boolean {
  const exec = source.executable;
  return exec !== undefined && exec.virtualLiquidity > exec.deliverableLiquidity;
}
