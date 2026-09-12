/**
 * Copy the ABIs the subgraph indexes out of `forge build` output.
 *
 * Run after any contract change: the manifest's event signatures are matched against these files
 * at codegen time, so a stale ABI here fails loudly at build rather than silently indexing nothing.
 */
import { mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";

const here = dirname(fileURLToPath(import.meta.url));
const root = join(here, "..", "..");
const outDir = join(root, "out");
const abiDir = join(here, "..", "abis");

const CONTRACTS = [
  ["ConditionalLiquidityRegistry.sol", "ConditionalLiquidityRegistry"],
  ["ConditionalLiquidityEngine.sol", "ConditionalLiquidityEngine"],
  ["ConditionalLiquidityHook.sol", "ConditionalLiquidityHook"],
  ["Solver.sol", "Solver"],
];

mkdirSync(abiDir, { recursive: true });

for (const [file, name] of CONTRACTS) {
  const artifactPath = join(outDir, file, `${name}.json`);
  const artifact = JSON.parse(readFileSync(artifactPath, "utf8"));
  writeFileSync(join(abiDir, `${name}.json`), `${JSON.stringify(artifact.abi, null, 2)}\n`);
  console.log(`synced ${name} (${artifact.abi.length} entries)`);
}
