import type { Diagnostic, IRRule, StrategyIR } from "../types/index.js";

export interface OptimizationOutcome {
  ir: StrategyIR;
  warnings: Diagnostic[];
}

/**
 * Peephole cleanups on the IR. Deliberately conservative: this is not an optimising compiler, it
 * just removes writes that provably cannot be observed, and reports anything it drops so the
 * author is never silently second-guessed.
 *
 * Every transform preserves observable behaviour exactly, which matters because the golden tests
 * compare bytecode byte-for-byte.
 */
export function optimize(ir: StrategyIR): OptimizationOutcome {
  const warnings: Diagnostic[] = [];
  const pos = { line: 0, column: 0 };

  const rules: IRRule[] = ir.rules.map((rule, ruleIndex) => {
    // Within one rule, actions apply in order to the same state. A later write to the same target
    // therefore overwrites an earlier one, so only the last write of each target survives.
    // MULTIPLY_LIQUIDITY / ADD_SPREAD compose with the prior value rather than replacing it, so
    // they are never eliminated.
    const OVERWRITING = new Set([0, 1, 2]); // SET_MODE, SET_LIQUIDITY, SET_SPREAD

    const lastWriteIndex = new Map<number, number>();
    rule.actions.forEach((action, i) => {
      if (OVERWRITING.has(action.type)) lastWriteIndex.set(action.type, i);
    });

    const actions = rule.actions.filter((action, i) => {
      if (!OVERWRITING.has(action.type)) return true;
      const keep = lastWriteIndex.get(action.type) === i;
      if (!keep) {
        warnings.push({
          message: `rule ${ruleIndex + 1}: dropped a redundant write that is overwritten later in the same rule`,
          pos,
        });
      }
      return keep;
    });

    // Duplicate conditions are a conjunction of the same test, so they are idempotent.
    const seen = new Set<string>();
    const conditions = rule.conditions.filter((c) => {
      const key = `${c.type}:${c.operator}:${c.value}`;
      if (seen.has(key)) {
        warnings.push({ message: `rule ${ruleIndex + 1}: dropped a duplicate condition`, pos });
        return false;
      }
      seen.add(key);
      return true;
    });

    return { ...rule, conditions, actions };
  });

  // A rule that can never be reached because an identical earlier rule always matches first.
  const ruleKeys = new Set<string>();
  const reachable: IRRule[] = [];
  rules.forEach((rule, i) => {
    const key = JSON.stringify({ c: rule.conditions, d: rule.durationSeconds });
    if (ruleKeys.has(key)) {
      warnings.push({
        message: `rule ${i + 1} is unreachable: an earlier rule has identical conditions and always matches first`,
        pos,
      });
      return;
    }
    ruleKeys.add(key);
    reachable.push(rule);
  });

  return { ir: { ...ir, rules: reachable }, warnings };
}
