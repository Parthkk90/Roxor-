import { describe, expect, it } from "vitest";

import { compile, tryCompile } from "../../src/compiler/index.js";

describe("valid programs", () => {
  it("compiles the volatility shield example", () => {
    const source = `
      strategy ETH_USDC {
        base { liquidity = 100% spread = 20bps }
        when volatility > 50% { mode = DEFENSIVE liquidity = 25% spread = 90bps }
      }
    `;
    const result = compile(source);
    expect(result.success).toBe(true);
    expect(result.ir.rules).toHaveLength(1);
    expect(result.ir.base).toEqual({ liquidityBps: 10_000, spreadBps: 20 });
  });

  it("accepts priceDrop(5m) and lowers it to an inverted priceChange5m condition", () => {
    const source = `
      strategy X {
        base { liquidity = 100% spread = 10bps }
        when priceDrop(5m) > 3% { liquidity = 50% }
      }
    `;
    const { ir } = compile(source);
    const cond = ir.rules[0]!.conditions[0]!;
    // priceDrop(5m) > 3%  =>  priceChange5m < -3%  (flip + negate)
    expect(cond.type).toBe(2); // PRICE_CHANGE_5M
    expect(cond.operator).toBe(2); // LT
    expect(cond.value).toBe("-300");
  });

  it("accepts priceChange(1h) with the 1h window", () => {
    const source = `
      strategy X {
        base { liquidity = 100% spread = 10bps }
        when priceChange(1h) < -5% { liquidity = 50% }
      }
    `;
    const { ir } = compile(source);
    expect(ir.rules[0]!.conditions[0]!.type).toBe(3); // PRICE_CHANGE_1H
  });

  it("accepts timeSinceTransition() with no argument", () => {
    const source = `
      strategy X {
        base { liquidity = 100% spread = 10bps }
        when timeSinceTransition() >= 10 minutes { liquidity = 50% }
      }
    `;
    expect(() => compile(source)).not.toThrow();
  });

  it("accepts multiple conditions joined with 'and'", () => {
    const source = `
      strategy X {
        base { liquidity = 100% spread = 10bps }
        when mode == NORMAL and volatility >= 50% { mode = DEFENSIVE liquidity = 25% }
      }
    `;
    const { ir } = compile(source);
    expect(ir.rules[0]!.conditions).toHaveLength(2);
  });

  it("accepts *= and += compound assignment", () => {
    const source = `
      strategy X {
        base { liquidity = 100% spread = 10bps }
        when volatility > 50% { liquidity *= 50% spread += 20bps }
      }
    `;
    const { ir } = compile(source);
    const actions = ir.rules[0]!.actions;
    expect(actions[0]).toEqual({ type: 3, value: "5000" }); // MULTIPLY_LIQUIDITY, 50% -> 5000bps
    expect(actions[1]).toEqual({ type: 4, value: "20" }); // ADD_SPREAD, 20bps stays 20
  });

  it("accepts line comments and # comments", () => {
    const source = `
      // leading comment
      strategy X { # trailing style
        base { liquidity = 100% spread = 10bps } // ok
        when volatility > 50% { liquidity = 25% }
      }
    `;
    expect(() => compile(source)).not.toThrow();
  });

  it("accepts underscores in numbers", () => {
    const source = `
      strategy X {
        base { liquidity = 100% spread = 10bps }
        when volume > 1_000_000 { liquidity = 25% }
      }
    `;
    expect(() => compile(source)).not.toThrow();
  });
});

describe("invalid programs: lexer/parser", () => {
  it("rejects a missing base block", () => {
    const source = `strategy X { when volatility > 50% { liquidity = 25% } }`;
    const r = tryCompile(source);
    expect(r.ok).toBe(false);
    if (!r.ok) expect(r.errors[0]!.message).toMatch(/base/);
  });

  it("rejects a strategy with no rules", () => {
    const source = `strategy X { base { liquidity = 100% spread = 10bps } }`;
    const r = tryCompile(source);
    expect(r.ok).toBe(false);
  });

  it("rejects an empty rule body", () => {
    const source = `
      strategy X {
        base { liquidity = 100% spread = 10bps }
        when volatility > 50% { }
      }
    `;
    const r = tryCompile(source);
    expect(r.ok).toBe(false);
  });

  it("rejects a missing comparison operator", () => {
    const source = `
      strategy X {
        base { liquidity = 100% spread = 10bps }
        when volatility 50% { liquidity = 25% }
      }
    `;
    const r = tryCompile(source);
    expect(r.ok).toBe(false);
  });

  it("rejects an unterminated block", () => {
    const source = `strategy X { base { liquidity = 100% spread = 10bps }`;
    const r = tryCompile(source);
    expect(r.ok).toBe(false);
  });

  it("rejects an unexpected character", () => {
    const source = `strategy X { base { liquidity = 100% spread = 10bps } when volatility > 50% { liquidity @ 25% } }`;
    const r = tryCompile(source);
    expect(r.ok).toBe(false);
  });

  it("rejects duplicate base blocks", () => {
    const source = `
      strategy X {
        base { liquidity = 100% spread = 10bps }
        base { liquidity = 90% spread = 10bps }
        when volatility > 50% { liquidity = 25% }
      }
    `;
    const r = tryCompile(source);
    expect(r.ok).toBe(false);
  });
});

