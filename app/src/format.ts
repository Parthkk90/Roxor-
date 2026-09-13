import { formatUnits } from "viem";

/**
 * Default decimals for amounts formatted without a specific token in hand. Every token this build
 * currently configures happens to be 18 decimals (see `config/markets.ts` and its note on why -
 * `Solver`'s slippage check assumes matched decimals), but callers that DO know their token should
 * pass its real `decimals`, read from chain, rather than rely on this default.
 */
export const DISPLAY_DECIMALS = 18;

/** Token amount for display. `undefined` renders as an em dash, never as `0` - they mean different things. */
export function fmt(amount: bigint | undefined, precision = 3, decimals = DISPLAY_DECIMALS): string {
  if (amount === undefined) return "-";
  return Number(formatUnits(amount, decimals)).toFixed(precision);
}
