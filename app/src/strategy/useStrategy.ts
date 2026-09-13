import { useMemo } from "react";
import { keepPreviousData } from "@tanstack/react-query";
import { useBlock, useReadContracts } from "wagmi";
import { zeroAddress, type Address } from "viem";

import {
  aquaVenueAbi,
  conditionalLiquidityEngineAbi,
  conditionalLiquidityRegistryAbi,
  mockMarketStateProviderAbi,
} from "../abis/index.js";
import { useObservedBlock } from "../chain/ObservedBlockContext";
import { toStrategyMode, type ExecutableLiquidity, type StrategyMode } from "../market/types";
import type { MarketAddresses } from "../config/markets";
import { decodeProgram, recoveryRequirement, type DecodedProgram } from "./decode";

/**
 * Everything the strategy screen shows about one live strategy, read from chain in one multicall.
 *
 * Nothing here is computed from parameters the UI happens to remember. The registry, the engine and
 * the market-state provider are the only sources: the regime comes from `ENGINE.preview` (a live
 * re-evaluation of the deployed rule program, not last-committed state), the thresholds come from
 * decoding `REGISTRY.getRuleProgram`, and the recovery clock comes from `RuntimeState.armedSince` -
 * the timestamp the *engine* recorded when the duration-gated rule first evaluated true.
 *
 * The registry and engine addresses are read off the venue's own immutables rather than configured,
 * so they cannot drift from the venue the marketplace is actually quoting.
 */
export interface LiveStrategy {
  strategyId: `0x${string}`;
  maker: Address;
  registry: Address;
  engine: Address;
  /** As registered; the multiplier in force right now is `liquidityBps`. */
  baseLiquidityBps: number;
  baseSpreadBps: number;
  active: boolean;
  createdAt: number;

  /** Freshly re-evaluated by the engine, never last-committed. */
  mode: StrategyMode;
  liquidityBps: number;
  spreadBps: number;

  /** Last committed transition, and the duration-gated rule currently counting down (0 = none). */
  lastTransition: number;
  armedRule: number;
  armedSince: number;
  transitionCount: number;

  /** What the oracle is currently telling the engine. */
  market?: { price: bigint; volatilityBps: number; oracleConfidenceBps: number; timestamp: number };

  program?: DecodedProgram;
  /** `undefined` when the program has no duration-gated volatility rule. */
  recovery?: { thresholdBps: number; seconds: number };

  executable?: ExecutableLiquidity;
}

type Raw = { status: "success"; result: unknown } | { status: "failure"; error: Error } | undefined;
const ok = <T,>(raw: Raw): T | undefined => (raw?.status === "success" ? (raw.result as T) : undefined);

