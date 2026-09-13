import { keepPreviousData, useQuery } from "@tanstack/react-query";
import { readContract } from "@wagmi/core";
import type { Address } from "viem";
import { useConfig } from "wagmi";

import { solverAbi } from "../abis/index.js";
import { useObservedBlock } from "../chain/ObservedBlockContext";
import { findRevert } from "./errors";
import { useAmountIntent, useTradePair } from "./useTrade";

export interface RouteLeg {
  venue: Address;
  amountIn: bigint;
  expectedAmountOut: bigint;
  spreadBps: number;
}

export interface ExecutionPlan {
  tokenIn: Address;
  tokenOut: Address;
  totalAmountIn: bigint;
  totalExpectedAmountOut: bigint;
  legs: readonly RouteLeg[];
}

/**
 * A route outcome. `no-route` is a RESULT, not an error.
 *
 * `Solver.route` reverts `NoRoute` when the market is too thin - an ordinary answer to an ordinary
 * question. Modelling it as a query failure cost three things: react-query retried a deterministic
 * revert with backoff on every settled keystroke; the `error` channel became ambiguous between "too
 * thin" and "the RPC is down", which is why an unreachable node rendered as a permanent spinner;
 * and the shortfall figure had to be re-derived client-side instead of read from the revert itself.
 */
export type RouteResult =
  | { kind: "routable"; plan: ExecutionPlan }
  | { kind: "no-route"; requested: bigint; totalExecutable: bigint }
  | { kind: "slippage"; expectedOut: bigint; minAcceptableOut: bigint };

/** Every distinguishable state of the quote, as the brief requires. */
export type QuoteStatus =
  | "idle"
  | "debouncing"
  | "quoting"
  | "routable"
  | "no-route"
  | "rpc-failure";

/**
 * The solver's own slippage check is pinned open rather than given the user's tolerance.
 *
 * `Solver.route` computes `minAcceptableOut = amount - amount * maxSlippageBps / 10000`, denominated
 * in `tokenIn`, and compares it against `totalExpectedOut`, denominated in `tokenOut`. That
 * comparison is only meaningful when the pair trades near 1:1 - at the demo pair's ~0.667 B→A price
 * any tolerance under ~33% makes a healthy market unroutable.
 *
 * Slippage is therefore enforced where it is correctly denominated: `minTotalAmountOut` on `settle`,
 * which the contract checks against realised output with both sides in `tokenOut`. See `useSwapFlow`.
 */
const ROUTE_CHECK_DISABLED_BPS = 10_000n;

export interface QuoteState {
  status: QuoteStatus;
  result: RouteResult | undefined;
  plan: ExecutionPlan | undefined;
  /** The displayed figures belong to an earlier amount - dim them, and refuse to sign them. */
  isStale: boolean;
  isFetching: boolean;
  error: unknown;
  refetch: () => void;
  /** Echoed back so consumers key their own derived values off the same amount. */
  amountWei: bigint | undefined;
}

export function useRouteQuote(): QuoteState {
  const config = useConfig();
  const pair = useTradePair();
  const intent = useAmountIntent(pair.tokenIn.decimals);
  const { block } = useObservedBlock();

  const query = useQuery<RouteResult>({
    queryKey: [
      "route",
      pair.solver,
      pair.tokenIn.address,
      pair.tokenOut.address,
      intent.amountWei?.toString() ?? "none",
      block?.toString() ?? "pending",
    ],
    enabled: intent.amountWei !== undefined,
    // Hold the previous answer while a new one loads so changing the amount never blanks the quote.
    // Consumers read `isStale` and dim instead - and the transaction state machine refuses to sign
    // while it is true, so a held-over figure can be shown but never committed.
    placeholderData: keepPreviousData,
    staleTime: Infinity,
    refetchInterval: false,
    // Only genuine transport failures reach here now, so retrying is meaningful again.
    retry: 1,
    queryFn: async (): Promise<RouteResult> => {
      const request = {
        tokenIn: pair.tokenIn.address,
        tokenOut: pair.tokenOut.address,
        amount: intent.amountWei!,
        maxSlippageBps: ROUTE_CHECK_DISABLED_BPS,
      };

      try {
        const plan = (await readContract(config, {
          address: pair.solver,
          abi: solverAbi,
          functionName: "route",
          args: [request],
        })) as unknown as ExecutionPlan;
        return { kind: "routable", plan };
      } catch (error) {
        const revert = findRevert(error);
        const name = revert?.data?.errorName;
        const args = (revert?.data?.args ?? []) as readonly unknown[];

        if (name === "NoRoute") {
          // The solver's own figure, from this call, at this block - rather than a client-side sum
          // of a different query that may have landed on a different block.
          return { kind: "no-route", requested: args[2] as bigint, totalExecutable: args[3] as bigint };
        }
        if (name === "SlippageExceeded") {
          return { kind: "slippage", expectedOut: args[0] as bigint, minAcceptableOut: args[1] as bigint };
        }
        throw error; // transport or decode failure - a real error
      }
    },
  });

  const isStale = query.isPlaceholderData || intent.isDebouncing;

  const status: QuoteStatus = (() => {
    if (intent.status === "invalid") return "idle";
    if (intent.amountWei === undefined) return intent.isDebouncing ? "debouncing" : "idle";
    if (intent.isDebouncing) return "debouncing";
    if (query.isError) return "rpc-failure";
    if (query.isLoading || query.data === undefined) return "quoting";
    if (query.isPlaceholderData) return "quoting";
    return query.data.kind === "routable" ? "routable" : "no-route";
  })();

  return {
    status,
    result: query.data,
    plan: query.data?.kind === "routable" ? query.data.plan : undefined,
    isStale,
    isFetching: query.isFetching,
    error: query.error,
    refetch: () => void query.refetch(),
    amountWei: intent.amountWei,
  };
}
