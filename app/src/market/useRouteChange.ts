import { useEffect, useRef, useState } from "react";

import type { SourceAllocation } from "./derive";

export interface AllocationShift {
  name: string;
  fromPct: number;
  toPct: number;
}

export interface RouteChange {
  id: number;
  shifts: AllocationShift[];
}

/**
 * Notice when the solver re-splits an order, and say what moved.
 *
 * This exists for the moment the product is actually about: volatility rises, a strategy goes
 * defensive, its executable depth collapses and the route shifts to the other source. Without
 * something watching for it, that happens silently between two renders and the user has to have
 * been staring at the right two numbers to catch it.
 *
 * Only a *material* reshuffle counts. Allocations drift by fractions of a percent between blocks as
 * prices move, and announcing those would train people to ignore the banner by the time a real
 * shift arrives.
 *
 * The amount is part of the identity: changing your own order size re-splits the route for an
 * obvious reason and must not be reported as the market moving under you.
 */
const MATERIAL_SHIFT_PCT = 5;

export function useRouteChange(
  allocations: SourceAllocation[],
  amountWei: bigint | undefined
): RouteChange | null {
  const previous = useRef<Map<string, number> | null>(null);
  const previousAmount = useRef<bigint | undefined>(undefined);
  const nextId = useRef(0);
  const [change, setChange] = useState<RouteChange | null>(null);

  const signature = allocations.map((a) => `${a.source.key}:${a.sharePct.toFixed(1)}`).join("|");
  const hasRoute = allocations.some((a) => a.included);

  useEffect(() => {
    if (!hasRoute || amountWei === undefined) {
      previous.current = null;
      previousAmount.current = amountWei;
      return;
    }

    const current = new Map(allocations.map((a) => [a.source.key, a.sharePct]));
    const before = previous.current;
    const amountChanged = previousAmount.current !== amountWei;

    previous.current = current;
    previousAmount.current = amountWei;

    // No baseline yet, or the user changed their own order — nothing to announce either way.
    if (before === null || amountChanged) return;

    const shifts: AllocationShift[] = [];
    for (const allocation of allocations) {
      const fromPct = before.get(allocation.source.key);
      if (fromPct === undefined) continue;
      if (Math.abs(allocation.sharePct - fromPct) >= MATERIAL_SHIFT_PCT) {
        shifts.push({ name: allocation.source.name, fromPct, toPct: allocation.sharePct });
      }
    }

    if (shifts.length > 0) {
      nextId.current += 1;
      setChange({ id: nextId.current, shifts });
    }
    // `signature` is the real dependency — it changes exactly when an allocation does.
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [signature, hasRoute, amountWei]);

  // Announcements are transient: the banner is a notification that the route moved, not a state the
  // UI should sit in. Clearing it keeps a stale "Route updated" from lingering over a settled route.
  useEffect(() => {
    if (change === null) return;
    const timer = setTimeout(() => setChange(null), 12_000);
    return () => clearTimeout(timer);
  }, [change]);

  return change;
}
