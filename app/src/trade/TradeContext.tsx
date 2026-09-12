import { createContext, useCallback, useMemo, useState, type ReactNode } from "react";
import type { Address } from "viem";

import { addresses, tokenSymbols } from "../config/contracts";

/**
 * User intent, and nothing else.
 *
 * No `amountWei`, no `tradeKey`, no query keys. Everything derived from this — parsing, debouncing,
 * quoting — belongs to the query layer, where it can be cached and invalidated. Context that also
 * holds derived server-shaped values ends up with two copies of the truth and no way to refresh one
 * of them.
 *
 * Split into three contexts rather than one, because the split IS the re-render strategy: the
 * amount changes on every keystroke and the liquidity table is the most expensive thing on screen.
 * Because the table subscribes only to `TradePairContext`, a keystroke cannot schedule it. That is
 * structural — no `React.memo` is holding it up, and nobody can accidentally undo it by adding a
 * field to the wrong object.
 */

export type Direction = "AtoB" | "BtoA";

/** Both demo tokens are 18 decimals. One place to change when that stops being true. */
export const TOKEN_DECIMALS = 18;
export const DEFAULT_SLIPPAGE_BPS = 50;

export interface TokenInfo {
  address: Address;
  symbol: string;
  decimals: number;
}

function tokenInfo(address: string): TokenInfo {
  return {
    address: address as Address,
    symbol: tokenSymbols[address.toLowerCase() as keyof typeof tokenSymbols] ?? "TOKEN",
    decimals: TOKEN_DECIMALS,
  };
}

/** Every token this deployment knows about. The selector is built from this, not hardcoded. */
export const TOKENS: TokenInfo[] = [tokenInfo(addresses.tokenA), tokenInfo(addresses.tokenB)];

/** Stable for the lifetime of the app — safe to consume from anywhere without re-render cost. */
export interface TradeActions {
  setAmount: (next: string) => void;
  setSlippageBps: (next: number) => void;
  /** Swap the direction of the pair, preserving the amount. */
  reverse: () => void;
  selectToken: (side: "in" | "out", address: Address) => void;
}

/** Changes only when the user flips direction, picks a token, or edits slippage. */
export interface TradePair {
  tokenIn: TokenInfo;
  tokenOut: TokenInfo;
  direction: Direction;
  /**
   * Applies to `minTotalAmountOut` on settle, NOT to the solver's `maxSlippageBps`.
   * See the note in `useRouteQuote`. Shared by every quote consumer so the swap card and the
   * marketplace can never disagree about whether a trade is routable.
   */
  slippageBps: number;
}

/** Changes on every keystroke. The amount input is its only legitimate consumer. */
export interface TradeDraft {
  amount: string;
}

export const TradeActionsContext = createContext<TradeActions | null>(null);
export const TradePairContext = createContext<TradePair | null>(null);
export const TradeDraftContext = createContext<TradeDraft | null>(null);

export function TradeProvider({ children }: { children: ReactNode }) {
  const [amount, setAmountState] = useState("");
  const [direction, setDirection] = useState<Direction>("AtoB");
  const [slippageBps, setSlippageBpsState] = useState(DEFAULT_SLIPPAGE_BPS);
  const [override, setOverride] = useState<{ in?: Address; out?: Address }>({});

  const setAmount = useCallback((next: string) => {
    // Accept only a well-formed decimal, while still allowing the intermediate states real typing
    // produces ("", "0.", ".5"). Rejecting silently beats letting `parseUnits` see junk.
    if (next === "" || /^\d*\.?\d*$/.test(next)) setAmountState(next);
  }, []);

  const setSlippageBps = useCallback((next: number) => {
    setSlippageBpsState(Math.min(5000, Math.max(1, Math.round(next))));
  }, []);

  const reverse = useCallback(() => {
    setDirection((d) => (d === "AtoB" ? "BtoA" : "AtoB"));
    setOverride((o) => ({ in: o.out, out: o.in }));
  }, []);

  const selectToken = useCallback((side: "in" | "out", address: Address) => {
    setOverride((current) => {
      const other = side === "in" ? current.out : current.in;
      // Picking the token that is already on the other side swaps them rather than creating a
      // same-token pair the solver would reject.
      if (other && other.toLowerCase() === address.toLowerCase()) {
        return side === "in" ? { in: address, out: current.in } : { in: current.out, out: address };
      }
      return side === "in" ? { ...current, in: address } : { ...current, out: address };
    });
  }, []);

  const actions = useMemo<TradeActions>(
    () => ({ setAmount, setSlippageBps, reverse, selectToken }),
    [setAmount, setSlippageBps, reverse, selectToken]
  );

  const pair = useMemo<TradePair>(() => {
    const defaultIn = direction === "AtoB" ? addresses.tokenA : addresses.tokenB;
    const defaultOut = direction === "AtoB" ? addresses.tokenB : addresses.tokenA;
    return {
      tokenIn: tokenInfo(override.in ?? defaultIn),
      tokenOut: tokenInfo(override.out ?? defaultOut),
      direction,
      slippageBps,
    };
  }, [direction, slippageBps, override.in, override.out]);

  const draft = useMemo<TradeDraft>(() => ({ amount }), [amount]);

  return (
    <TradeActionsContext.Provider value={actions}>
      <TradePairContext.Provider value={pair}>
        <TradeDraftContext.Provider value={draft}>{children}</TradeDraftContext.Provider>
      </TradePairContext.Provider>
    </TradeActionsContext.Provider>
  );
}
