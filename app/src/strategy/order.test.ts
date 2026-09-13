import { describe, expect, it } from "vitest";

import { SWAP_VM_OPCODES } from "../abis/index.js";
import { buildAquaOrder, buildSwapProgram, strategyIdOf } from "./order";
import { compileParams, DEFAULT_PARAMS, toIR, validateParams } from "./params";
import { decodeProgram, describeAction, describeCondition, recoveryRequirement } from "./decode";

/**
 * The live Ethereum Sepolia strategy, from `deployments/11155111.json`, and the public inputs it
 * was built from (`script/DeployAquaFix.s.sol`, reconstructed and asserted on-chain by
 * `script/DeploySepolia.s.sol`).
 *
 * This is the only check that can tell whether the browser's order builder is byte-exact: the id
 * is `keccak256(abi.encode(order))`, so reproducing it from maker + pair + extruction target means
 * every trait bit, every order-data index and every program byte matched what 1inch's Solidity
 * produced. Anything less exact would hash to something else entirely.
 */
const SEPOLIA = {
  maker: "0x025e4Cd04a671C309572fA3E6dEc9A8C79b847F4",
  tokenA: "0x246b76e37825a473Ae784Ce14A2Bb42733A8f922",
  tokenB: "0xFE14a75D92e1A028ebb497dAc4D25bF2e08B3Af3",
  extruction: "0xb21Bf6e48FbcFDf83a7685924A244510Db08bC75",
  strategyId: "0xd4e296704cf420357c0d20976f594a2e301e01b4da3734f2b37d5184d852a2df",
} as const;

describe("SwapVM order builder", () => {
  const program = buildSwapProgram(SWAP_VM_OPCODES, SEPOLIA.extruction);

  it("emits the same SwapVM program as ConditionalLiquidityProgramLib.build", () => {
    // XYCSwap with no args, then Extruction carrying a 20-byte target: [50][00][04][14][target].
    expect(program).toBe(`0x500004${(20).toString(16)}${SEPOLIA.extruction.slice(2).toLowerCase()}`);
  });

  it("reproduces the strategy id registered on Sepolia", () => {
    const order = buildAquaOrder(SEPOLIA.maker, SEPOLIA.tokenA, SEPOLIA.tokenB, program);
    expect(strategyIdOf(order)).toBe(SEPOLIA.strategyId);
  });

  it("refuses an unsorted pair, as SwapVM itself does", () => {
    expect(() => buildAquaOrder(SEPOLIA.maker, SEPOLIA.tokenB, SEPOLIA.tokenA, program)).toThrow(/sort/i);
  });
});

describe("strategy parameters", () => {
  it("compiles to a program the decoder reads back unchanged", () => {
    const decoded = decodeProgram(compileParams(DEFAULT_PARAMS));
    expect(decoded.version).toBe(1);
    expect(decoded.rules).toHaveLength(4);

    // Rule 0: NORMAL + volatility >= 50% -> DEFENSIVE at 25% / 90bps, no timer.
    expect(decoded.rules[0].durationSeconds).toBe(0);
    expect(decoded.rules[0].conditions[1].operand).toBe(5_000n);
    expect(decoded.rules[0].actions.map((a) => a.operand)).toEqual([1n, 2_500n, 90n]);

    // Rule 1 carries the calm gate; rule 3 the recovery timer.
    expect(decoded.rules[1].durationSeconds).toBe(600);
    expect(decoded.rules[3].conditions[1].operand).toBe(600n);
  });

  it("carries every configured parameter into the emitted bytes", () => {
    const decoded = decodeProgram(
      compileParams({
        ...DEFAULT_PARAMS,
        enterDefensiveBps: 4_200,
        leaveDefensiveBps: 1_100,
        calmPeriodSeconds: 300,
        recoveryPeriodSeconds: 900,
        defensiveLiquidityBps: 1_000,
        defensiveSpreadBps: 120,
      })
    );
    expect(decoded.rules[0].conditions[1].operand).toBe(4_200n);
    expect(decoded.rules[0].actions[1].operand).toBe(1_000n);
    expect(decoded.rules[0].actions[2].operand).toBe(120n);
    expect(decoded.rules[1].conditions[1].operand).toBe(1_100n);
    expect(decoded.rules[1].durationSeconds).toBe(300);
    expect(decoded.rules[3].conditions[1].operand).toBe(900n);
  });

  it("reads the recovery requirement back out of the program", () => {
    expect(recoveryRequirement(decodeProgram(compileParams(DEFAULT_PARAMS)))).toEqual({
      thresholdBps: 3_000,
      seconds: 600,
    });
  });

  it("describes rules in the same terms the parameters were given in", () => {
    const rule = decodeProgram(compileParams(DEFAULT_PARAMS)).rules[0];
    expect(rule.conditions.map(describeCondition)).toEqual(["state is Normal", "volatility at or above 50%"]);
    expect(rule.actions.map(describeAction)).toEqual([
      "enter Defensive",
      "quote 25% of deliverable",
      "charge 0.9%",
    ]);
  });

  it("keeps the base configuration in the IR, where registerStrategy takes it separately", () => {
    const ir = toIR({ ...DEFAULT_PARAMS, normalLiquidityBps: 8_000, normalSpreadBps: 35 });
    expect(ir.base).toEqual({ liquidityBps: 8_000, spreadBps: 35 });
  });

  describe("validation", () => {
    it("accepts the deployed defaults", () => {
      expect(validateParams(DEFAULT_PARAMS)).toEqual([]);
    });

    it("rejects a missing hysteresis band", () => {
      expect(validateParams({ ...DEFAULT_PARAMS, leaveDefensiveBps: 5_000 })).toContainEqual(
        expect.stringMatching(/below the defensive threshold/)
      );
    });

    it("rejects a liquidity multiplier above 100%, which the chain would reject too", () => {
      expect(validateParams({ ...DEFAULT_PARAMS, normalLiquidityBps: 10_001 })).toContainEqual(
        expect.stringMatching(/Normal liquidity/)
      );
    });

    it("rejects defending by quoting more than normal", () => {
      expect(validateParams({ ...DEFAULT_PARAMS, defensiveLiquidityBps: 10_000, normalLiquidityBps: 5_000 })).toContainEqual(
        expect.stringMatching(/cannot exceed normal liquidity/)
      );
    });
  });
});
