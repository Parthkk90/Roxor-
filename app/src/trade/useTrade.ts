import { useContext, useMemo } from "react";
import { parseUnits } from "viem";

import {
  TradeActionsContext,
  TradeDraftContext,
  TradePairContext,
  type TradeActions,
  type TradeDraft,
  type TradePair,
} from "./TradeContext";
import { useDebouncedValue } from "./useDebouncedValue";

/**
 * Narrow accessors, one per context.
 *
 * Subscribe to the least you need — that choice is what decides whether a keystroke re-renders your
 * component. Anything that does not render the amount *as the user types it* must use
 * `useAmountIntent()`, never `useTradeDraft()`.
 */

function required<T>(value: T | null, name: string): T {
  if (value === null) throw new Error(`${name} must be used inside <TradeProvider>`);
  return value;
}

export function useTradeActions(): TradeActions {
  return required(useContext(TradeActionsContext), "useTradeActions");
}

export function useTradePair(): TradePair {
  return required(useContext(TradePairContext), "useTradePair");
}

/** Per-keystroke. Only the amount field should call this. */
export function useTradeDraft(): TradeDraft {
  return required(useContext(TradeDraftContext), "useTradeDraft");
}

const DEBOUNCE_MS = 400;
const isBlank = (v: string) => v.trim() === "";

export type AmountStatus = "idle" | "debouncing" | "invalid" | "ready";

export interface AmountIntent {
  /** Settled, debounced decimal string. The only value a query key may be built from. */
  settled: string;
  /** `undefined` when empty, zero, or unparseable — all of which mean "nothing to quote". */
  amountWei: bigint | undefined;
  status: AmountStatus;
  /** True while the field is ahead of the settled value, so the UI can dim a stale quote. */
  isDebouncing: boolean;
}

/**
 * The amount, parsed and debounced — derived here rather than stored in context.
 *
 * The debounce sits between the input and the *query parameter*, never on the input state itself:
 * `TradeDraftContext` updates on every keystroke so typing is never laggy, and only the value that
 * feeds a network read waits. The previous build ran a separate hidden timer inside each caller of
 * `useRouteQuote`, over each caller's private copy of the amount, which is how the two panels
 * drifted apart in the first place.
 */
export function useAmountIntent(decimals: number): AmountIntent {
  const { amount } = useTradeDraft();
  const settled = useDebouncedValue(amount, DEBOUNCE_MS, isBlank);

  return useMemo(() => {
    const isDebouncing = settled !== amount;

    if (isBlank(settled)) {
      return { settled, amountWei: undefined, status: isDebouncing ? "debouncing" : "idle", isDebouncing };
    }

    let amountWei: bigint | undefined;
    let invalid = false;
    try {
      const parsed = parseUnits(settled, decimals);
      amountWei = parsed > 0n ? parsed : undefined;
    } catch {
      invalid = true;
    }

    const status: AmountStatus = invalid
      ? "invalid"
      : isDebouncing
        ? "debouncing"
        : amountWei === undefined
          ? "idle"
          : "ready";

    return { settled, amountWei, status, isDebouncing };
  }, [settled, amount, decimals]);
}
