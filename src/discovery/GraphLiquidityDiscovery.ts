/**
 * Graph-backed liquidity discovery — LAYER 1 of the three layers of truth.
 *
 * This client answers exactly one question: *which* liquidity sources are worth asking about. It
 * deliberately cannot answer "how much can they fill", and the type system is arranged so that a
 * caller cannot accidentally use it that way — `discover()` returns `LiquidityCandidate`s whose
 * depth fields are all named `reported*`, and only `verify()` (which performs live chain reads)
 * produces the `conditionalLiquidity` a route may allocate against.
 *
 * A subgraph can lag, be re-indexing, or be down entirely. None of those is allowed to stop a
 * trade: discovery degrades to "ask every known venue directly", which is slower and less
 * informative but never *wrong*, because the chain read is the authority regardless.
 */
import { ACTIVE_STRATEGIES_FOR_PAIR, MAKER_FILL_HISTORY, STRATEGY_TRANSITIONS } from "./queries.js";
import type { LiquidityCandidate, StrategyModeName } from "./types.js";

export interface GraphQLTransport {
  request<T>(query: string, variables: Record<string, unknown>): Promise<T>;
}

export interface DiscoveryOptions {
  /**
   * Reject candidates whose newest observation is older than this many seconds.
   *
   * Staleness is not a cosmetic concern here: an Aqua maker can go from fully funded to zero
   * deliverable without emitting any event, so old data is not merely imprecise, it can be
   * actively wrong in the direction that hurts. Dropping stale rows keeps them out of *ranking*;
   * the on-chain check is what keeps them out of *settlement*.
   */
  maxStalenessSeconds?: number;
  /** Maximum rows to pull per query. */
  limit?: number;
  /** Injected clock, in unix seconds. Tests pass a fixed value. */
  now?: () => number;
}

const DEFAULT_STALENESS_SECONDS = 300;
const DEFAULT_LIMIT = 100;
const BPS = 10_000;

interface RawSnapshot {
  virtualLiquidity: string;
  effectiveLiquidity: string;
  coverageBps: string;
  spreadBps: string;
  mode: string;
  timestamp: string;
}

interface RawStrategy {
  id: string;
  maker: string;
  tokenIn: string;
  tokenOut: string;
  venue: string;
  mode: string;
  active: boolean;
  liquidityBps: string;
  spreadBps: string;
  updatedAt: string;
  attemptedFills: string;
  successfulFills: string;
  makerEntity: { id: string; reliabilityBps: string; attemptedFills: string; successfulFills: string } | null;
  snapshots: RawSnapshot[];
}

function asMode(value: string): StrategyModeName {
  return value === "DEFENSIVE" || value === "RECOVERY" ? value : "NORMAL";
}

/** Sorted, lowercased pair — matches how the registry stores `tokenA`/`tokenB`. */
export function sortPair(a: string, b: string): [string, string] {
  const lowerA = a.toLowerCase();
  const lowerB = b.toLowerCase();
  return lowerA < lowerB ? [lowerA, lowerB] : [lowerB, lowerA];
}

export class GraphLiquidityDiscovery {
  private readonly transport: GraphQLTransport;
  private readonly maxStalenessSeconds: number;
  private readonly limit: number;
  private readonly now: () => number;

  constructor(transport: GraphQLTransport, options: DiscoveryOptions = {}) {
    this.transport = transport;
    this.maxStalenessSeconds = options.maxStalenessSeconds ?? DEFAULT_STALENESS_SECONDS;
    this.limit = options.limit ?? DEFAULT_LIMIT;
    this.now = options.now ?? (() => Math.floor(Date.now() / 1000));
  }

