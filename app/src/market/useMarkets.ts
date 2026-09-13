import { useMemo } from "react";
import type { Address } from "viem";

import { markets, type MarketAddresses } from "../config/markets";
import { useMarket } from "./useMarket";
import { tokenMetaOf, useTokenMetadataMap } from "./useTokenMetadata";

/** The normalized shape both the Marketplace and the SwapCard read - never a second copy. */
export interface Market {
  label: string;
  tokenIn: Address;
  tokenOut: Address;
  tokenInSymbol: string;
  tokenOutSymbol: string;
  tokenInDecimals: number;
  tokenOutDecimals: number;
  venues: Address[];
  /** The raw deployed addresses (solver, oracles, strategy ids) this market resolves to. */
  raw: MarketAddresses;
}

/** Every configured market, with symbols/decimals resolved from chain metadata. */
export function useMarketList(): Market[] {
  const { data: tokenMeta } = useTokenMetadataMap();

  return useMemo(
    () =>
      markets.map((raw) => {
        const tokenInMeta = tokenMetaOf(tokenMeta, raw.tokenIn);
        const tokenOutMeta = tokenMetaOf(tokenMeta, raw.tokenOut);
        return {
          label: raw.label,
          tokenIn: raw.tokenIn,
          tokenOut: raw.tokenOut,
          tokenInSymbol: tokenInMeta.symbol,
          tokenOutSymbol: tokenOutMeta.symbol,
          tokenInDecimals: tokenInMeta.decimals,
          tokenOutDecimals: tokenOutMeta.decimals,
          venues: [raw.aquaVenue, raw.uniswapV4Venue],
          raw,
        };
      }),
    [tokenMeta]
  );
}

/** One market's live liquidity, for a single row of the marketplace overview. */
export function useMarketLiquidity(market: MarketAddresses) {
  return useMarket(market.tokenIn, market.tokenOut, market.aquaVenue, market.uniswapV4Venue);
}
