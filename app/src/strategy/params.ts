import {
  ActionType,
  Comparison,
  ConditionType,
  LIMITS,
  StrategyMode,
  type StrategyIR,
} from "../../../src/types/index.js";
import { emitRuleProgram } from "../../../src/compiler/backends/ruleProgram.js";

/**
 * The five parameters a maker may actually set, and their compilation into a real rule program.
 *
 * Every value here ends up as an operand inside bytecode that `contracts/libraries/RuleProgram.sol`
 * decodes and `RuleEngineLib` executes. Nothing in this file decides anything at runtime: it only
 * decides what the *program* says, once, at registration. The regime a strategy is in afterwards is
 * read back from chain, never computed here.
 *
 * The shape of the program - four rules, in this order - is the protocol's existing volatility
 * shield (`examples/volatility-shield.clf`, `test/utils/StrategyFixtures.sol`). What the UI exposes
 * is its thresholds, not its structure: an arbitrary rule graph would need the whole CLF surface in
 * the browser, and every extra degree of freedom is another way to register a strategy that is
 * valid but nonsensical.
 *
 * Encoding is delegated to the compiler's own backend (`src/compiler/backends/ruleProgram.ts`),
 * which is differentially tested against the Solidity decoder. A second encoder living here is
 * exactly the drift that test exists to catch.
 */
export interface StrategyParams {
  /** Volatility at or above which the strategy pulls back, in bps. */
  enterDefensiveBps: number;
  /** Volatility below which calm starts counting, in bps. Must be under `enterDefensiveBps`. */
  leaveDefensiveBps: number;
  /** How long that calm must hold before any liquidity returns, in seconds. */
  calmPeriodSeconds: number;
  /** How long RECOVERY must hold before returning to full size, in seconds. */
  recoveryPeriodSeconds: number;
  /** Liquidity multiplier in each mode, in bps. */
  normalLiquidityBps: number;
  defensiveLiquidityBps: number;
  recoveryLiquidityBps: number;
  /** Spread charged in each mode, in bps. */
  normalSpreadBps: number;
  defensiveSpreadBps: number;
  recoverySpreadBps: number;
}

/** The parameters the live Sepolia and anvil strategies were registered with. */
export const DEFAULT_PARAMS: StrategyParams = {
  enterDefensiveBps: 5_000,
  leaveDefensiveBps: 3_000,
  calmPeriodSeconds: 600,
  recoveryPeriodSeconds: 600,
  normalLiquidityBps: 10_000,
  defensiveLiquidityBps: 2_500,
  recoveryLiquidityBps: 5_000,
  normalSpreadBps: 20,
  defensiveSpreadBps: 90,
  recoverySpreadBps: 50,
};

/**
 * Reasons a parameter set cannot be registered, in the maker's language.
 *
 * These duplicate no on-chain check that matters: the deployed `StrategyValidator` is still called
 * before anything is signed (see `useRegisterStrategy`). They exist so a maker sees the problem
 * while typing instead of as a reverted transaction.
 */
