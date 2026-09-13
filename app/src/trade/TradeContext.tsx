import { createContext, useCallback, useMemo, useState, type ReactNode } from "react";
import type { Address } from "viem";

import { markets, type MarketAddresses } from "../config/markets";
import { tokenMetaOf, useTokenMetadataMap } from "../market/useTokenMetadata";

/**
 * User intent, and nothing else.
 *
 * No `amountWei`, no `tradeKey`, no query keys. Everything derived from this - parsing, debouncing,
 * quoting - belongs to the query layer, where it can be cached and invalidated. Context that also
 * holds derived server-shaped values ends up with two copies of the truth and no way to refresh one
 * of them.
 *
 * Split into three contexts rather than one, because the split IS the re-render strategy: the
 * amount changes on every keystroke and the liquidity table is the most expensive thing on screen.
 * Because the table subscribes only to `TradePairContext`, a keystroke cannot schedule it. That is
 * structural - no `React.memo` is holding it up, and nobody can accidentally undo it by adding a
 * field to the wrong object.
 */

export type Direction = "AtoB" | "BtoA";

export const DEFAULT_SLIPPAGE_BPS = 50;

export interface TokenInfo {
  address: Address;
  symbol: string;
  decimals: number;
}

/** Stable for the lifetime of the app - safe to consume from anywhere without re-render cost. */
export interface TradeActions {
  setAmount: (next: string) => void;
  setSlippageBps: (next: number) => void;
  /** Swap the direction of the current market's pair, preserving the amount. */
  reverse: () => void;
  /** Switch to a different deployed market - see `config/markets.ts`. */
  selectMarket: (index: number) => void;
}

/**
 * Changes only when the user flips direction, picks a market, or edits slippage.
 *
 * A pair is no longer two freely combinable tokens: each market has its own `Solver` (see
 * `Solver.sol` - it snapshots every venue it holds unconditionally, so one Solver serves exactly
 * one pair), so `tokenIn`/`tokenOut` are always the current market's own two tokens, and `solver`/
 * `market` travel with them so every consumer reads the same market's contracts.
 */
export interface TradePair {
  tokenIn: TokenInfo;
  tokenOut: TokenInfo;
  direction: Direction;
  marketIndex: number;
  /** The selected market's deployed addresses (solver, venues, oracles, strategy ids). */
  market: MarketAddresses;
  solver: Address;
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
  const [marketIndex, setMarketIndex] = useState(0);
  const { data: tokenMeta } = useTokenMetadataMap();

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
  }, []);

  const selectMarket = useCallback((index: number) => {
    if (index < 0 || index >= markets.length) return;
    setMarketIndex(index);
    setDirection("AtoB");
  }, []);

  const actions = useMemo<TradeActions>(
    () => ({ setAmount, setSlippageBps, reverse, selectMarket }),
    [setAmount, setSlippageBps, reverse, selectMarket]
  );

  const pair = useMemo<TradePair>(() => {
    const market = markets[marketIndex] ?? markets[0]!;
    const [inAddr, outAddr] = direction === "AtoB" ? [market.tokenIn, market.tokenOut] : [market.tokenOut, market.tokenIn];
    const toTokenInfo = (address: Address): TokenInfo => {
      const meta = tokenMetaOf(tokenMeta, address);
      return { address, symbol: meta.symbol, decimals: meta.decimals };
    };
    return {
      tokenIn: toTokenInfo(inAddr),
      tokenOut: toTokenInfo(outAddr),
      direction,
      marketIndex,
      market,
      solver: market.solver,
      slippageBps,
    };
  }, [direction, marketIndex, slippageBps, tokenMeta]);

  const draft = useMemo<TradeDraft>(() => ({ amount }), [amount]);

  return (
    <TradeActionsContext.Provider value={actions}>
      <TradePairContext.Provider value={pair}>
        <TradeDraftContext.Provider value={draft}>{children}</TradeDraftContext.Provider>
      </TradePairContext.Provider>
    </TradeActionsContext.Provider>
  );
}
