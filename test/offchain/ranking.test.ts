/**
 * Features 3, 6, 9 and 11 — coverage bands, risk-aware ranking, route construction, explanations.
 *
 * The scenario numbers mirror the spec's worked marketplace example exactly (Maker A at 84%
 * coverage in DEFENSIVE, Maker B at 97% in NORMAL, Uniswap v4 at 100%), so a change in ranking
 * behaviour shows up here as a change to the demo's narrative rather than as an abstract diff.
 */
import { describe, expect, it } from "vitest";

import { coverageBand, coverageBps, deriveExecutable, min3 } from "../../src/analytics/coverage.js";
import { toHealthRecord, toMarketHealth } from "../../src/analytics/health.js";
import { buildRoute, effectivePrice, explainRouteChange, rankCandidates, riskPenaltyBps } from "../../src/solver/RiskAwareRanker.js";
import type { StrategyModeName, VerifiedCandidate } from "../../src/discovery/types.js";

const WAD = 1_000_000_000_000_000_000n;
const TOKEN_IN = "0xaaa";
const TOKEN_OUT = "0xbbb";

interface Spec {
  name: string;
  maker: string;
  venue: string;
  mode: StrategyModeName;
  virtual: bigint;
  wallet: bigint;
  allowance?: bigint;
  liquidityBps: number;
  spreadBps: number;
  price?: bigint;
  reliabilityBps?: number;
}

function candidate(spec: Spec): VerifiedCandidate {
  const executable = deriveExecutable(spec.virtual, spec.wallet, spec.allowance ?? spec.virtual, spec.liquidityBps);

  return {
    candidate: {
      strategyId: spec.name,
      maker: spec.maker,
      venue: spec.venue,
      tokenIn: TOKEN_IN,
      tokenOut: TOKEN_OUT,
      mode: spec.mode,
      reportedLiquidity: executable.conditionalLiquidity,
      reportedCoverageBps: executable.coverageBps,
      spreadBps: spec.spreadBps,
      historicalFillRateBps: spec.reliabilityBps ?? 10_000,
      observedAt: 0,
      active: true,
    },
    executable,
    mode: spec.mode,
    spreadBps: spec.spreadBps,
    referencePrice: spec.price ?? WAD,
    venueAddress: `0xvenue-${spec.name}`,
  };
}

/** The spec's worked marketplace, to the digit. */
function marketplace(): VerifiedCandidate[] {
  return [
    // Maker A: DEFENSIVE, 2.5 ETH executable, 84% coverage, 80 bps.
    candidate({
      name: "makerA",
      maker: "0xaaaa000000000000000000000000000000000001",
      venue: "aqua",
      mode: "DEFENSIVE",
      virtual: 10n * WAD,
      wallet: 8400n * WAD / 1000n,
      liquidityBps: 2976, // 8.4 * 0.2976 ~= 2.5
      spreadBps: 80,
      reliabilityBps: 9910,
    }),
    // Maker B: NORMAL, 4 ETH, 97% coverage, 45 bps.
    candidate({
      name: "makerB",
      maker: "0xbbbb000000000000000000000000000000000002",
      venue: "aqua",
      mode: "NORMAL",
      virtual: 10n * WAD,
      wallet: 9700n * WAD / 1000n,
      liquidityBps: 4123, // 9.7 * 0.4123 ~= 4.0
      spreadBps: 45,
      reliabilityBps: 9840,
    }),
    // Uniswap v4: NORMAL, 3 ETH, 100% coverage, 55 bps.
    candidate({
      name: "uniswapV4",
      maker: "0xcccc000000000000000000000000000000000003",
      venue: "uniswap-v4",
      mode: "NORMAL",
      virtual: 3n * WAD,
      wallet: 3n * WAD,
      liquidityBps: 10_000,
      spreadBps: 55,
      reliabilityBps: 10_000,
    }),
  ];
}

