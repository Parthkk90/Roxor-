import { LIMITS, type StrategyIR } from "../../types/index.js";

/**
 * Emit the rule-program bytecode consumed by `contracts/libraries/RuleProgram.sol`.
 *
 * The layout is specified in that file; this encoder is its mirror image. The Solidity test helper
 * `test/utils/RuleProgramBuilder.sol` produces the same bytes from the same logical rules, and
 * `test/compiler/differential.test.ts` asserts the two agree, so neither side can drift silently.
 *
 *   header       version:u8  ruleCount:u8
 *   rule header  conditionCount:u8  durationSeconds:u32  actionCount:u8
 *   condition    type:u8  comparison:u8  operand:i256      (34 bytes)
 *   action       type:u8  operand:u256                     (33 bytes)
 */
export function emitRuleProgram(ir: StrategyIR): `0x${string}` {
  const bytes: number[] = [];

  const u8 = (v: number) => {
    if (!Number.isInteger(v) || v < 0 || v > 0xff) throw new Error(`u8 out of range: ${v}`);
    bytes.push(v);
  };

  const u32 = (v: number) => {
    if (!Number.isInteger(v) || v < 0 || v > 0xffffffff) throw new Error(`u32 out of range: ${v}`);
    bytes.push((v >>> 24) & 0xff, (v >>> 16) & 0xff, (v >>> 8) & 0xff, v & 0xff);
  };

  /** Two's-complement big-endian 256-bit, so negative operands round-trip through `int256`. */
  const word = (value: bigint) => {
    const TWO_256 = 1n << 256n;
    let v = value % TWO_256;
    if (v < 0n) v += TWO_256;
    for (let shift = 248n; shift >= 0n; shift -= 8n) {
      bytes.push(Number((v >> shift) & 0xffn));
    }
  };

  u8(LIMITS.VERSION);
  u8(ir.rules.length);

  for (const rule of ir.rules) {
    u8(rule.conditions.length);
    u32(rule.durationSeconds);
    u8(rule.actions.length);

    for (const c of rule.conditions) {
      u8(c.type);
      u8(c.operator);
      word(BigInt(c.value));
    }
    for (const a of rule.actions) {
      u8(a.type);
      word(BigInt(a.value));
    }
  }

  return `0x${bytes.map((b) => b.toString(16).padStart(2, "0")).join("")}`;
}