  /**
   * Candidate liquidity sources for `tokenIn -> tokenOut`.
   *
   * Returns `[]` rather than throwing when the index is unreachable. A caller that treats an empty
   * discovery result as "no liquidity exists" has made the error this whole design guards against;
   * the correct fallback is to query the known venue adapters directly.
   */
  async discover(tokenIn: string, tokenOut: string): Promise<LiquidityCandidate[]> {
    const [tokenA, tokenB] = sortPair(tokenIn, tokenOut);

    let raw: RawStrategy[];
    try {
      const result = await this.transport.request<{ strategies: RawStrategy[] }>(ACTIVE_STRATEGIES_FOR_PAIR, {
        tokenA,
        tokenB,
        first: this.limit,
      });
      raw = result.strategies ?? [];
    } catch {
      return [];
    }

    const now = this.now();
    const candidates: LiquidityCandidate[] = [];

    for (const strategy of raw) {
      if (!strategy.active) continue;

      const snapshot = strategy.snapshots[0];
      const observedAt = Number(snapshot?.timestamp ?? strategy.updatedAt);
      if (!Number.isFinite(observedAt)) continue;
      if (now - observedAt > this.maxStalenessSeconds) continue;

      candidates.push({
        strategyId: strategy.id,
        maker: strategy.maker,
        venue: strategy.venue,
        // Echo the *requested* direction, not the stored sort order, so the caller gets back what
        // they asked about rather than having to re-derive it.
        tokenIn: tokenIn.toLowerCase(),
        tokenOut: tokenOut.toLowerCase(),
        mode: asMode(snapshot?.mode ?? strategy.mode),
        reportedLiquidity: BigInt(snapshot?.effectiveLiquidity ?? "0"),
        reportedCoverageBps: Number(snapshot?.coverageBps ?? "0"),
        spreadBps: Number(snapshot?.spreadBps ?? strategy.spreadBps),
        historicalFillRateBps: this.reliabilityOf(strategy),
        observedAt,
        active: true,
      });
    }

    return candidates;
  }

  /** Indexed regime history for one strategy, newest first. */
  async transitions(strategyId: string, limit = 20): Promise<
    Array<{ previousMode: StrategyModeName; newMode: StrategyModeName; triggerVolatilityBps: number; timestamp: number }>
  > {
    try {
      const result = await this.transport.request<{
        stateTransitions: Array<{ previousMode: string; newMode: string; triggerVolatilityBps: string; timestamp: string }>;
      }>(STRATEGY_TRANSITIONS, { strategyId, first: limit });

      return (result.stateTransitions ?? []).map((t) => ({
        previousMode: asMode(t.previousMode),
        newMode: asMode(t.newMode),
        triggerVolatilityBps: Number(t.triggerVolatilityBps),
        timestamp: Number(t.timestamp),
      }));
    } catch {
      return [];
    }
  }

  /** Indexed lifetime fill counters for one maker. */
  async makerHistory(maker: string, sinceUnixSeconds = 0): Promise<{
    attemptedFills: number;
    successfulFills: number;
    failedFills: number;
    reliabilityBps: number;
  }> {
    try {
      const result = await this.transport.request<{
        maker: { attemptedFills: string; successfulFills: string; failedFills: string; reliabilityBps: string } | null;
      }>(MAKER_FILL_HISTORY, { maker: maker.toLowerCase(), since: String(sinceUnixSeconds), first: this.limit });

      const row = result.maker;
      if (row == null) {
        return { attemptedFills: 0, successfulFills: 0, failedFills: 0, reliabilityBps: BPS };
      }
      return {
        attemptedFills: Number(row.attemptedFills),
        successfulFills: Number(row.successfulFills),
        failedFills: Number(row.failedFills),
        reliabilityBps: Number(row.reliabilityBps),
      };
    } catch {
      // Unknown history is not bad history. Defaulting to fully reliable keeps an unreachable
      // index from quietly de-ranking every maker in the market.
      return { attemptedFills: 0, successfulFills: 0, failedFills: 0, reliabilityBps: BPS };
    }
  }

  /**
   * Prefer the maker-level reliability the index maintains; fall back to the strategy's own
   * counters when the maker entity is missing, and to "fully reliable" when nothing was attempted.
   */
  private reliabilityOf(strategy: RawStrategy): number {
    const makerReliability = strategy.makerEntity?.reliabilityBps;
    if (makerReliability != null && Number(strategy.makerEntity?.attemptedFills ?? "0") > 0) {
      return Number(makerReliability);
    }

    const attempted = Number(strategy.attemptedFills);
    if (!Number.isFinite(attempted) || attempted === 0) return BPS;
    return Math.floor((Number(strategy.successfulFills) * BPS) / attempted);
  }
}

/** Minimal `fetch`-based transport. Any GraphQL client satisfying the interface works. */
export function httpTransport(endpoint: string, fetchImpl: typeof fetch = fetch): GraphQLTransport {
  return {
    async request<T>(query: string, variables: Record<string, unknown>): Promise<T> {
      const response = await fetchImpl(endpoint, {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({ query, variables }),
      });
      if (!response.ok) {
        throw new Error(`subgraph HTTP ${response.status}`);
      }
      const body = (await response.json()) as { data?: T; errors?: Array<{ message: string }> };
      if (body.errors?.length) {
        throw new Error(`subgraph error: ${body.errors.map((e) => e.message).join("; ")}`);
      }
      if (body.data == null) {
        throw new Error("subgraph returned no data");
      }
      return body.data;
    },
  };
}
