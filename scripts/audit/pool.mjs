import { client, artifact } from "./lib.mjs";
import { encodeAbiParameters, keccak256, parseAbi, getAddress, formatUnits } from "viem";

const DYNAMIC_FEE = 0x800000;
const TICK_SPACING = 60;
const tokenA = "0x246b76e37825a473Ae784Ce14A2Bb42733A8f922";
const tokenB = "0xFE14a75D92e1A028ebb497dAc4D25bF2e08B3Af3";
const hook = getAddress("0xBd0c7E36dbCd7A62626D16505B600Da4795F4080");
const projectPM = getAddress("0x7C881eb559C77d67c94287Ca9AdEE7944D43ba21");
const officialPM = getAddress("0xE03A1074c86CFeDd5C142C4F04F1a1536e203543");
const [c0, c1] = tokenA.toLowerCase() < tokenB.toLowerCase() ? [tokenA, tokenB] : [tokenB, tokenA];

const KEY_T = [{ type: "address" }, { type: "address" }, { type: "uint24" }, { type: "int24" }, { type: "address" }];
const poolId = keccak256(encodeAbiParameters(KEY_T, [c0, c1, DYNAMIC_FEE, TICK_SPACING, hook]));
console.log("currency0", c0, "currency1", c1);
console.log("poolId (dynamic fee)", poolId);

const hk = artifact("ConditionalLiquidityHook").abi;
const J = (v) => JSON.stringify(v, (_, x) => (typeof x === "bigint" ? x.toString() : x));
const p = async (l, f) => { try { console.log(" ok ", l, J(await f())); } catch (e) { console.log(" FAIL", l, String(e.shortMessage ?? e.message).split("\n")[0]); } };

await p("hook.getPoolStrategy(poolId)", () => client.readContract({ address: hook, abi: hk, functionName: "getPoolStrategy", args: [poolId] }));
await p("hook.getStrategyId(poolId)",  () => client.readContract({ address: hook, abi: hk, functionName: "getStrategyId", args: [poolId] }));
await p("hook.getCurrentMode(poolId)", () => client.readContract({ address: hook, abi: hk, functionName: "getCurrentMode", args: [poolId] }));
await p("hook.quoteSnapshot(poolId)",  () => client.readContract({ address: hook, abi: hk, functionName: "quoteSnapshot", args: [poolId] }));

// Pool slot0 lives at keccak256(poolId . POOLS_SLOT=6) in v4's PoolManager.
const pm = parseAbi(["function extsload(bytes32) view returns (bytes32)"]);
const stateSlot = keccak256(encodeAbiParameters([{ type: "bytes32" }, { type: "uint256" }], [poolId, 6n]));
for (const [label, address] of [["project PM", projectPM], ["official PM", officialPM]]) {
  const slot0 = await client.readContract({ address, abi: pm, functionName: "extsload", args: [stateSlot] });
  const liqSlot = "0x" + (BigInt(stateSlot) + 3n).toString(16).padStart(64, "0");
  const liq = await client.readContract({ address, abi: pm, functionName: "extsload", args: [liqSlot] });
  console.log(`${label}: slot0=${slot0}`);
  console.log(`${label}: liquidity=${BigInt(liq)}`);
}

const erc = parseAbi(["function balanceOf(address) view returns (uint256)"]);
for (const [n, t] of [["currency0", c0], ["currency1", c1]]) {
  const b = await client.readContract({ address: getAddress(t), abi: erc, functionName: "balanceOf", args: [projectPM] });
  console.log(`project PM holds ${formatUnits(b, 18)} ${n}`);
}