export function validateParams(p: StrategyParams): string[] {
  const errors: string[] = [];
  const bps = (v: number, max: number, what: string) => {
    if (!Number.isInteger(v) || v < 0 || v > max) errors.push(`${what} must be between 0 and ${max / 100}%.`);
  };

  bps(p.enterDefensiveBps, LIMITS.BPS, "Defensive volatility threshold");
  bps(p.leaveDefensiveBps, LIMITS.BPS, "Recovery volatility threshold");
  bps(p.normalLiquidityBps, LIMITS.MAX_LIQUIDITY_BPS, "Normal liquidity");
  bps(p.defensiveLiquidityBps, LIMITS.MAX_LIQUIDITY_BPS, "Defensive liquidity");
  bps(p.recoveryLiquidityBps, LIMITS.MAX_LIQUIDITY_BPS, "Recovery liquidity");
  bps(p.normalSpreadBps, LIMITS.MAX_SPREAD_BPS, "Normal spread");
  bps(p.defensiveSpreadBps, LIMITS.MAX_SPREAD_BPS, "Defensive spread");
  bps(p.recoverySpreadBps, LIMITS.MAX_SPREAD_BPS, "Recovery spread");

  // Hysteresis, not a style preference: with a single threshold a market sitting on it makes the
  // strategy flap between postures on every evaluation.
  if (p.leaveDefensiveBps >= p.enterDefensiveBps) {
    errors.push("The recovery threshold must be below the defensive threshold, so the two do not flap.");
  }
  for (const [label, seconds] of [
    ["Calm period", p.calmPeriodSeconds],
    ["Recovery period", p.recoveryPeriodSeconds],
  ] as const) {
    if (!Number.isInteger(seconds) || seconds < 0 || seconds > 0xffff_ffff) {
      errors.push(`${label} must be a whole number of seconds.`);
    }
  }
  if (p.defensiveLiquidityBps > p.normalLiquidityBps) {
    errors.push("Defensive liquidity cannot exceed normal liquidity - defence means quoting less, not more.");
  }
  return errors;
}

const mode = (m: StrategyMode) => String(m);

/** Compile parameters into the compiler's backend-independent IR. */
export function toIR(p: StrategyParams, name = "CONFIGURED"): StrategyIR {
  const transition = (
    from: StrategyMode,
    trigger: { type: ConditionType; operator: Comparison; value: number },
    durationSeconds: number,
    to: StrategyMode,
    liquidityBps: number,
    spreadBps: number
  ) => ({
    conditions: [
      { type: ConditionType.MODE, operator: Comparison.EQ, value: mode(from) },
      { type: trigger.type, operator: trigger.operator, value: String(trigger.value) },
    ],
    durationSeconds,
    actions: [
      { type: ActionType.SET_MODE, value: mode(to) },
      { type: ActionType.SET_LIQUIDITY, value: String(liquidityBps) },
      { type: ActionType.SET_SPREAD, value: String(spreadBps) },
    ],
  });

  return {
    version: LIMITS.VERSION,
    name,
    base: { liquidityBps: p.normalLiquidityBps, spreadBps: p.normalSpreadBps },
    rules: [
      // A shock fires immediately: a crash should not have to wait out a timer.
      transition(
        StrategyMode.NORMAL,
        { type: ConditionType.VOLATILITY, operator: Comparison.GTE, value: p.enterDefensiveBps },
        0,
        StrategyMode.DEFENSIVE,
        p.defensiveLiquidityBps,
        p.defensiveSpreadBps
      ),
      // Calm must be *sustained* before any liquidity comes back.
      transition(
        StrategyMode.DEFENSIVE,
        { type: ConditionType.VOLATILITY, operator: Comparison.LT, value: p.leaveDefensiveBps },
        p.calmPeriodSeconds,
        StrategyMode.RECOVERY,
        p.recoveryLiquidityBps,
        p.recoverySpreadBps
      ),
      // A relapse outranks the recovery timer, so it is written before it: the engine takes the
      // first matching rule.
      transition(
        StrategyMode.RECOVERY,
        { type: ConditionType.VOLATILITY, operator: Comparison.GTE, value: p.enterDefensiveBps },
        0,
        StrategyMode.DEFENSIVE,
        p.defensiveLiquidityBps,
        p.defensiveSpreadBps
      ),
      // Recovery served its time.
      transition(
        StrategyMode.RECOVERY,
        {
          type: ConditionType.TIME_SINCE_TRANSITION,
          operator: Comparison.GTE,
          value: p.recoveryPeriodSeconds,
        },
        0,
        StrategyMode.NORMAL,
        p.normalLiquidityBps,
        p.normalSpreadBps
      ),
    ],
  };
}

/** Compile parameters straight to the bytes `registerStrategy` takes. */
export function compileParams(p: StrategyParams, name?: string): `0x${string}` {
  return emitRuleProgram(toIR(p, name));
}
