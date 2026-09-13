/**
 * Liquidity Health API - Feature 9.
 *
 * Produces the normalized market record the frontend renders. It is a *join* of the three layers,
 * and it keeps them labelled rather than merged: `reliabilityBps` comes from the index (layer 1),
 * everything describing depth comes from a live chain read (layer 3). Serialising bigints as
 * decimal strings is deliberate - JSON numbers cannot hold 18-decimal token amounts without
 * silently losing precision, and a health endpoint that rounds balances is a health endpoint that
 * lies.
 */
import type { LiquidityHealthRecord, VerifiedCandidate } from "../discovery/types.js";
import { coverageBand } from "./coverage.js";

/** Build one health record from a verified candidate plus its indexed reliability. */
export function toHealthRecord(verified: VerifiedCandidate): LiquidityHealthRecord {
  const { candidate, executable } = verified;

  return {
    strategyId: candidate.strategyId,
    maker: candidate.maker,
    venue: candidate.venue,
    mode: verified.mode,
    virtualLiquidity: executable.virtualLiquidity.toString(),
    walletLiquidity: executable.walletLiquidity.toString(),
    allowance: executable.allowance.toString(),
    deliverableLiquidity: executable.deliverableLiquidity.toString(),
    effectiveLiquidity: executable.conditionalLiquidity.toString(),
    coverageBps: executable.coverageBps,
    coverageBand: coverageBand(executable.coverageBps),
    spreadBps: verified.spreadBps,
    reliabilityBps: candidate.historicalFillRateBps,
  };
}

export interface MarketHealth {
  tokenIn: string;
  tokenOut: string;
  /** Worst regime across all sources - the pair's overall posture, not any one maker's. */
  regime: "NORMAL" | "DEFENSIVE" | "RECOVERY";
  /** Sum of `effectiveLiquidity`, never of advertised depth. */
  totalExecutableLiquidity: string;
  /** Sum of advertised depth, shown only so the gap to executable is visible. */
  totalAdvertisedLiquidity: string;
  /** Aggregate coverage: executable / advertised, in bps. The market's overall honesty. */
  marketCoverageBps: number;
  sources: LiquidityHealthRecord[];
  observedAt: number;
}

const REGIME_SEVERITY = { NORMAL: 0, RECOVERY: 1, DEFENSIVE: 2 } as const;

/**
 * Aggregate every source for a pair into one market record.
 *
 * The headline regime is the *worst* among active sources rather than an average: a market where
 * one of three makers has gone defensive is a market in which a trader may find less depth than
 * they expect, and averaging that away would hide exactly the signal they need.
 */
export function toMarketHealth(
  tokenIn: string,
  tokenOut: string,
  verified: VerifiedCandidate[],
  now = Math.floor(Date.now() / 1000)
): MarketHealth {
  const sources = verified.map(toHealthRecord);

  let totalExecutable = 0n;
  let totalAdvertised = 0n;
  let regime: MarketHealth["regime"] = "NORMAL";

  for (const entry of verified) {
    totalExecutable += entry.executable.conditionalLiquidity;
    totalAdvertised += entry.executable.virtualLiquidity;
    if (REGIME_SEVERITY[entry.mode] > REGIME_SEVERITY[regime]) {
      regime = entry.mode;
    }
  }

  const marketCoverageBps =
    totalAdvertised === 0n ? 0 : Number(min((totalExecutable * 10_000n) / totalAdvertised, 10_000n));

  return {
    tokenIn,
    tokenOut,
    regime,
    totalExecutableLiquidity: totalExecutable.toString(),
    totalAdvertisedLiquidity: totalAdvertised.toString(),
    marketCoverageBps,
    sources,
    observedAt: now,
  };
}

function min(a: bigint, b: bigint): bigint {
  return a < b ? a : b;
}
