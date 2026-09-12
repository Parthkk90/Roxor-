import { keccak256 } from "viem";

import { parse } from "./parser.js";
import { analyze } from "./semantics.js";
import { optimize } from "./optimizer.js";
import { emitRuleProgram } from "./backends/ruleProgram.js";
import { CompileError, type CompilationResult, type Diagnostic } from "../types/index.js";

export interface CompileOptions {
  /** Set false to emit the IR exactly as written, without peephole cleanups. */
  optimize?: boolean;
}

/**
 * Compile CLF source to a deployable rule program.
 *
 * The pipeline is source -> tokens -> AST -> IR -> bytecode, with semantic checking between AST and
 * IR. It is deterministic by construction: no timestamps, no map iteration order, no randomness, so
 * the same source and compiler version always yield the same bytecode and the same hash.
 */
export function compile(source: string, options: CompileOptions = {}): CompilationResult {
  const ast = parse(source);
  const rawIr = analyze(ast);

  const { ir, warnings } = options.optimize === false ? { ir: rawIr, warnings: [] as Diagnostic[] } : optimize(rawIr);

  const bytecode = emitRuleProgram(ir);

  return {
    success: true,
    strategyName: ir.name,
    programHash: keccak256(bytecode),
    ast,
    ir,
    bytecode,
    errors: [],
    warnings,
  };
}

/** Non-throwing variant, for callers that would rather inspect diagnostics than catch. */
export function tryCompile(
  source: string,
  options: CompileOptions = {},
): { ok: true; result: CompilationResult } | { ok: false; errors: Diagnostic[] } {
  try {
    return { ok: true, result: compile(source, options) };
  } catch (error) {
    if (error instanceof CompileError) return { ok: false, errors: error.diagnostics };
    throw error;
  }
}

export { CompileError };
export * from "../types/index.js";
