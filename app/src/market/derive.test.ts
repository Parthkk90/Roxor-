import { describe, expect, it } from "vitest";

import { coverageBand, coverageTone } from "./coverage";
import { allocationsFor, currentLiquidityBps, depthLayers, summarize } from "./derive";
import { tokenMetaOf, UNKNOWN_TOKEN } from "./useTokenMetadata";
import type { LiquiditySource } from "./types";

function source(overrides: Partial<LiquiditySource> = {}): LiquiditySource {
  return {
    key: "aqua",
    name: "Aqua maker",
    venueKind: "Aqua / SwapVM",
    address: "0x0000000000000000000000000000000000000001",
    unavailable: false,
    snapshot: {
      venue: "0x0000000000000000000000000000000000000001",
      strategyId: "0xaa",
      mode: "NORMAL",
      effectiveLiquidity: 100n,
      spreadBps: 20,
      referencePrice: 10n ** 18n,
      coverageBps: 10_000,
    },
    executable: {
      virtualLiquidity: 100n,
      walletLiquidity: 100n,
      allowance: 100n,
      deliverableLiquidity: 100n,
      conditionalLiquidity: 100n,
      coverageBps: 10_000,
    },
    ...overrides,
  };
}

describe("coverage bands — must agree with ExecutableLiquidityLib's thresholds", () => {
  it("classifies boundary values", () => {
    expect(coverageBand(10_000)).toBe("HEALTHY");
    expect(coverageBand(9000)).toBe("HEALTHY");
    expect(coverageBand(8999)).toBe("DEGRADED");
    expect(coverageBand(7000)).toBe("DEGRADED");
    expect(coverageBand(6999)).toBe("FRAGILE");
    expect(coverageBand(3000)).toBe("FRAGILE");
    expect(coverageBand(2999)).toBe("UNRELIABLE");
    expect(coverageBand(0)).toBe("UNRELIABLE");
  });

  it("never colours FRAGILE or UNRELIABLE as success", () => {
    expect(coverageTone("HEALTHY")).toBe("success");
    expect(coverageTone("FRAGILE")).not.toBe("success");
    expect(coverageTone("UNRELIABLE")).toBe("danger");
  });
});

describe("summarize — never sums advertised depth into the headline figure", () => {
  it("sums conditionalLiquidity, not virtualLiquidity", () => {
    const s = summarize([
      source({ executable: { virtualLiquidity: 1000n, walletLiquidity: 100n, allowance: 100n, deliverableLiquidity: 100n, conditionalLiquidity: 60n, coverageBps: 6000 } }),
    ]);
    expect(s.totalExecutable).toBe(60n);
    expect(s.totalAdvertised).toBe(1000n);
  });

  it("regime is the worst mode among sources, not an average", () => {
    const s = summarize([
      source({ snapshot: { ...source().snapshot!, mode: "NORMAL" } }),
      source({ key: "uniswap-v4", snapshot: { ...source().snapshot!, mode: "DEFENSIVE" } }),
    ]);
    expect(s.regime).toBe("DEFENSIVE");
  });

  it("skips unavailable sources entirely", () => {
    const s = summarize([source({ unavailable: true, executable: undefined })]);
    expect(s.readableSources).toBe(0);
    expect(s.totalExecutable).toBe(0n);
  });

  it("best-priced source must actually have depth to fill", () => {
    const tight = source({
      snapshot: { ...source().snapshot!, spreadBps: 1 },
      executable: { virtualLiquidity: 100n, walletLiquidity: 0n, allowance: 0n, deliverableLiquidity: 0n, conditionalLiquidity: 0n, coverageBps: 0 },
    });
    const wider = source({ key: "uniswap-v4", snapshot: { ...source().snapshot!, spreadBps: 50 } });
    const s = summarize([tight, wider]);
    expect(s.bestPricedSource?.key).toBe("uniswap-v4");
  });
});

describe("allocationsFor — shares always sum to ~100% of what the plan actually routed", () => {
  it("splits share proportionally across legs", () => {
    const sources = [source(), source({ key: "uniswap-v4", address: "0x0000000000000000000000000000000000000002" })];
    const plan = {
      tokenIn: "0x1" as const,
      tokenOut: "0x2" as const,
      totalAmountIn: 100n,
      totalExpectedAmountOut: 100n,
      legs: [
        { venue: "0x0000000000000000000000000000000000000001" as const, amountIn: 60n, expectedAmountOut: 60n, spreadBps: 20 },
        { venue: "0x0000000000000000000000000000000000000002" as const, amountIn: 40n, expectedAmountOut: 40n, spreadBps: 20 },
      ],
    };
    const allocations = allocationsFor(sources, plan);
    expect(allocations[0]!.sharePct).toBe(60);
    expect(allocations[1]!.sharePct).toBe(40);
    expect(allocations.every((a) => a.included)).toBe(true);
  });

  it("a source absent from the plan is 0 and not included", () => {
    const allocations = allocationsFor([source()], undefined);
    expect(allocations[0]!.amountIn).toBe(0n);
    expect(allocations[0]!.included).toBe(false);
  });
});

describe("depthLayers / currentLiquidityBps — the no-phantom-liquidity walk", () => {
  it("each layer is <= the one before it", () => {
    const layers = depthLayers(
      source({ executable: { virtualLiquidity: 100n, walletLiquidity: 80n, allowance: 90n, deliverableLiquidity: 80n, conditionalLiquidity: 20n, coverageBps: 2500 } })
    )!;
    expect(layers.conditional).toBeLessThanOrEqual(layers.deliverable);
    expect(layers.deliverable).toBeLessThanOrEqual(layers.advertised);
  });

  it("multiplier is undefined, not 0%, when nothing is deliverable", () => {
    const zero = source({ executable: { virtualLiquidity: 0n, walletLiquidity: 0n, allowance: 0n, deliverableLiquidity: 0n, conditionalLiquidity: 0n, coverageBps: 0 } });
    expect(currentLiquidityBps(zero)).toBeUndefined();
  });
});

describe("tokenMetaOf — never silently assigns a hardcoded symbol", () => {
  it("falls back to Unknown token when metadata was not read", () => {
    expect(tokenMetaOf({}, "0x0000000000000000000000000000000000000009")).toEqual(UNKNOWN_TOKEN);
  });

  it("is case-insensitive on the address key", () => {
    const map = { "0xabc0000000000000000000000000000000000d": { symbol: "DWA", decimals: 18 } };
    expect(tokenMetaOf(map, "0xABC0000000000000000000000000000000000D").symbol).toBe("DWA");
  });
});
