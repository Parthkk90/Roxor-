/**
 * Step 1 of the Sepolia audit: does every address the repo claims is deployed actually hold code,
 * and does that code correspond to the artifact the broadcast file names?
 *
 * Run: node scripts/audit/bytecode.mjs
 */
import { client, artifact, similarity } from "./lib.mjs";

/** Every contract-creation from the two Sepolia broadcast runs, in deployment order. */
const CANDIDATES = [
  // --- broadcast/DeploySolver.s.sol/11155111 (blocks 11684201-11684204) ---
  ["DeploySolver", "MockERC20 (token A)", "0xfe14a75d92e1a028ebb497dac4d25bf2e08b3af3", "MockERC20"],
  ["DeploySolver", "MockERC20 (token B)", "0x246b76e37825a473ae784ce14a2bb42733a8f922", "MockERC20"],
  ["DeploySolver", "MockWETH", "0xc3641eb078a9e72561a7f93431175582154351a0", "MockWETH"],
  ["DeploySolver", "Aqua", "0xb685bb8f82353834a4113c6c4993c000633e4f57", "Aqua"],
  ["DeploySolver", "AquaSwapVMRouter", "0x302cd5b134a1005b4700e3687445d9825ede09ea", "AquaSwapVMRouter"],
  ["DeploySolver", "StrategyValidator (aqua)", "0xc07ad41ec5f28721a85c452b5bd7b5c66e75031d", "StrategyValidator"],
  ["DeploySolver", "Registry (aqua)", "0x9b3774bd9b2d6804cc44612b9f8b675486138f1a", "ConditionalLiquidityRegistry"],
  ["DeploySolver", "MockMarketStateProvider (aqua)", "0x67ceebb808e999d64e5175129f560d0646d6ba6e", "MockMarketStateProvider"],
  ["DeploySolver", "Engine (aqua)", "0x8134be4f0fa716b96fc220894c8e87d6d1cb7173", "ConditionalLiquidityEngine"],
  ["DeploySolver", "Extruction", "0x1f1b2d963ccf73a49b1a293db46ffc0897cd81c5", "ConditionalLiquidityExtruction"],
  ["DeploySolver", "StrategyValidator (uni)", "0xafc8ca9b90b2e462b9f2c29e015d78257e2db3be", "StrategyValidator"],
  ["DeploySolver", "Registry (uni)", "0x738b102e559eebe23f5a67cc61798cbcb14284db", "ConditionalLiquidityRegistry"],
  ["DeploySolver", "MockMarketStateProvider (uni)", "0xd0b139bf9c0576a96b48c3b9c3c5b0ed336cabf4", "MockMarketStateProvider"],
  ["DeploySolver", "Engine (uni)", "0x4670cc0ab2322f5afcaa9ec91ee3fbe0d35a2d55", "ConditionalLiquidityEngine"],
  ["DeploySolver", "PoolManager", "0x7c881eb559c77d67c94287ca9adee7944d43ba21", null],
  ["DeploySolver", "PoolSwapTest", "0xf29512a1800378b976a59b5d8e1643dbaa40062c", null],
  ["DeploySolver", "PoolModifyLiquidityTest", "0x1a25b6ff2217a177657f6c33da847c1552bfc9b1", null],
  ["DeploySolver", "ConditionalLiquidityHook", "0xbd0c7e36dbcd7a62626d16505b600da4795f4080", "ConditionalLiquidityHook"],
  ["DeploySolver", "AquaVenue (superseded)", "0x3068f67dc9edaea8cf8d6a916dfd821750d4c2f7", "AquaVenue"],
  ["DeploySolver", "UniswapV4Venue", "0x29364bb65a835b2a1e9776558e1f1966adfab120", "UniswapV4Venue"],
  ["DeploySolver", "Solver (superseded)", "0x2144661b940a39b7c45bc3fd63fea29671355105", "Solver"],
  // --- broadcast/DeployAquaFix.s.sol/11155111 (blocks 11684301-11684303) ---
  ["DeployAquaFix", "MockWETH", "0x8d302a3123b6c710f9ee5d858e3b06ab0b6f478d", "MockWETH"],
  ["DeployAquaFix", "Aqua", "0xb9e780c07b3d36af0090b011bd0233ca8b212844", "Aqua"],
  ["DeployAquaFix", "AquaSwapVMRouter", "0x8fcf7d68df61a9fcf2009e606ff632e97bddeaec", "AquaSwapVMRouter"],
  ["DeployAquaFix", "StrategyValidator", "0xfb60848da80e110836959714bb9af4aba17cc5ec", "StrategyValidator"],
  ["DeployAquaFix", "Registry", "0x9888e8c6cffbebf792c6b0b3d1085b7b11da61a7", "ConditionalLiquidityRegistry"],
  ["DeployAquaFix", "MockMarketStateProvider", "0x40b30ecef85ea5e850373544ba3a6d02bd7b49a2", "MockMarketStateProvider"],
  ["DeployAquaFix", "Engine", "0x1ee607310423099d47f3b35d59f8bb66690ec952", "ConditionalLiquidityEngine"],
  ["DeployAquaFix", "Extruction", "0xb21bf6e48fbcfdf83a7685924a244510db08bc75", "ConditionalLiquidityExtruction"],
  ["DeployAquaFix", "AquaVenue", "0x47da4a55562aade84b7aec13287e56125f6dfce1", "AquaVenue"],
  ["DeployAquaFix", "Solver", "0xd8f26302929952dd220582c6edcb4058e875b57a", "Solver"],
];

const ARTIFACT_FILE = {
  Aqua: "Aqua.sol",
  AquaSwapVMRouter: "AquaSwapVMRouter.sol",
};

const rows = [];
for (const [run, role, address, art] of CANDIDATES) {
  const code = await client.getCode({ address });
  const size = code && code !== "0x" ? (code.length - 2) / 2 : 0;
  let match = "-";
  if (art && size > 0) {
    try {
      const a = artifact(art, ARTIFACT_FILE[art]);
      const s = similarity(code, a.deployedBytecode.object);
      match = s.sameLength ? `${(s.ratio * 100).toFixed(2)}% (${s.lenOn}B)` : `len ${s.lenOn} vs ${s.lenArt}`;
    } catch (e) {
      match = `artifact missing`;
    }
  }
  rows.push({ run, role, address, size, code: size > 0 ? "YES" : "EMPTY", match });
}
console.table(rows);
