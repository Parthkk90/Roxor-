import { useQuery } from "@tanstack/react-query";

/**
 * Recent settlements, from the discovery index.
 *
 * LAYER 1 — history only. Nothing here is admissible as a settlement input, and nothing routes on
 * it. It exists so a trader can see how their flow was actually split after the fact, which is the
 * one place the route split can be reported as fact rather than as a forecast.
 *
 * When no endpoint is configured this resolves to `configured: false` and the page says so plainly.
 * It is deliberately not an error state: an unconfigured index is a deployment choice, not a fault,
 * and rendering it in alarm colours would train people to ignore real failures.
 */
const SUBGRAPH_URL: string | undefined = import.meta.env.VITE_SUBGRAPH_URL || undefined;

const RECENT_EXECUTIONS = /* GraphQL */ `
  query RecentRouteExecutions($first: Int!) {
    routeExecutions(first: $first, orderBy: timestamp, orderDirection: desc) {
      id
      trader
      totalAmountIn
      totalAmountOut
      legCount
      timestamp
      txHash
      legs {
        id
        venue
        amountIn
        amountOut
      }
    }
  }
`;

export interface ActivityLeg {
  id: string;
  venue: string;
  amountIn: bigint;
  amountOut: bigint;
}

export interface ActivityRecord {
  id: string;
  trader: string;
  totalAmountIn: bigint;
  totalAmountOut: bigint;
  legCount: number;
  timestamp: number;
  txHash: `0x${string}`;
  legs: ActivityLeg[];
}

interface RawLeg {
  id: string;
  venue: string;
  amountIn: string;
  amountOut: string;
}

interface RawExecution {
  id: string;
  trader: string;
  totalAmountIn: string;
  totalAmountOut: string;
  legCount: string;
  timestamp: string;
  txHash: string;
  legs: RawLeg[];
}

async function fetchActivity(first: number): Promise<ActivityRecord[]> {
  if (!SUBGRAPH_URL) return [];

  const response = await fetch(SUBGRAPH_URL, {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify({ query: RECENT_EXECUTIONS, variables: { first } }),
  });
  if (!response.ok) throw new Error(`subgraph HTTP ${response.status}`);

  const body = (await response.json()) as {
    data?: { routeExecutions: RawExecution[] };
    errors?: { message: string }[];
  };
  if (body.errors?.length) throw new Error(body.errors[0]!.message);

  // Amounts are parsed to bigint at the boundary. JSON numbers cannot hold 18-decimal token
  // amounts without silently losing precision, so they arrive as strings and stay exact.
  return (body.data?.routeExecutions ?? []).map((raw) => ({
    id: raw.id,
    trader: raw.trader,
    totalAmountIn: BigInt(raw.totalAmountIn),
    totalAmountOut: BigInt(raw.totalAmountOut),
    legCount: Number(raw.legCount),
    timestamp: Number(raw.timestamp),
    txHash: raw.txHash as `0x${string}`,
    legs: raw.legs.map((leg) => ({
      id: leg.id,
      venue: leg.venue,
      amountIn: BigInt(leg.amountIn),
      amountOut: BigInt(leg.amountOut),
    })),
  }));
}

export function useActivity(first = 25) {
  const query = useQuery({
    queryKey: ["activity", "routeExecutions", first],
    queryFn: () => fetchActivity(first),
    enabled: Boolean(SUBGRAPH_URL),
    // History moves far more slowly than live depth, and this is a billable gateway. Background
    // freshness only — the user's own trade arrives through explicit invalidation on settlement.
    refetchInterval: 60_000,
    staleTime: 30_000,
    retry: 1,
  });

  return {
    configured: Boolean(SUBGRAPH_URL),
    records: query.data ?? [],
    isLoading: query.isLoading,
    isError: query.isError,
    refetch: () => void query.refetch(),
  };
}