describe("coverage", () => {
  it("matches the Solidity library on the ordinary case", () => {
    expect(coverageBps(82n * WAD, 100n * WAD)).toBe(8200);
  });

  it("reports zero advertised depth as 0, not 100%", () => {
    expect(coverageBps(0n, 0n)).toBe(0);
  });

  it("clamps above 100%", () => {
    expect(coverageBps(500n * WAD, 100n * WAD)).toBe(10_000);
  });

  it("rounds down", () => {
    expect(coverageBps(1n * WAD, 3n * WAD)).toBe(3333);
  });

  it("bands per the spec thresholds", () => {
    expect(coverageBand(10_000)).toBe("HEALTHY");
    expect(coverageBand(9000)).toBe("HEALTHY");
    expect(coverageBand(8999)).toBe("DEGRADED");
    expect(coverageBand(7000)).toBe("DEGRADED");
    expect(coverageBand(6999)).toBe("FRAGILE");
    expect(coverageBand(3000)).toBe("FRAGILE");
    expect(coverageBand(2999)).toBe("UNRELIABLE");
    expect(coverageBand(0)).toBe("UNRELIABLE");
  });

  it("binds on the tightest of the three constraints", () => {
    expect(min3(10n, 5n, 7n)).toBe(5n);
    const executable = deriveExecutable(100n * WAD, 60n * WAD, 15n * WAD, 10_000);
    expect(executable.deliverableLiquidity).toBe(15n * WAD);
  });

  it("applies the conditional multiplier to deliverable depth, never to advertised depth", () => {
    const executable = deriveExecutable(100n * WAD, 40n * WAD, 100n * WAD, 2500);
    expect(executable.deliverableLiquidity).toBe(40n * WAD);
    expect(executable.conditionalLiquidity).toBe(10n * WAD);
  });
});

describe("risk-aware ranking", () => {
  it("penalises low coverage more than a wide spread", () => {
    const wideSpread = candidate({
      name: "wide",
      maker: "0x1",
      venue: "aqua",
      mode: "NORMAL",
      virtual: 10n * WAD,
      wallet: 10n * WAD,
      liquidityBps: 10_000,
      spreadBps: 120,
    });
    const lowCoverage = candidate({
      name: "thin",
      maker: "0x2",
      venue: "aqua",
      mode: "NORMAL",
      virtual: 10n * WAD,
      wallet: 2n * WAD,
      liquidityBps: 10_000,
      spreadBps: 20,
    });

    expect(riskPenaltyBps(lowCoverage)).toBeGreaterThan(riskPenaltyBps(wideSpread));
  });

  it("charges nothing to a fully-covered, fully-reliable NORMAL venue", () => {
    const clean = candidate({
      name: "clean",
      maker: "0x3",
      venue: "uniswap-v4",
      mode: "NORMAL",
      virtual: 5n * WAD,
      wallet: 5n * WAD,
      liquidityBps: 10_000,
      spreadBps: 30,
    });
    expect(riskPenaltyBps(clean)).toBe(0);
  });

  it("never inverts a price into a negative score", () => {
    const awful = candidate({
      name: "awful",
      maker: "0x4",
      venue: "aqua",
      mode: "DEFENSIVE",
      virtual: 100n * WAD,
      wallet: 1n,
      liquidityBps: 10_000,
      spreadBps: 9000,
      reliabilityBps: 0,
    });
    const [ranked] = rankCandidates([awful]);
    expect(ranked!.riskAdjustedScore).toBeGreaterThanOrEqual(0n);
  });

  it("excludes a zero-depth venue and says why", () => {
    const drained = candidate({
      name: "drained",
      maker: "0xdead000000000000000000000000000000000000",
      venue: "aqua",
      mode: "NORMAL",
      virtual: 100n * WAD,
      wallet: 0n,
      liquidityBps: 10_000,
      spreadBps: 20,
      reliabilityBps: 9900,
    });

    const [ranked] = rankCandidates([drained]);
    expect(ranked!.excluded).toBe(true);
    expect(ranked!.executableDepth).toBe(0n);
    expect(ranked!.exclusionReason).toContain("wallet");
  });

  it("orders deterministically when two venues price identically", () => {
    const spec = (name: string, maker: string) =>
      candidate({ name, maker, venue: "aqua", mode: "NORMAL", virtual: WAD, wallet: WAD, liquidityBps: 10_000, spreadBps: 20 });

    const first = rankCandidates([spec("x", "0xa"), spec("y", "0xb")]).map((r) => r.candidate.venueAddress);
    const second = rankCandidates([spec("y", "0xb"), spec("x", "0xa")]).map((r) => r.candidate.venueAddress);
    expect(first).toEqual(second);
  });

  it("computes net-of-spread price", () => {
    expect(effectivePrice(WAD, 100)).toBe((WAD * 9900n) / 10_000n);
    expect(effectivePrice(WAD, 0)).toBe(WAD);
  });
});