describe("invalid programs: semantics", () => {
  it("rejects an unknown variable", () => {
    const source = `
      strategy X {
        base { liquidity = 100% spread = 10bps }
        when banana > 50% { liquidity = 25% }
      }
    `;
    const r = tryCompile(source);
    expect(r.ok).toBe(false);
    if (!r.ok) expect(r.errors[0]!.message).toMatch(/unknown variable 'banana'/);
  });

  it("rejects liquidity above 100%", () => {
    const source = `
      strategy X {
        base { liquidity = 100% spread = 10bps }
        when volatility > 50% { liquidity = 500% }
      }
    `;
    const r = tryCompile(source);
    expect(r.ok).toBe(false);
    if (!r.ok) expect(r.errors[0]!.message).toMatch(/100%/);
  });

  it("rejects negative spread", () => {
    const source = `
      strategy X {
        base { liquidity = 100% spread = -20bps }
        when volatility > 50% { liquidity = 25% }
      }
    `;
    const r = tryCompile(source);
    expect(r.ok).toBe(false);
    if (!r.ok) expect(r.errors[0]!.message).toMatch(/negative/);
  });

  it("rejects a base liquidity/spread given without a unit", () => {
    const source = `
      strategy X {
        base { liquidity = 100 spread = 10bps }
        when volatility > 50% { liquidity = 25% }
      }
    `;
    const r = tryCompile(source);
    expect(r.ok).toBe(false);
  });

  it("rejects mode compared with a relational operator", () => {
    const source = `
      strategy X {
        base { liquidity = 100% spread = 10bps }
        when mode > NORMAL { liquidity = 25% }
      }
    `;
    const r = tryCompile(source);
    expect(r.ok).toBe(false);
  });

  it("rejects an unknown mode name", () => {
    const source = `
      strategy X {
        base { liquidity = 100% spread = 10bps }
        when mode == PANIC { liquidity = 25% }
      }
    `;
    const r = tryCompile(source);
    expect(r.ok).toBe(false);
  });

  it("rejects calling a plain variable like a function", () => {
    const source = `
      strategy X {
        base { liquidity = 100% spread = 10bps }
        when volatility(5m) > 50% { liquidity = 25% }
      }
    `;
    const r = tryCompile(source);
    expect(r.ok).toBe(false);
  });

  it("rejects priceChange with an unsupported window", () => {
    const source = `
      strategy X {
        base { liquidity = 100% spread = 10bps }
        when priceChange(15m) > 3% { liquidity = 25% }
      }
    `;
    const r = tryCompile(source);
    expect(r.ok).toBe(false);
    if (!r.ok) expect(r.errors[0]!.message).toMatch(/window/);
  });

  it("rejects an unknown action target", () => {
    const source = `
      strategy X {
        base { liquidity = 100% spread = 10bps }
        when volatility > 50% { fee = 5% }
      }
    `;
    const r = tryCompile(source);
    expect(r.ok).toBe(false);
  });

  it("rejects '*=' on spread and '+=' on liquidity", () => {
    const bad1 = `
      strategy X { base { liquidity = 100% spread = 10bps } when volatility > 50% { spread *= 50% } }
    `;
    const bad2 = `
      strategy X { base { liquidity = 100% spread = 10bps } when volatility > 50% { liquidity += 50% } }
    `;
    expect(tryCompile(bad1).ok).toBe(false);
    expect(tryCompile(bad2).ok).toBe(false);
  });

  it("reports every error in a file with multiple problems, not just the first", () => {
    const source = `
      strategy X {
        base { liquidity = 500% spread = 999999bps }
        when banana > 50% { liquidity = 25% }
      }
    `;
    const r = tryCompile(source);
    expect(r.ok).toBe(false);
    if (!r.ok) expect(r.errors.length).toBeGreaterThanOrEqual(3);
  });

  it("rejects too many rules", () => {
    const rules = Array.from({ length: 17 }, (_, i) => `when volatility > ${i}% { liquidity = 10% }`).join("\n");
    const source = `strategy X { base { liquidity = 100% spread = 10bps } ${rules} }`;
    const r = tryCompile(source);
    expect(r.ok).toBe(false);
  });

  it("rejects too many conditions in one rule", () => {
    const source = `
      strategy X {
        base { liquidity = 100% spread = 10bps }
        when volatility > 1% and volatility > 2% and volatility > 3% and volatility > 4% and volatility > 5% {
          liquidity = 25%
        }
      }
    `;
    const r = tryCompile(source);
    expect(r.ok).toBe(false);
  });

  it("rejects too many actions in one rule", () => {
    const source = `
      strategy X {
        base { liquidity = 100% spread = 10bps }
        when volatility > 50% {
          liquidity = 10%
          spread = 10bps
          liquidity = 20%
          spread = 20bps
          liquidity = 30%
        }
      }
    `;
    const r = tryCompile(source);
    expect(r.ok).toBe(false);
  });
});

describe("determinism", () => {
  it("compiling the same source 100 times yields identical hash, IR and bytecode", () => {
    const source = `
      strategy ETH_USDC {
        base { liquidity = 100% spread = 20bps }
        when mode == NORMAL and volatility >= 50% { mode = DEFENSIVE liquidity = 25% spread = 90bps }
        when mode == DEFENSIVE and volatility < 30% for 10 minutes { mode = RECOVERY liquidity = 50% spread = 50bps }
      }
    `;
    const first = compile(source);
    for (let i = 0; i < 100; i++) {
      const next = compile(source);
      expect(next.programHash).toBe(first.programHash);
      expect(next.bytecode).toBe(first.bytecode);
      expect(next.ir).toEqual(first.ir);
    }
  });
});
