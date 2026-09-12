#!/usr/bin/env node
import { readFileSync, writeFileSync, mkdirSync } from "node:fs";
import { basename, join } from "node:path";

import { tryCompile } from "./compiler/index.js";
import { ActionNames, ComparisonNames, ConditionNames } from "./types/names.js";
import type { Diagnostic } from "./types/index.js";

function renderDiagnostic(d: Diagnostic, source: string): string {
  const lines = source.split("\n");
  const line = d.sourceLine ?? lines[d.pos.line - 1] ?? "";
  const caret = `${" ".repeat(Math.max(0, d.pos.column - 1))}^`;
  return [
    `  error: ${d.message}`,
    `   --> line ${d.pos.line}, column ${d.pos.column}`,
    line ? `    | ${line}` : "",
    line ? `    | ${caret}` : "",
  ]
    .filter(Boolean)
    .join("\n");
}

function main(): number {
  const args = process.argv.slice(2);
  const emitIndex = args.indexOf("--emit");
  const emitDir = emitIndex >= 0 ? args[emitIndex + 1] : undefined;
  const emitValueIndex = emitIndex >= 0 ? emitIndex + 1 : -1;
  const files = args.filter((a, i) => !a.startsWith("--") && i !== emitValueIndex);

  if (files.length === 0) {
    console.error("usage: npm run compile <file.clf> [--emit <dir>]");
    return 2;
  }

  let failed = false;

  for (const file of files) {
    const source = readFileSync(file, "utf8");
    const outcome = tryCompile(source);

    if (!outcome.ok) {
      console.error(`\n${file}`);
      console.error(`Status: INVALID\n`);
      for (const d of outcome.errors) console.error(renderDiagnostic(d, source));
      console.error(`\n${outcome.errors.length} error(s)`);
      failed = true;
      continue;
    }

    const { result } = outcome;
    const { ir } = result;

    console.log(`\nStrategy: ${result.strategyName}`);
    console.log(`Status:   VALID`);
    console.log(`\nProgram Hash:\n  ${result.programHash}`);
    console.log(`\nBase:\n  liquidity ${ir.base.liquidityBps / 100}%   spread ${ir.base.spreadBps}bps`);
    console.log(`\nRules: ${ir.rules.length}`);

    ir.rules.forEach((rule, i) => {
      const conds = rule.conditions
        .map((c) => `${ConditionNames[c.type]} ${ComparisonNames[c.operator]} ${c.value}`)
        .join(" and ");
      const sustained = rule.durationSeconds > 0 ? ` for ${rule.durationSeconds}s` : "";
      const acts = rule.actions.map((a) => `${ActionNames[a.type]} ${a.value}`).join(", ");
      console.log(`  ${i + 1}. when ${conds}${sustained}`);
      console.log(`     -> ${acts}`);
    });

    console.log(`\nRule program: ${(result.bytecode.length - 2) / 2} bytes`);
    console.log(`  ${result.bytecode}`);

    for (const w of result.warnings) console.log(`\n  warning: ${w.message}`);

    if (emitDir) {
      mkdirSync(emitDir, { recursive: true });
      const stem = basename(file).replace(/\.clf$/, "");
      writeFileSync(join(emitDir, `${stem}.ir.json`), `${JSON.stringify(ir, null, 2)}\n`);
      writeFileSync(join(emitDir, `${stem}.bytecode.hex`), `${result.bytecode}\n`);
      console.log(`\nWrote ${join(emitDir, `${stem}.ir.json`)} and ${join(emitDir, `${stem}.bytecode.hex`)}`);
    }
  }

  return failed ? 1 : 0;
}

process.exit(main());
