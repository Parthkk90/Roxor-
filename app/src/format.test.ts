import { describe, expect, it } from "vitest";

import { fmt, fmtBps, fmtDuration, fmtRate, fmtToken, NO_VALUE } from "./format";

const DTB = { symbol: "DTB", decimals: 18 };
const USDC = { symbol: "USDC", decimals: 6 };

describe("fmt", () => {
  it("respects the token's own decimals", () => {
    expect(fmt(1_000_000n, 6)).toBe("1");
    expect(fmt(1_000_000n, 18)).toBe("<0.000001");
    expect(fmt(10n ** 18n, 18)).toBe("1");
  });

  it("never renders a raw base-unit value", () => {
    // The figure that prompted this: a mock-token balance minted at ~type(uint128).max.
    expect(fmt(340282366920937463768374607431768265809n, 18)).toBe("3.40e20");
    expect(fmt(10n ** 24n, 18)).toBe("1M");
    expect(fmt(10n ** 27n, 18)).toBe("1B");
    expect(fmt(10n ** 30n, 18)).toBe("1T");
  });

  it("adapts precision to magnitude", () => {
    expect(fmt(1234n * 10n ** 18n, 18)).toBe("1,234");          // thousands: 2dp, trimmed
    expect(fmt(1234n * 10n ** 17n, 18)).toBe("123.4");           // hundreds: 4dp, trimmed
    expect(fmt(6708236463559693850n, 18)).toBe("6.7082");        // units: 4dp
    expect(fmt(123456789012345n, 18)).toBe("0.000123");          // sub-unit: 6dp
  });

  it("distinguishes a tiny amount from nothing at all", () => {
    expect(fmt(0n, 18)).toBe("0");
    expect(fmt(1n, 18)).toBe("<0.000001");
    expect(fmt(undefined, 18)).toBe(NO_VALUE);
  });

  it("trims trailing zeros and groups thousands", () => {
    expect(fmt(5n * 10n ** 18n, 18)).toBe("5");
    expect(fmt(12345678n * 10n ** 16n, 18)).toBe("123,456.78");
  });

  it("can be capped where a column is narrow", () => {
    expect(fmt(6708236463559693850n, 18, 2)).toBe("6.71");
  });
});

describe("fmtToken", () => {
  it("pairs the amount with its symbol", () => {
    expect(fmtToken(4n * 10n ** 18n, DTB)).toBe("4 DTB");
    expect(fmtToken(undefined, DTB)).toBe("- DTB");
  });
});

describe("fmtRate", () => {
  it("uses both tokens' decimals rather than dividing raw amounts", () => {
    // 1 DTB in, 1.5 USDC out. Dividing the raw bigints would give 1.5e-12.
    expect(fmtRate(10n ** 18n, 1_500_000n, DTB, USDC)).toBe("1.5");
  });

  it("returns the no-value marker rather than Infinity or NaN", () => {
    expect(fmtRate(0n, 1n, DTB, USDC)).toBe(NO_VALUE);
    expect(fmtRate(undefined, 1n, DTB, USDC)).toBe(NO_VALUE);
  });
});

describe("fmtBps", () => {
  it("reads as a percentage", () => {
    expect(fmtBps(10_000)).toBe("100%");
    expect(fmtBps(2_500)).toBe("25%");
    expect(fmtBps(20)).toBe("0.2%");
    expect(fmtBps(769)).toBe("7.69%");
    expect(fmtBps(undefined)).toBe(NO_VALUE);
  });
});

describe("fmtDuration", () => {
  it("says what a person would say", () => {
    expect(fmtDuration(600)).toBe("10 minutes");
    expect(fmtDuration(60)).toBe("1 minute");
    expect(fmtDuration(3600)).toBe("1 hour");
    expect(fmtDuration(45)).toBe("45 seconds");
    expect(fmtDuration(90)).toBe("1m 30s");
    expect(fmtDuration(0)).toBe("immediately");
  });
});
