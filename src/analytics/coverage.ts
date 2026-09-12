/**
 * Coverage arithmetic and presentation bands.
 *
 * This is the offchain twin of `contracts/libraries/ExecutableLiquidityLib.sol`. The two must agree
 * exactly, including the awkward cases — zero advertised depth reports 0 rather than a vacuous
 * 100%, results clamp at 10_000, and division rounds down — because a UI that disagrees with the
 * chain about a maker's health is worse than one that shows nothing at all.
 */
import type { CoverageBand } from "../discovery/types.js";

export const BPS = 10_000n;

/** `min` over three bigints — the solvency chokepoint, mirroring `ExecutableLiquidityLib.min3`. */
export function min3(a: bigint, b: bigint, c: bigint): bigint {
  const ab = a < b ? a : b;
  return ab < c ? ab : c;
}

/**
 * `deliverable / virtual` in bps, clamped to 10_000, rounding down.
 *
 * Zero advertised depth yields 0, matching the Solidity library: "nothing to deliver" must not be
 * indistinguishable from "fully covered".
 */
export function coverageBps(deliverable: bigint, virtualLiquidity: bigint): number {
  if (virtualLiquidity <= 0n) return 0;
  const raw = (deliverable * BPS) / virtualLiquidity;
  return Number(raw > BPS ? BPS : raw);
}

/**
 * Deliverable and conditional depth from raw solvency inputs.
 * Mirrors `ExecutableLiquidityLib.derive` field for field.
 */
export function deriveExecutable(
  virtualLiquidity: bigint,
  walletLiquidity: bigint,
  allowance: bigint,
  liquidityBps: number
): {
  virtualLiquidity: bigint;
  walletLiquidity: bigint;
  allowance: bigint;
  deliverableLiquidity: bigint;
  conditionalLiquidity: bigint;
  coverageBps: number;
} {
  const deliverableLiquidity = min3(virtualLiquidity, walletLiquidity, allowance);
  return {
    virtualLiquidity,
    walletLiquidity,
    allowance,
    deliverableLiquidity,
    conditionalLiquidity: (deliverableLiquidity * BigInt(liquidityBps)) / BPS,
    coverageBps: coverageBps(deliverableLiquidity, virtualLiquidity),
  };
}

/**
 * Presentation band for a coverage figure.
 *
 * Labels exist for humans reading a table; nothing routes on them. They are intentionally NOT
 * represented on-chain — an enum there would invite treating a display bucket as a safety control.
 */
export function coverageBand(bps: number): CoverageBand {
  if (bps >= 9000) return "HEALTHY";
  if (bps >= 7000) return "DEGRADED";
  if (bps >= 3000) return "FRAGILE";
  return "UNRELIABLE";
}

/** Format a bps figure as a percentage string for display, e.g. `8200` -> `"82.0%"`. */
export function formatBpsPercent(bps: number, decimals = 1): string {
  return `${(bps / 100).toFixed(decimals)}%`;
}
