/**
 * Did the quote move enough since the user looked at it to be worth re-reading?
 *
 * `Solver.settle` re-derives the route on-chain, so the displayed figure is advisory by
 * construction — it is never locked and the UI must not pretend otherwise. What the UI *can* do is
 * refuse to let a number go stale silently underneath a click.
 *
 * Every quote drifts a little between blocks. Prompting on any change at all would make the button
 * unusable on a 12-second chain; prompting on none would let a materially worse route be signed
 * because it arrived between paint and click. The threshold is the whole design, and it is
 * expressed in the same unit the user already set: their own slippage tolerance.
 */

/**
 * Drift is material when the expected output has fallen by more than a quarter of the user's
 * tolerance.
 *
 * Tied to slippage rather than being a fixed percentage because tolerance is exactly the statement
 * of how much movement this user considers acceptable. Someone at 0.1% should be asked about
 * movement that someone at 3% would never want to hear about.
 */
const DRIFT_FRACTION_OF_SLIPPAGE = 4n;

export interface QuoteSnapshot {
  amountWei: bigint;
  expectedOut: bigint;
  minOut: bigint;
}

export type DriftVerdict =
  | { kind: "none" }
  /** Output improved. Never worth interrupting someone for good news — just show the new figure. */
  | { kind: "improved"; from: bigint; to: bigint }
  /** Output fell materially. The UI must surface this before the wallet opens. */
  | { kind: "worse"; from: bigint; to: bigint; dropBps: number };

export function compareQuote(
  reviewed: QuoteSnapshot | null,
  currentExpectedOut: bigint | undefined,
  slippageBps: number
): DriftVerdict {
  if (reviewed === null || currentExpectedOut === undefined) return { kind: "none" };
  if (reviewed.expectedOut === 0n) return { kind: "none" };

  if (currentExpectedOut > reviewed.expectedOut) {
    return { kind: "improved", from: reviewed.expectedOut, to: currentExpectedOut };
  }
  if (currentExpectedOut === reviewed.expectedOut) return { kind: "none" };

  const drop = reviewed.expectedOut - currentExpectedOut;
  const dropBps = Number((drop * 10_000n) / reviewed.expectedOut);
  const threshold = Math.max(1, Math.floor(slippageBps / Number(DRIFT_FRACTION_OF_SLIPPAGE)));

  if (dropBps < threshold) return { kind: "none" };
  return { kind: "worse", from: reviewed.expectedOut, to: currentExpectedOut, dropBps };
}

/** `minOut` for a given expected output and tolerance. The only figure the contract enforces. */
export function minOutFor(expectedOut: bigint, slippageBps: number): bigint {
  return (expectedOut * (10_000n - BigInt(slippageBps))) / 10_000n;
}
