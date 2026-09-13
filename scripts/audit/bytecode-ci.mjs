/**
 * The `DeployAquaFix` half of the Sepolia stack was broadcast under FOUNDRY_PROFILE=ci
 * (optimizer_runs = 700) because `AquaSwapVMRouter` exceeds EIP-170 under the default profile.
 * Comparing it against the default-profile artifacts is meaningless; this compares it against
 * `out-ci/`, produced by:
 *
 *   FOUNDRY_PROFILE=ci forge build --skip test/utils/deployers/PoolManagerImport.sol --out out-ci
 */
import { client, similarity } from "./lib.mjs";
import { readFileSync } from "node:fs";
import { join } from "node:path";
import { ROOT } from "./lib.mjs";

const ci = (name, file = `${name}.sol`) =>
  JSON.parse(readFileSync(join(ROOT, "out-ci", file, `${name}.json`), "utf8"));

const SET = [
  ["MockWETH", "0x8d302a3123b6c710f9ee5d858e3b06ab0b6f478d", "MockWETH"],
  ["Aqua", "0xb9e780c07b3d36af0090b011bd0233ca8b212844", "Aqua"],
  ["AquaSwapVMRouter", "0x8fcf7d68df61a9fcf2009e606ff632e97bddeaec", "AquaSwapVMRouter"],
  ["StrategyValidator", "0xfb60848da80e110836959714bb9af4aba17cc5ec", "StrategyValidator"],
  ["Registry", "0x9888e8c6cffbebf792c6b0b3d1085b7b11da61a7", "ConditionalLiquidityRegistry"],
  ["MockMarketStateProvider", "0x40b30ecef85ea5e850373544ba3a6d02bd7b49a2", "MockMarketStateProvider"],
  ["Engine", "0x1ee607310423099d47f3b35d59f8bb66690ec952", "ConditionalLiquidityEngine"],
  ["Extruction", "0xb21bf6e48fbcfdf83a7685924a244510db08bc75", "ConditionalLiquidityExtruction"],
  ["AquaVenue", "0x47da4a55562aade84b7aec13287e56125f6dfce1", "AquaVenue"],
  ["Solver", "0xd8f26302929952dd220582c6edcb4058e875b57a", "Solver"],
  // The Uniswap half was NOT redeployed by DeployAquaFix - it is still the default-profile
  // DeploySolver deployment, listed here to confirm it does not match the ci artifacts.
  ["UniswapV4Venue (from DeploySolver)", "0x29364bb65a835b2a1e9776558e1f1966adfab120", "UniswapV4Venue"],
  ["ConditionalLiquidityHook (from DeploySolver)", "0xbd0c7e36dbcd7a62626d16505b600da4795f4080", "ConditionalLiquidityHook"],
];

const FILE = { Aqua: "Aqua.sol", AquaSwapVMRouter: "AquaSwapVMRouter.sol" };
const rows = [];
for (const [role, address, art] of SET) {
  const code = await client.getCode({ address });
  const a = ci(art, FILE[art]);
  const s = similarity(code, a.deployedBytecode.object);
  rows.push({
    role,
    address,
    onchain: (code.length - 2) / 2,
    artifact: (a.deployedBytecode.object.length - 2) / 2,
    verdict: s.sameLength ? `${(s.ratio * 100).toFixed(2)}% identical` : "LENGTH MISMATCH",
  });
}
console.table(rows);
