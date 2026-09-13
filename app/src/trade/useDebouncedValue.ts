import { useEffect, useState } from "react";

/**
 * Debounce a value, but settle immediately when it becomes "empty".
 *
 * The immediate-on-empty case is not a micro-optimisation: without it, clearing the amount field
 * leaves the previous quote on screen for the full delay, so the UI appears to disagree with an
 * input the user can see is blank.
 *
 * This lives in exactly one place - the trade provider - rather than inside a hook that multiple
 * components call. Previously each caller of `useRouteQuote` ran its own hidden timer over its own
 * copy of the amount, which is part of how the two panels drifted apart.
 */
export function useDebouncedValue<T>(value: T, delayMs: number, isEmpty: (value: T) => boolean): T {
  const [settled, setSettled] = useState(value);

  useEffect(() => {
    if (isEmpty(value)) {
      setSettled(value);
      return;
    }
    const id = setTimeout(() => setSettled(value), delayMs);
    return () => clearTimeout(id);
    // `isEmpty` is expected to be a stable module-level predicate.
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [value, delayMs]);

  return settled;
}
