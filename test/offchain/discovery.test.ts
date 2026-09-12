/**
 * Feature 5 & 8 — Graph discovery against fully mocked subgraph responses.
 *
 * The contract tests must never depend on a running Graph node, and neither must these. Every
 * response here is a fixture, which also lets us test the cases a live index would rarely produce
 * on demand: an outage, a stale row, a maker with no history at all.
 */
import { describe, expect, it } from "vitest";

import { GraphLiquidityDiscovery, sortPair, type GraphQLTransport } from "../../src/discovery/GraphLiquidityDiscovery.js";
import { reliabilityBps, smoothedReliabilityBps, allocatableDepth } from "../../src/analytics/reliability.js";

const TOKEN_A = "0x246b76e37825a473ae784ce14a2bb42733a8f922";
const TOKEN_B = "0xfe14a75d92e1a028ebb497dac4d25bf2e08b3af3";
const MAKER_A = "0x1111111111111111111111111111111111111111";
const NOW = 1_700_000_000;

function strategyRow(overrides: Record<string, unknown> = {}) {
  return {
    id: "0xstrategy-a",
    maker: MAKER_A,
    tokenIn: TOKEN_A,
    tokenOut: TOKEN_B,
    venue: "aqua",
    mode: "NORMAL",
    active: true,
    liquidityBps: "10000",
    spreadBps: "20",
    updatedAt: String(NOW - 10),
    attemptedFills: "100",
    successfulFills: "99",
    makerEntity: { id: MAKER_A, reliabilityBps: "9910", attemptedFills: "100", successfulFills: "99" },
    snapshots: [
      {
        virtualLiquidity: "100000000000000000000",
        effectiveLiquidity: "82000000000000000000",
        coverageBps: "8200",
        spreadBps: "20",
        mode: "NORMAL",
        timestamp: String(NOW - 10),
      },
    ],
    ...overrides,
  };
}

function mockTransport(response: unknown): GraphQLTransport {
  return { request: async () => response as never };
}

function failingTransport(): GraphQLTransport {
  return {
    request: async () => {
      throw new Error("subgraph HTTP 503");
    },
  };
}

function discovery(transport: GraphQLTransport, maxStalenessSeconds = 300) {
  return new GraphLiquidityDiscovery(transport, { maxStalenessSeconds, now: () => NOW });
}

describe("sortPair", () => {
  it("matches the registry's sorted-pair storage regardless of argument order", () => {
    expect(sortPair(TOKEN_B, TOKEN_A)).toEqual([TOKEN_A, TOKEN_B]);
    expect(sortPair(TOKEN_A, TOKEN_B)).toEqual([TOKEN_A, TOKEN_B]);
  });

  it("normalizes case, so a checksummed address still matches an indexed lowercase one", () => {
    expect(sortPair(TOKEN_A.toUpperCase(), TOKEN_B)).toEqual([TOKEN_A, TOKEN_B]);
  });
});

