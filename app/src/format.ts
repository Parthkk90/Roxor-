import { formatUnits } from "viem";

/**
 * Token amounts, formatted the way a person reads them.
 *
 * `decimals` is a REQUIRED argument, deliberately. The previous signature defaulted it to 18, so
 * every call site silently inherited that default and nothing broke while every configured token
 * happened to be 18-decimal - a six-decimal token would have rendered a million times too large
 * with no error anywhere. Making it required means the compiler, not a reviewer, finds the call
 * sites that do not know their token.
 *
 * Precision adapts to magnitude, because one fixed precision cannot serve both ends of a token's
 * range: three decimals turns 0.0004 into "0.000", and four decimals on a balance of 340 billion
 * produces a number nobody can read. The rules below are chosen so that the significant digits are
 * always visible and the string is always countable at a glance.
 */

/** What a component needs to render an amount correctly. Symbols alone are not enough. */
export interface TokenDisplay {
  symbol: string;
  decimals: number;
}

/** An amount that could not be read. Never `0` - they mean different things. */
export const NO_VALUE = "-";

const COMPACT = [
  { at: 1e12, suffix: "T" },
  { at: 1e9, suffix: "B" },
  { at: 1e6, suffix: "M" },
] as const;

/**
 * Past a thousand trillion, suffixes stop helping: a mock token minted at `type(uint128).max` sits
 * around 3.4e20, and "340282366.92T" is no more readable than the raw digits were. Exponent
 * notation states the magnitude honestly and stops there.
 */
const EXPONENT_ABOVE = 1e15;

/** Trailing zeros carry no information and cost horizontal space: 1.2000 -> 1.2, 5.00 -> 5. */
function trim(value: string): string {
  return value.includes(".") ? value.replace(/\.?0+$/, "") : value;
}

function group(value: string): string {
  const [whole, fraction] = value.split(".");
  const grouped = whole!.replace(/\B(?=(\d{3})+(?!\d))/g, ",");
  return fraction === undefined ? grouped : `${grouped}.${fraction}`;
}

/**
 * Format a raw token amount for display.
 *
 * @param amount    Raw base units, as the chain reports them.
 * @param decimals  The token's own `decimals()`, read from chain.
 * @param maxFractionDigits Optional ceiling, for places where column width is tight.
 */
export function fmt(amount: bigint | undefined, decimals: number, maxFractionDigits?: number): string {
  if (amount === undefined) return NO_VALUE;
  if (amount === 0n) return "0";

  const exact = formatUnits(amount, decimals);
  const n = Number(exact);
  const magnitude = Math.abs(n);

  if (magnitude >= EXPONENT_ABOVE) return n.toExponential(2).replace("e+", "e");

  // Above a million, the exact tail is noise - nobody reads the last twelve digits of a balance.
  // Compact notation keeps the order of magnitude, which is the only part that is still meaningful.
  for (const { at, suffix } of COMPACT) {
    if (magnitude >= at) return `${trim((n / at).toFixed(2))}${suffix}`;
  }

  // Below a millionth the exact value is unrenderable at any sane width, but it is NOT zero, and
  // saying "0" would claim a source is empty when it is merely tiny.
  if (magnitude > 0 && magnitude < 1e-6) return "<0.000001";

  const auto = magnitude >= 1000 ? 2 : magnitude >= 1 ? 4 : 6;
  const digits = maxFractionDigits === undefined ? auto : Math.min(auto, maxFractionDigits);
  return group(trim(n.toFixed(digits)));
}

/** `fmt` with the symbol appended, for the many places that render exactly that pair. */
export function fmtToken(amount: bigint | undefined, token: TokenDisplay, maxFractionDigits?: number): string {
  return `${fmt(amount, token.decimals, maxFractionDigits)} ${token.symbol}`;
}

/**
 * An exchange rate, in `out` units per one `in` unit.
 *
 * Computed from the two raw amounts and both tokens' decimals rather than by dividing the raw
 * bigints - that shortcut only produces the right number when both sides happen to share a decimal
 * count, which is an assumption the UI has no business making about a pair it reads from chain.
 */
export function fmtRate(
  amountIn: bigint | undefined,
  amountOut: bigint | undefined,
  tokenIn: TokenDisplay,
  tokenOut: TokenDisplay
): string {
  if (amountIn === undefined || amountOut === undefined || amountIn === 0n) return NO_VALUE;
  const rate = Number(formatUnits(amountOut, tokenOut.decimals)) / Number(formatUnits(amountIn, tokenIn.decimals));
  if (!Number.isFinite(rate) || rate === 0) return NO_VALUE;
  const digits = rate >= 1000 ? 2 : rate >= 1 ? 4 : 6;
  return group(trim(rate.toFixed(digits)));
}

/** Basis points as a percentage: 2500 -> "25%", 20 -> "0.2%". */
export function fmtBps(bps: number | undefined, maxFractionDigits = 2): string {
  if (bps === undefined) return NO_VALUE;
  return `${trim((bps / 100).toFixed(maxFractionDigits))}%`;
}

/** Seconds as the shortest exact phrase a person would say. */
export function fmtDuration(seconds: number): string {
  if (seconds <= 0) return "immediately";
  for (const [unit, size] of [["hour", 3600], ["minute", 60]] as const) {
    if (seconds % size === 0) {
      const n = seconds / size;
      return `${n} ${unit}${n === 1 ? "" : "s"}`;
    }
  }
  if (seconds < 60) return `${seconds} second${seconds === 1 ? "" : "s"}`;
  const minutes = Math.floor(seconds / 60);
  return `${minutes}m ${seconds % 60}s`;
}
