/**
 * Coverage presentation. Mirrors `src/analytics/coverage.ts` and
 * `contracts/libraries/ExecutableLiquidityLib.sol` — the thresholds must agree with both, because a
 * UI that disagrees with the chain about a maker's health is worse than one showing nothing.
 *
 * These are display buckets. Nothing routes on a band; the solver acts on the underlying bps, and
 * ultimately on a live chain read. That is why there is deliberately no on-chain enum for them.
 */
export const COVERAGE_BANDS = ["HEALTHY", "DEGRADED", "FRAGILE", "UNRELIABLE"] as const;
export type CoverageBand = (typeof COVERAGE_BANDS)[number];

export function coverageBand(bps: number): CoverageBand {
  if (bps >= 9000) return "HEALTHY";
  if (bps >= 7000) return "DEGRADED";
  if (bps >= 3000) return "FRAGILE";
  return "UNRELIABLE";
}

export type StatusTone = "success" | "warning" | "danger" | "neutral";

export function coverageTone(band: CoverageBand): StatusTone {
  switch (band) {
    case "HEALTHY":
      return "success";
    case "DEGRADED":
      return "warning";
    case "FRAGILE":
      return "warning";
    case "UNRELIABLE":
      return "danger";
  }
}

/**
 * Plain-language gloss for a band. Shown alongside the percentage so the signal is not carried by
 * colour alone — previously the band name was never rendered anywhere, only the number, which left
 * the whole reliability signal inaccessible to anyone who could not distinguish the dot colours.
 */
export function coverageMeaning(band: CoverageBand): string {
  switch (band) {
    case "HEALTHY":
      return "Can deliver essentially all of the liquidity it advertises.";
    case "DEGRADED":
      return "Can deliver most, but not all, of the liquidity it advertises.";
    case "FRAGILE":
      return "A large share of this source's advertised liquidity is not deliverable.";
    case "UNRELIABLE":
      return "Almost none of this source's advertised liquidity can actually be settled.";
  }
}
