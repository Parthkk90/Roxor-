/**
 * Historical reliability — Feature 8.
 *
 * `reliabilityBps = successfulFills * 10000 / attemptedFills`.
 *
 * The single most important property of this module is what it is NOT allowed to do. Reliability
 * is a statement about the past, and the past cannot pay for a trade. A maker with a 99.1% record
 * and an empty wallet has zero executable liquidity, full stop — so every function here returns a
 * *ranking* input, and `allocatableDepth` exists to make that precedence explicit and testable
 * rather than merely documented.
 */

export const BPS = 10_000;

export interface FillCounters {
  attemptedFills: number;
  successfulFills: number;
  /**
   * Settlements that were attempted and reverted.
   *
   * Only partially observable from logs: a reverted transaction's events are unwound with the
   * rest of its call frame, so a failed fill usually leaves no trace an indexer can see. Callers
   * that can observe failures another way (a solver's own attempt log, a mempool watcher) should
   * supply them here; an indexer alone will generally report 0.
   */
  failedFills?: number;
}

/**
 * `successfulFills * 10000 / attemptedFills`, rounded down.
 *
 * A maker with no attempts reads as fully reliable rather than as 0%. A fresh maker has not earned
 * distrust, and burying them under a score they never earned would hand incumbents a permanent
 * advantage — while costing traders nothing, because solvency is enforced independently.
 */
export function reliabilityBps(counters: FillCounters): number {
  const attempted = counters.attemptedFills;
  if (!Number.isFinite(attempted) || attempted <= 0) return BPS;

  const successful = Math.max(0, Math.min(counters.successfulFills, attempted));
  return Math.floor((successful * BPS) / attempted);
}

/**
 * Reliability with low-sample-size damping.
 *
 * A maker who has filled once and succeeded is not more reliable than one who has filled a
 * thousand times at 99%, but the raw ratio says 100% vs 99%. Blending toward a neutral prior
 * until `confidenceThreshold` observations have accumulated stops a single lucky fill from
 * out-ranking a long, honest track record.
 */
export function smoothedReliabilityBps(counters: FillCounters, confidenceThreshold = 20, priorBps = 9000): number {
  const attempted = Math.max(0, counters.attemptedFills);
  if (attempted === 0) return BPS;

  const observed = reliabilityBps(counters);
  if (attempted >= confidenceThreshold) return observed;

  const weight = attempted / confidenceThreshold;
  return Math.floor(observed * weight + priorBps * (1 - weight));
}

/**
 * The hard boundary between Feature 8 and Feature 2, as an executable rule.
 *
 * Returns the depth that may actually be allocated given both a reliability score and a live
 * solvency figure. Reliability can only ever *de-rank*; it can never raise executable depth above
 * what the chain says is deliverable. Routing code should call this rather than combining the two
 * numbers ad hoc, so the precedence is impossible to get backwards.
 */
export function allocatableDepth(executableLiquidity: bigint, _reliabilityBps: number): bigint {
  return executableLiquidity < 0n ? 0n : executableLiquidity;
}

/** True when history says this maker is worth preferring, all else being equal. */
export function isReliable(bps: number, threshold = 9500): boolean {
  return bps >= threshold;
}
