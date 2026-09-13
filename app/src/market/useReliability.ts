import { useQuery } from "@tanstack/react-query";

/**
 * Historical reliability from The Graph - LAYER 1.
 *
 * Strictly a display and ranking signal. Nothing here influences what the solver routes: the
 * marketplace's depth column comes from live venue reads, and the solver revalidates again at
 * settlement. A maker at 99.1% here with an empty wallet still shows zero executable depth, which
 * is the behaviour the whole design exists to produce.
 *
 * When no endpoint is configured, or the index is unreachable, this resolves to `undefined` and
 * the UI renders "-". That is deliberate: a fabricated percentage sitting beside chain-read
 * numbers would be the one figure on the screen a trader could not verify.
 */
const SUBGRAPH_URL: string | undefined = import.meta.env.VITE_SUBGRAPH_URL || undefined;

const RELIABILITY_QUERY = /* GraphQL */ `
  query StrategyReliability($ids: [Bytes!]) {
    strategies(where: { id_in: $ids }) {
      id
      attemptedFills
      successfulFills
      makerEntity {
        id
        reliabilityBps
        attemptedFills
      }
    }
  }
`;

interface RawStrategy {
  id: string;
  attemptedFills: string;
  successfulFills: string;
  makerEntity: { id: string; reliabilityBps: string; attemptedFills: string } | null;
}

async function fetchReliability(ids: string[]): Promise<Record<string, number>> {
  if (!SUBGRAPH_URL || ids.length === 0) return {};

  const response = await fetch(SUBGRAPH_URL, {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify({ query: RELIABILITY_QUERY, variables: { ids } }),
  });
  if (!response.ok) throw new Error(`subgraph HTTP ${response.status}`);

  const body = (await response.json()) as { data?: { strategies: RawStrategy[] }; errors?: unknown };
  const strategies = body.data?.strategies ?? [];

  const out: Record<string, number> = {};
  for (const strategy of strategies) {
    const makerAttempts = Number(strategy.makerEntity?.attemptedFills ?? "0");
    if (strategy.makerEntity && makerAttempts > 0) {
      out[strategy.id.toLowerCase()] = Number(strategy.makerEntity.reliabilityBps);
      continue;
    }

    const attempted = Number(strategy.attemptedFills);
    // No attempts is not evidence of unreliability - a new maker has not earned a bad score.
    out[strategy.id.toLowerCase()] =
      attempted > 0 ? Math.floor((Number(strategy.successfulFills) * 10_000) / attempted) : 10_000;
  }
  return out;
}

/** Reliability in bps, keyed by lowercased strategy id. Empty when unconfigured or unreachable. */
export function useReliability(strategyIds: Array<string | undefined>) {
  const ids = strategyIds.filter((id): id is string => Boolean(id)).map((id) => id.toLowerCase());

  const { data } = useQuery({
    queryKey: ["reliability", ids],
    queryFn: () => fetchReliability(ids),
    enabled: Boolean(SUBGRAPH_URL) && ids.length > 0,
    // Historical counters move far more slowly than live depth, so this polls at a fraction of
    // the venue snapshot cadence rather than hammering a billable gateway every five seconds.
    refetchInterval: 60_000,
    staleTime: 30_000,
    retry: 1,
  });

  return data ?? {};
}

export const subgraphConfigured = Boolean(SUBGRAPH_URL);
