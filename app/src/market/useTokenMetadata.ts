import { useMemo } from "react";
import { useReadContracts } from "wagmi";
import type { Address } from "viem";

import { mockERC20Abi } from "../abis/index.js";
import { marketTokenAddresses } from "../config/markets";

export interface TokenMetadata {
  symbol: string;
  decimals: number;
}

/** Never assigned silently - a token this build cannot read metadata for says so, not "DTA". */
export const UNKNOWN_TOKEN: TokenMetadata = { symbol: "Unknown token", decimals: 18 };

/**
 * `symbol()`/`decimals()`, read from chain for every token this deployment's markets reference -
 * never a hardcoded `address -> symbol` map. Token metadata is immutable once deployed, so this is
 * one multicall, cached forever; there is nothing to invalidate on a new block.
 */
export function useTokenMetadataMap(): { data: Record<string, TokenMetadata>; isLoading: boolean } {
  const contracts = useMemo(
    () =>
      marketTokenAddresses.flatMap((address) => [
        { address, abi: mockERC20Abi, functionName: "symbol" } as const,
        { address, abi: mockERC20Abi, functionName: "decimals" } as const,
      ]),
    []
  );

  const { data, isLoading } = useReadContracts({
    contracts,
    allowFailure: true,
    query: { staleTime: Infinity, refetchInterval: false },
  });

  const map = useMemo(() => {
    const out: Record<string, TokenMetadata> = {};
    marketTokenAddresses.forEach((address, i) => {
      const symbolResult = data?.[i * 2];
      const decimalsResult = data?.[i * 2 + 1];
      out[address.toLowerCase()] = {
        symbol: symbolResult?.status === "success" ? (symbolResult.result as string) : UNKNOWN_TOKEN.symbol,
        decimals: decimalsResult?.status === "success" ? Number(decimalsResult.result) : UNKNOWN_TOKEN.decimals,
      };
    });
    return out;
  }, [data]);

  return { data: map, isLoading: isLoading && data === undefined };
}

export function tokenMetaOf(map: Record<string, TokenMetadata>, address: Address): TokenMetadata {
  return map[address.toLowerCase()] ?? UNKNOWN_TOKEN;
}
