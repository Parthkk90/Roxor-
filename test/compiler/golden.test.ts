import { readFileSync } from "node:fs";
import { join } from "node:path";
import { describe, expect, it } from "vitest";

import { compile } from "../../src/compiler/index.js";

/**
 * Golden test: locks the compiler's output for the canonical example strategy.
 *
 * If this fails after a deliberate compiler change, regenerate with:
 *   npm run compile examples/volatility-shield.clf --emit test/compiler/golden
 * and review the diff before committing it - an unreviewed regeneration defeats the point of a
 * golden test.
 */
describe("golden: volatility-shield.clf", () => {
  const source = readFileSync(join(__dirname, "../../examples/volatility-shield.clf"), "utf8");
  const golden = join(__dirname, "golden");

  it("matches the committed IR", () => {
    const { ir } = compile(source);
    const expected = JSON.parse(readFileSync(join(golden, "volatility-shield.ir.json"), "utf8"));
    expect(ir).toEqual(expected);
  });

  it("matches the committed bytecode", () => {
    const { bytecode } = compile(source);
    const expected = readFileSync(join(golden, "volatility-shield.bytecode.hex"), "utf8").trim();
    expect(bytecode).toBe(expected);
  });
});