export function useStrategy(market: MarketAddresses) {
  const { block } = useObservedBlock();
  const venue = market.aquaVenue;
  const strategyId = market.aquaStrategyId;

  // Step one: the venue tells us which registry and engine it is bound to.
  const wiring = useReadContracts({
    contracts: [
      { address: venue, abi: aquaVenueAbi, functionName: "REGISTRY" },
      { address: venue, abi: aquaVenueAbi, functionName: "ENGINE" },
    ] as const,
    allowFailure: true,
    query: { staleTime: Infinity, refetchInterval: false },
  });
  const registry = ok<Address>(wiring.data?.[0] as Raw);
  const engine = ok<Address>(wiring.data?.[1] as Raw);

  // Built unconditionally so wagmi can infer one stable tuple type; the query itself is disabled
  // until the venue has told us its registry and engine, so the placeholder addresses are never
  // actually called.
  const contracts = useMemo(() => {
    const registryAddress = registry ?? zeroAddress;
    const engineAddress = engine ?? zeroAddress;
    return [
      { address: registryAddress, abi: conditionalLiquidityRegistryAbi, functionName: "getStrategy", args: [strategyId] },
      { address: registryAddress, abi: conditionalLiquidityRegistryAbi, functionName: "getStrategyState", args: [strategyId] },
      { address: registryAddress, abi: conditionalLiquidityRegistryAbi, functionName: "getRuleProgram", args: [strategyId] },
      { address: engineAddress, abi: conditionalLiquidityEngineAbi, functionName: "preview", args: [strategyId] },
      { address: market.aquaOracle, abi: mockMarketStateProviderAbi, functionName: "getMarketState", args: [strategyId] },
      { address: venue, abi: aquaVenueAbi, functionName: "executableLiquidity", args: [market.tokenIn, market.tokenOut] },
    ] as const;
  }, [registry, engine, strategyId, market.aquaOracle, market.tokenIn, market.tokenOut, venue]);

  const { data, isLoading, refetch } = useReadContracts({
    contracts,
    allowFailure: true,
    scopeKey: block?.toString() ?? "pending",
    query: {
      enabled: registry !== undefined && engine !== undefined,
      placeholderData: keepPreviousData,
      refetchInterval: false,
      staleTime: Infinity,
    },
  });

  const strategy = useMemo<LiveStrategy | undefined>(() => {
    if (!registry || !engine || !data) return undefined;
    const definition = ok<{
      maker: Address;
      baseLiquidityBps: number;
      baseSpreadBps: number;
      active: boolean;
      createdAt: bigint;
    }>(data[0] as Raw);
    const preview = ok<readonly [{ lastTransition: bigint; armedRule: number; armedSince: bigint; transitionCount: bigint }, { liquidityBps: number; spreadBps: number; mode: number }]>(data[3] as Raw);
    if (!definition || !preview) return undefined;

    const [runtime, config] = preview;
    const rawProgram = ok<`0x${string}`>(data[2] as Raw);
    let program: DecodedProgram | undefined;
    try {
      program = rawProgram ? decodeProgram(rawProgram) : undefined;
    } catch {
      // A program this build cannot decode is reported as absent rather than as a wrong guess.
      program = undefined;
    }
    const marketState = ok<{ price: bigint; volatility: bigint; oracleConfidence: bigint; timestamp: bigint }>(data[4] as Raw);

    return {
      strategyId,
      maker: definition.maker,
      registry,
      engine,
      baseLiquidityBps: definition.baseLiquidityBps,
      baseSpreadBps: definition.baseSpreadBps,
      active: definition.active,
      createdAt: Number(definition.createdAt),
      mode: toStrategyMode(Number(config.mode)),
      liquidityBps: config.liquidityBps,
      spreadBps: config.spreadBps,
      lastTransition: Number(runtime.lastTransition),
      armedRule: Number(runtime.armedRule),
      armedSince: Number(runtime.armedSince),
      transitionCount: Number(runtime.transitionCount),
      market: marketState && {
        price: marketState.price,
        volatilityBps: Number(marketState.volatility),
        oracleConfidenceBps: Number(marketState.oracleConfidence),
        timestamp: Number(marketState.timestamp),
      },
      program,
      recovery: program ? recoveryRequirement(program) : undefined,
      executable: ok<ExecutableLiquidity>(data[5] as Raw),
    };
  }, [registry, engine, data, strategyId]);

  return { strategy, isLoading: isLoading && !strategy, refetch };
}

/**
 * The clock the recovery gate is actually judged against: the chain's own block timestamp.
 *
 * Not `Date.now()`. `armedSince` is a chain timestamp and `RuleEngineLib` compares it to
 * `block.timestamp`, so a browser clock that is a minute fast would show the gate as satisfied
 * while the engine still refuses to move. It also keeps the timer honest when a viewer's machine
 * has drifted, and - as a side effect - makes the progress bar advance with the app's existing
 * block poll rather than needing a render-time impurity to move at all.
 */
export function useChainNow(): number | undefined {
  const { block } = useObservedBlock();
  const { data } = useBlock({
    blockNumber: block,
    query: { enabled: block !== undefined, staleTime: Infinity, refetchInterval: false },
  });
  return data ? Number(data.timestamp) : undefined;
}

/**
 * How far through its calm gate a strategy is, at `now`.
 *
 * `armedSince` is the only honest input: the engine sets it when the duration-gated rule *first*
 * evaluated true and clears it the moment the condition lapses, so a strategy that never had
 * sustained calm has no progress to show rather than a bar that creeps up regardless.
 */
export function recoveryProgress(
  strategy: LiveStrategy,
  nowSeconds: number
): { elapsed: number; required: number; remaining: number } | undefined {
  if (strategy.armedRule === 0 || strategy.armedSince === 0 || !strategy.recovery) return undefined;
  const required = strategy.recovery.seconds;
  const elapsed = Math.max(0, nowSeconds - strategy.armedSince);
  return { elapsed, required, remaining: Math.max(0, required - elapsed) };
}
