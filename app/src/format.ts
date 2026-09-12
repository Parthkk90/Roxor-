import { formatUnits } from "viem";

/** Both demo tokens are 18 decimals; centralised so it is one change when that stops being true. */
export const DISPLAY_DECIMALS = 18;

/** Token amount for display. `undefined` renders as an em dash, never as `0` — they mean different things. */
export function fmt(amount: bigint | undefined, precision = 3): string {
  if (amount === undefined) return "—";
  return Number(formatUnits(amount, DISPLAY_DECIMALS)).toFixed(precision);
}