describe("GraphLiquidityDiscovery.discover", () => {
  it("normalizes an indexed strategy into a candidate", async () => {
    const candidates = await discovery(mockTransport({ strategies: [strategyRow()] })).discover(TOKEN_A, TOKEN_B);

    expect(candidates).toHaveLength(1);
    const candidate = candidates[0]!;
    expect(candidate.strategyId).toBe("0xstrategy-a");
    expect(candidate.venue).toBe("aqua");
    expect(candidate.mode).toBe("NORMAL");
    expect(candidate.reportedLiquidity).toBe(82_000_000_000_000_000_000n);
    expect(candidate.reportedCoverageBps).toBe(8200);
    expect(candidate.spreadBps).toBe(20);
    expect(candidate.historicalFillRateBps).toBe(9910);
  });

  it("echoes the requested direction rather than the stored sort order", async () => {
    // Asking B->A must not come back describing A->B: the caller would then build a route in the
    // wrong direction against a pair that is stored direction-agnostically.
    const candidates = await discovery(mockTransport({ strategies: [strategyRow()] })).discover(TOKEN_B, TOKEN_A);

    expect(candidates[0]!.tokenIn).toBe(TOKEN_B);
    expect(candidates[0]!.tokenOut).toBe(TOKEN_A);
  });

  it("drops stale rows, because an Aqua maker can go insolvent without emitting anything", async () => {
    const stale = strategyRow({
      updatedAt: String(NOW - 10_000),
      snapshots: [{ ...strategyRow().snapshots[0], timestamp: String(NOW - 10_000) }],
    });

    expect(await discovery(mockTransport({ strategies: [stale] })).discover(TOKEN_A, TOKEN_B)).toHaveLength(0);
  });

  it("drops inactive strategies", async () => {
    const inactive = strategyRow({ active: false });
    expect(await discovery(mockTransport({ strategies: [inactive] })).discover(TOKEN_A, TOKEN_B)).toHaveLength(0);
  });

  it("returns an empty candidate set when the subgraph is unavailable", async () => {
    // Degrading to "no candidates" is correct; throwing would let an index outage block a trade
    // that the chain could still settle perfectly well via the known venue adapters.
    expect(await discovery(failingTransport()).discover(TOKEN_A, TOKEN_B)).toEqual([]);
  });

  it("treats a maker with no fill history as fully reliable rather than as 0%", async () => {
    const fresh = strategyRow({
      attemptedFills: "0",
      successfulFills: "0",
      makerEntity: { id: MAKER_A, reliabilityBps: "0", attemptedFills: "0", successfulFills: "0" },
    });

    const candidates = await discovery(mockTransport({ strategies: [fresh] })).discover(TOKEN_A, TOKEN_B);
    expect(candidates[0]!.historicalFillRateBps).toBe(10_000);
  });

  it("falls back to strategy counters when the maker entity is missing", async () => {
    const orphan = strategyRow({ makerEntity: null, attemptedFills: "10", successfulFills: "8" });

    const candidates = await discovery(mockTransport({ strategies: [orphan] })).discover(TOKEN_A, TOKEN_B);
    expect(candidates[0]!.historicalFillRateBps).toBe(8000);
  });

  it("handles a strategy that has never been snapshotted", async () => {
    const noSnapshots = strategyRow({ snapshots: [] });

    const candidates = await discovery(mockTransport({ strategies: [noSnapshots] })).discover(TOKEN_A, TOKEN_B);
    expect(candidates).toHaveLength(1);
    expect(candidates[0]!.reportedLiquidity).toBe(0n);
    expect(candidates[0]!.reportedCoverageBps).toBe(0);
  });
});

describe("GraphLiquidityDiscovery.makerHistory", () => {
  it("reads indexed fill counters", async () => {
    const history = await discovery(
      mockTransport({ maker: { attemptedFills: "100", successfulFills: "99", failedFills: "1", reliabilityBps: "9900" } })
    ).makerHistory(MAKER_A);

    expect(history).toEqual({ attemptedFills: 100, successfulFills: 99, failedFills: 1, reliabilityBps: 9900 });
  });

  it("defaults an unknown maker to fully reliable", async () => {
    const history = await discovery(mockTransport({ maker: null })).makerHistory("0xdead");
    expect(history.reliabilityBps).toBe(10_000);
  });

  it("does not de-rank every maker when the index is down", async () => {
    const history = await discovery(failingTransport()).makerHistory(MAKER_A);
    expect(history.reliabilityBps).toBe(10_000);
  });
});

describe("reliability", () => {
  it("computes successfulFills * 10000 / attemptedFills", () => {
    expect(reliabilityBps({ attemptedFills: 1000, successfulFills: 991 })).toBe(9910);
    expect(reliabilityBps({ attemptedFills: 2, successfulFills: 1 })).toBe(5000);
  });

  it("rounds down, never flattering a maker", () => {
    expect(reliabilityBps({ attemptedFills: 3, successfulFills: 2 })).toBe(6666);
  });

  it("treats no attempts as fully reliable", () => {
    expect(reliabilityBps({ attemptedFills: 0, successfulFills: 0 })).toBe(10_000);
  });

  it("clamps nonsensical counters instead of returning above 100%", () => {
    expect(reliabilityBps({ attemptedFills: 10, successfulFills: 50 })).toBe(10_000);
  });

  it("damps a small sample toward the prior", () => {
    // One lucky fill must not out-rank a long honest record.
    const lucky = smoothedReliabilityBps({ attemptedFills: 1, successfulFills: 1 });
    const seasoned = smoothedReliabilityBps({ attemptedFills: 1000, successfulFills: 990 });
    expect(lucky).toBeLessThan(seasoned);
  });

  it("stops damping once enough observations exist", () => {
    expect(smoothedReliabilityBps({ attemptedFills: 100, successfulFills: 99 }, 20)).toBe(9900);
  });

  it("never lets reliability raise executable depth — the Feature 8 boundary", () => {
    // The spec's case: 99% historical reliability, zero current wallet balance.
    expect(allocatableDepth(0n, 9900)).toBe(0n);
    expect(allocatableDepth(5n, 10_000)).toBe(5n);
  });
});
