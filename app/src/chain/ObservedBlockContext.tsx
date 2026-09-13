import { createContext, useCallback, useContext, useEffect, useMemo, useState, type ReactNode } from "react";
import { useBlockNumber } from "wagmi";

/**
 * The single clock the whole app reads against.
 *
 * Every on-chain read keys on this value, which buys two things that separate per-hook polling
 * cannot:
 *
 * 1. **Coherence.** The sources table, the route, and the executability verdict are all derived
 *    from the same block. Previously they came from three independent 5s polls landing on three
 *    different blocks, so the "NO PHANTOM LIQUIDITY - PASS" banner could compare a route computed
 *    at block N against depth summed at block N-1. For the one claim this product exists to make,
 *    that is not acceptable.
 *
 * 2. **Causal refresh.** After a swap confirms we call `advanceTo(receipt.blockNumber)`, which
 *    changes every key and refetches at or after the block containing the trade. A plain
 *    `invalidateQueries` can be served by a node that has not seen that block yet and would happily
 *    return pre-trade depth; keying on the block makes stale data unrepresentable, because the old
 *    key is no longer mounted.
 *
 * The block is a cache-busting token, NOT a call parameter: reads still target `latest`. Passing a
 * historical `blockNumber` to `eth_call` would make the app depend on archive nodes, which public
 * RPCs prune and rate-limit. The window where `latest` has moved past our token is one poll and
 * self-corrects.
 */
interface ObservedBlock {
  block: bigint | undefined;
  /** Move the clock forward immediately (never backward) - used when a receipt confirms. */
  advanceTo: (block: bigint) => void;
}

const ObservedBlockContext = createContext<ObservedBlock | null>(null);

export function ObservedBlockProvider({ children }: { children: ReactNode }) {
  const [observed, setObserved] = useState<bigint | undefined>(undefined);

  // The app's only poll. Everything else is a pure function of the value it produces.
  const { data: latest } = useBlockNumber({ watch: true, query: { refetchInterval: 5000 } });

  const advanceTo = useCallback((next: bigint) => {
    setObserved((current) => (current === undefined || next > current ? next : current));
  }, []);

  useEffect(() => {
    if (latest !== undefined) advanceTo(latest);
  }, [latest, advanceTo]);

  const value = useMemo<ObservedBlock>(() => ({ block: observed, advanceTo }), [observed, advanceTo]);

  return <ObservedBlockContext.Provider value={value}>{children}</ObservedBlockContext.Provider>;
}

export function useObservedBlock(): ObservedBlock {
  const context = useContext(ObservedBlockContext);
  if (context === null) {
    throw new Error("useObservedBlock must be used inside <ObservedBlockProvider>");
  }
  return context;
}
