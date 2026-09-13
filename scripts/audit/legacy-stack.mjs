/**
 * Reproduces the finding that decided the whole deployment: the marketplace contracts that Sepolia
 * carried before this work do not implement the executable-liquidity interface at all.
 *
 * These addresses are the ones `app/src/config/markets.ts` used to ship. They are still on chain
 * and still answer some calls, which is exactly why "it responds" was not accepted as evidence.
 * Run against the ABIs this repository builds today:
 *
 *   node scripts/audit/legacy-stack.mjs
 *
 * Expected output: the venues answer their immutables, fail to decode `snapshot`, and revert on
 * `executableLiquidity`; the Solver still returns a route, with no solvency check behind it.
 */
import { getAddress, parseAbi } from "viem";
import { client, artifact } from "./lib.mjs";

const LEGACY = {
  tokenIn: "0x246b76e37825a473Ae784Ce14A2Bb42733A8f922",
  tokenOut: "0xFE14a75D92e1A028ebb497dAc4D25bF2e08B3Af3",
  solver: "0xD8F26302929952DD220582C6eDCB4058E875b57A",
  aquaVenue: "0x47da4A55562AaDe84B7AEC13287e56125f6dfCe1",
  uniVenue: "0x29364BB65a835b2A1e9776558E1f1966aDfaB120",
  // Note the checksum: the shipped config spelled this `0x40b30ecEf85eA5e850373544Ba3a6d02BD7b49A2`,
  // which is a *different* mixed-case string whose checksum does not verify. viem rejects such an
  // address outright, so that read threw in the browser regardless of what was deployed.
  aquaOracle: "0x40b30ECEF85Ea5E850373544ba3A6D02bd7b49a2",
};

const J = (v) => JSON.stringify(v, (_, x) => (typeof x === "bigint" ? x.toString() : x));
const probe = async (label, fn) => {
  try {
    console.log(` ok   ${label}: ${J(await fn())}`);
  } catch (e) {
    console.log(` FAIL ${label}: ${String(e.shortMessage ?? e.message).split("\n")[0]}`);
  }
};

const venueAbi = artifact("AquaVenue").abi;

console.log("-- current ABIs against the superseded venues --");
await probe("aquaVenue.STRATEGY_ID()", () =>
  client.readContract({ address: LEGACY.aquaVenue, abi: venueAbi, functionName: "STRATEGY_ID" }));
for (const [label, address] of [["aquaVenue", LEGACY.aquaVenue], ["uniVenue", LEGACY.uniVenue]]) {
  for (const functionName of ["snapshot", "executableLiquidity"]) {
    await probe(`${label}.${functionName}()`, () =>
      client.readContract({ address, abi: venueAbi, functionName, args: [LEGACY.tokenIn, LEGACY.tokenOut] }));
  }
}

/**
 * The same call decoded against the shape those contracts actually return: six fields, 192 bytes,
 * with no `coverageBps`. That it decodes cleanly here is the proof the failures above are a
 * version mismatch rather than an unreachable contract.
 */
console.log("\n-- the same reads, decoded with the six-field VenueSnapshot they predate --");
const legacyAbi = parseAbi([
  "struct LegacySnapshot { address venue; bytes32 strategyId; uint8 mode; uint256 effectiveLiquidity; uint16 spreadBps; uint256 referencePrice; }",
  "function snapshot(address tokenIn, address tokenOut) view returns (LegacySnapshot)",
]);
for (const [label, address] of [["aquaVenue", LEGACY.aquaVenue], ["uniVenue", LEGACY.uniVenue]]) {
  await probe(`${label}.snapshot() [legacy shape]`, () =>
    client.readContract({ address, abi: legacyAbi, functionName: "snapshot", args: [LEGACY.tokenIn, LEGACY.tokenOut] }));
}

console.log("\n-- the superseded Solver still routes, against depth nothing bounds --");
await probe("solver.route(1 tokenIn)", () =>
  client.readContract({
    address: LEGACY.solver, abi: artifact("Solver").abi, functionName: "route",
    args: [{ tokenIn: LEGACY.tokenIn, tokenOut: LEGACY.tokenOut, amount: 10n ** 18n, maxSlippageBps: 10_000 }],
  }));

console.log("\n-- the mis-checksummed oracle address the frontend shipped --");
const SHIPPED_SPELLING = "0x40b30ecEf85eA5e850373544Ba3a6d02BD7b49A2";
console.log(` info canonical spelling is ${getAddress(SHIPPED_SPELLING)}, shipped was ${SHIPPED_SPELLING}`);
const oracleAbi = artifact("MockMarketStateProvider").abi;
const STRATEGY = "0xd4e296704cf420357c0d20976f594a2e301e01b4da3734f2b37d5184d852a2df";
// Expected to FAIL: viem validates a mixed-case address against its checksum before it will send
// the call at all, so this read threw in the browser whatever was deployed behind it.
await probe("getMarketState via the shipped spelling", () =>
  client.readContract({ address: SHIPPED_SPELLING, abi: oracleAbi, functionName: "getMarketState", args: [STRATEGY] }));
// Expected to succeed: same contract, correct checksum.
await probe("getMarketState via the correct spelling", () =>
  client.readContract({ address: LEGACY.aquaOracle, abi: oracleAbi, functionName: "getMarketState", args: [STRATEGY] }));
