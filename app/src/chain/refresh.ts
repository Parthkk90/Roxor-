import { useCallback } from "react";
import { useQueryClient } from "@tanstack/react-query";

import { useObservedBlock } from "./ObservedBlockContext";

/**
 * Causal refresh after the user's own transaction confirms.
 *
 * Two mechanisms, because neither is sufficient alone.
 *
 * 1. **Advance the clock.** Every chain read carries the observed block in its key (via wagmi's
 *    `scopeKey`, or directly for the hand-rolled route query). Moving the clock to the receipt's
 *    block mints new keys, so the pre-trade entries are no longer mounted and cannot be displayed
 *    at all. This is the part that makes staleness *unrepresentable* rather than merely unlikely.
 *
 * 2. **Invalidate the affected families.** Belt and braces for anything not block-scoped - the
 *    subgraph-backed activity and reliability queries - and it forces an immediate refetch rather
 *    than waiting for the next poll.
 *
 * Invalidation alone would not be enough: `invalidateQueries` refetches straight away, and on a
 * load-balanced RPC the node serving that refetch may not have seen the receipt's block yet. It
 * would happily return pre-trade depth, and the UI would look as though the swap never happened.
 * Keying on the block is what stops that from being representable.
 *
 * These are wagmi's real generated key prefixes - `['readContract', {...}]`, `['balance', {...}]`
 * and so on. wagmi builds them itself and does not accept a caller-supplied `queryKey`, so matching
 * by prefix is the supported way to address them in bulk.
 */
export function useSettlementRefresh() {
  const queryClient = useQueryClient();
  const { advanceTo } = useObservedBlock();

  return useCallback(
    (blockNumber: bigint | undefined) => {
      // Order matters: move the clock first so the refetches triggered below are issued against
      // the new keys rather than re-populating the ones we are about to abandon.
      if (blockNumber !== undefined) advanceTo(blockNumber);

      const families = [
        // token balances + solver allowance (erc20 reads go through useReadContract)
        ["readContract"],
        ["readContracts"], // venue snapshots + executableLiquidity, read as one multicall
        ["balance"],
        ["route"], // the hand-rolled route quote
        ["activity"], // subgraph: recent swaps + route executions
        ["reliability"], // subgraph: maker fill history
      ];

      for (const queryKey of families) {
        void queryClient.invalidateQueries({ queryKey, exact: false });
      }
    },
    [queryClient, advanceTo]
  );
}