describe("route construction", () => {
  it("splits the spec's 7 ETH request across the best executable sources", () => {
    const route = buildRoute(TOKEN_IN, TOKEN_OUT, 7n * WAD, marketplace(), undefined, "ETH");

    expect(route.routable).toBe(true);
    expect(route.allocatedAmount).toBe(7n * WAD);

    const total = route.legs.reduce((sum, leg) => sum + leg.amountIn, 0n);
    expect(total).toBe(7n * WAD);

    // Maker A is in DEFENSIVE with the worst coverage and the widest spread, so it must not be
    // the first source drawn on — that is the whole point of risk-aware ranking.
    expect(route.legs[0]!.maker).not.toBe("0xaaaa000000000000000000000000000000000001");
  });

  it("never allocates a leg beyond its executable depth", () => {
    const route = buildRoute(TOKEN_IN, TOKEN_OUT, 100n * WAD, marketplace(), undefined, "ETH");

    for (const leg of route.legs) {
      const source = route.ranked.find((r) => r.candidate.venueAddress === leg.venueAddress)!;
      expect(leg.amountIn <= source.executableDepth).toBe(true);
    }
  });

  it("reports NO ROUTE against real depth rather than advertised depth", () => {
    // Advertised total is 23 ETH; executable total is ~9.5. A request of 20 must fail.
    const route = buildRoute(TOKEN_IN, TOKEN_OUT, 20n * WAD, marketplace(), undefined, "ETH");

    expect(route.routable).toBe(false);
    expect(route.allocatedAmount).toBeLessThan(20n * WAD);
    expect(route.explanations.join(" ")).toContain("phantom liquidity");
  });

  it("excludes an insolvent maker from the route entirely", () => {
    const sources = marketplace();
    sources[1] = candidate({
      name: "makerB",
      maker: "0xbbbb000000000000000000000000000000000002",
      venue: "aqua",
      mode: "NORMAL",
      virtual: 10n * WAD,
      wallet: 0n, // drained
      liquidityBps: 10_000,
      spreadBps: 45,
      reliabilityBps: 9840,
    });

    const route = buildRoute(TOKEN_IN, TOKEN_OUT, 5n * WAD, sources, undefined, "ETH");
    expect(route.legs.some((leg) => leg.maker === "0xbbbb000000000000000000000000000000000002")).toBe(false);
  });
});

describe("route explanation", () => {
  it("explains why each selected source was chosen", () => {
    const route = buildRoute(TOKEN_IN, TOKEN_OUT, 7n * WAD, marketplace(), undefined, "ETH");
    const text = route.explanations.join("\n");

    expect(text).toContain("coverage");
    expect(text).toContain("bps spread");
    expect(text).toContain("supplied");
  });

  it("names the regime when a source is not in NORMAL", () => {
    const route = buildRoute(TOKEN_IN, TOKEN_OUT, 9n * WAD, marketplace(), undefined, "ETH");
    expect(route.explanations.join("\n")).toContain("DEFENSIVE");
  });

  it("describes a maker being cut when its regime shifts", () => {
    const before = buildRoute(TOKEN_IN, TOKEN_OUT, 7n * WAD, marketplace(), undefined, "ETH");

    const shocked = marketplace();
    shocked[1] = candidate({
      name: "makerB",
      maker: "0xbbbb000000000000000000000000000000000002",
      venue: "aqua",
      mode: "DEFENSIVE",
      virtual: 10n * WAD,
      wallet: 9700n * WAD / 1000n,
      liquidityBps: 1000, // collapsed from ~41% to 10%
      spreadBps: 90,
      reliabilityBps: 9840,
    });
    const after = buildRoute(TOKEN_IN, TOKEN_OUT, 7n * WAD, shocked, undefined, "ETH");

    const changes = explainRouteChange(before, after, "ETH").join("\n");
    expect(changes.length).toBeGreaterThan(0);
  });
});

describe("liquidity health API", () => {
  it("serialises every amount as a decimal string, never a JSON number", () => {
    const record = toHealthRecord(marketplace()[0]!);

    for (const key of ["virtualLiquidity", "walletLiquidity", "allowance", "deliverableLiquidity", "effectiveLiquidity"] as const) {
      expect(typeof record[key]).toBe("string");
    }
    expect(record.mode).toBe("DEFENSIVE");
    expect(record.coverageBand).toBe(coverageBand(record.coverageBps));
    expect(record.reliabilityBps).toBe(9910);
  });

  it("aggregates a market and reports the worst regime, not an average", () => {
    const health = toMarketHealth(TOKEN_IN, TOKEN_OUT, marketplace(), 1_700_000_000);

    expect(health.regime).toBe("DEFENSIVE");
    expect(health.sources).toHaveLength(3);
    expect(BigInt(health.totalExecutableLiquidity)).toBeLessThan(BigInt(health.totalAdvertisedLiquidity));
    expect(health.marketCoverageBps).toBeLessThan(10_000);
  });

  it("reports zero market coverage when nothing is advertised", () => {
    const health = toMarketHealth(TOKEN_IN, TOKEN_OUT, [], 0);
    expect(health.marketCoverageBps).toBe(0);
    expect(health.totalExecutableLiquidity).toBe("0");
  });
});
