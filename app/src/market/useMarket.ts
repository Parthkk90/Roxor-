import { useMemo } from "react";
import { keepPreviousData } from "@tanstack/react-query";
import { useReadContracts } from "wagmi";
import type { Address } from "viem";

import { aquaVenueAbi } from "../abis/index.js";
import { useObservedBlock } from "../chain/ObservedBlockContext";
import { useReliability } from "./useReliability";
import {
  toStrategyMode,
  type ExecutableLiquidity,
  type LiquiditySource,
  type VenueSnapshot,
} from "./types";

/**
 * `snapshot` and `executableLiquidity` have identical signatures on every `ILiquidityVenue`
 * implementation, so one ABI decodes both venues. Every market has its own pair of venues - this
 * is not a fixed constant, it's built from whichever market the caller passes in.
 */
function venuesFor(aquaVenue: Address, uniswapV4Venue: Address) {
  return [
    { key: "aqua", name: "Aqua maker", venueKind: "Aqua / SwapVM", address: aquaVenue },
    { key: "uniswap-v4", name: "Uniswap v4", venueKind: "v4 pool", address: uniswapV4Venue },
  ] as const;
}

type RawResult = { status: "success"; result: unknown } | { status: "failure"; error: Error };

function toSnapshot(raw: RawResult | undefined): VenueSnapshot | undefined {
  if (raw?.status !== "success") return undefined;
  const s = raw.result as {
    venue: Address;
    strategyId: `0x${string}`;
    mode: number;
    effectiveLiquidity: bigint;
    spreadBps: number;
    referencePrice: bigint;
    coverageBps: number;
  };
  return { ...s, mode: toStrategyMode(Number(s.mode)) };
}

function toExecutable(raw: RawResult | undefined): ExecutableLiquidity | undefined {
  if (raw?.status !== "success") return undefined;
  return raw.result as ExecutableLiquidity;
}

/**
 * Every venue's live state for one direction, read in a single multicall so the whole table - and
 * the executability verdict derived from it - comes from one block.
 *
 * This replaced four independent 5s polls. The gain that matters is not fewer requests: it is that
 * the route and the depth it is checked against can no longer come from different blocks.
 */
export function useMarket(tokenIn: Address, tokenOut: Address, aquaVenue: Address, uniswapV4Venue: Address) {
  const { block } = useObservedBlock();
  const venues = useMemo(() => venuesFor(aquaVenue, uniswapV4Venue), [aquaVenue, uniswapV4Venue]);

  const contracts = useMemo(
    () =>
      venues.flatMap((venue) => [
        { address: venue.address, abi: aquaVenueAbi, functionName: "snapshot", args: [tokenIn, tokenOut] } as const,
        {
          address: venue.address,
          abi: aquaVenueAbi,
          functionName: "executableLiquidity",
          args: [tokenIn, tokenOut],
        } as const,
      ]),
    [venues, tokenIn, tokenOut]
  );

  const { data, isLoading, isError, error, refetch, isPlaceholderData } = useReadContracts({
    contracts,
    // One misbehaving venue must not blank the entire marketplace. Per-call status lets each row
    // report its own availability instead of taking the table down with it.
    allowFailure: true,
    // `scopeKey` - NOT `query.queryKey`, which wagmi excludes by type
    // (`QueryParameter` = `UnionLooseOmit<QueryOptions, "queryKey" | "queryFn">`). wagmi folds this
    // string into the key it generates, which is the supported way to make a read depend on
    // something that is not one of its own arguments.
    scopeKey: block?.toString() ?? "pending",
    query: {
      // Advancing the block mints a *new* key, so without this the table would empty for one
      // round-trip on every block. Consumers read `isPlaceholderData` and dim instead.
      placeholderData: keepPreviousData,
      // Refetching is driven entirely by the observed block, not by a timer of its own.
      refetchInterval: false,
      staleTime: Infinity,
    },
  });

  const strategyIds = useMemo(
    () => venues.map((_, i) => toSnapshot(data?.[i * 2] as RawResult | undefined)?.strategyId),
    [venues, data]
  );
  const reliability = useReliability(strategyIds);

  const sources = useMemo<LiquiditySource[]>(
    () =>
      venues.map((venue, i) => {
        const snapshot = toSnapshot(data?.[i * 2] as RawResult | undefined);
        const executable = toExecutable(data?.[i * 2 + 1] as RawResult | undefined);
        const loaded = data !== undefined;

        return {
          key: venue.key,
          name: venue.name,
          venueKind: venue.venueKind,
          address: venue.address,
          // Unavailable means "we asked and could not get an answer" - never "we have not asked
          // yet". Distinguishing the two is what stops a dead RPC reading as a permanent spinner.
          unavailable: loaded && (snapshot === undefined || executable === undefined),
          snapshot,
          executable,
          reliabilityBps: snapshot ? reliability[snapshot.strategyId.toLowerCase()] : undefined,
        };
      }),
    [venues, data, reliability]
  );

  const totalExecutable = useMemo(
    () => sources.reduce((sum, s) => sum + (s.executable?.conditionalLiquidity ?? 0n), 0n),
    [sources]
  );

  /**
   * The market's posture is the WORST regime among available sources, not an average. One maker
   * going defensive is exactly the signal a trader needs; averaging it away would hide it.
   */
  const regime = useMemo(() => {
    const severity = { NORMAL: 0, RECOVERY: 1, DEFENSIVE: 2 } as const;
    return sources.reduce<"NORMAL" | "DEFENSIVE" | "RECOVERY">((worst, s) => {
      const mode = s.snapshot?.mode;
      return mode && severity[mode] > severity[worst] ? mode : worst;
    }, "NORMAL");
  }, [sources]);

  return {
    sources,
    totalExecutable,
    regime,
    block,
    isLoading: isLoading && data === undefined,
    isError,
    error,
    isPlaceholderData,
    refetch,
  };
}
