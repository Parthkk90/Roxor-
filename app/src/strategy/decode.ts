import { ActionType, Comparison, ConditionType, LIMITS, StrategyMode } from "../../../src/types/index.js";

/**
 * Decoder for the rule-program format `contracts/libraries/RuleProgram.sol` defines.
 *
 * The point of decoding rather than displaying stored parameters is that the *program* is the only
 * thing the engine actually executes. `ConditionalLiquidityRegistry` keeps the bytes
 * (`getRuleProgram`) and only a hash of them on the `Strategy` struct, so reading them back and
 * decoding them is the sole way for a UI to state a strategy's thresholds without guessing.
 *
 * Mirrors the layout in that file exactly:
 *   header       version:u8  ruleCount:u8
 *   rule header  conditionCount:u8  durationSeconds:u32  actionCount:u8
 *   condition    type:u8  comparison:u8  operand:i256      (34 bytes)
 *   action       type:u8  operand:u256                     (33 bytes)
 */

export interface DecodedCondition {
  type: ConditionType;
  comparison: Comparison;
  operand: bigint;
}

export interface DecodedAction {
  type: ActionType;
  operand: bigint;
}

export interface DecodedRule {
  conditions: DecodedCondition[];
  durationSeconds: number;
  actions: DecodedAction[];
}

export interface DecodedProgram {
  version: number;
  rules: DecodedRule[];
}

const TWO_255 = 1n << 255n;
const TWO_256 = 1n << 256n;

function word(bytes: Uint8Array, at: number): bigint {
  let v = 0n;
  for (let i = 0; i < 32; i++) v = (v << 8n) | BigInt(bytes[at + i]);
  return v;
}

/** Two's complement, so a negative `int256` operand (e.g. a price drop) reads back negative. */
function signedWord(bytes: Uint8Array, at: number): bigint {
  const v = word(bytes, at);
  return v >= TWO_255 ? v - TWO_256 : v;
}

export function decodeProgram(hex: `0x${string}`): DecodedProgram {
  const bytes = Uint8Array.from(hex.slice(2).match(/.{2}/g)?.map((b) => parseInt(b, 16)) ?? []);
  if (bytes.length < 2) throw new Error("Rule program is truncated.");

  const version = bytes[0];
  if (version !== LIMITS.VERSION) throw new Error(`Unsupported rule-program version ${version}.`);

  const rules: DecodedRule[] = [];
  let at = 2;
  for (let r = 0; r < bytes[1]; r++) {
    if (at + 6 > bytes.length) throw new Error("Rule program is truncated.");
    const conditionCount = bytes[at];
    const durationSeconds = (bytes[at + 1] << 24) | (bytes[at + 2] << 16) | (bytes[at + 3] << 8) | bytes[at + 4];
    const actionCount = bytes[at + 5];

    const conditions: DecodedCondition[] = [];
    let cursor = at + 6;
    for (let c = 0; c < conditionCount; c++, cursor += 34) {
      conditions.push({
        type: bytes[cursor] as ConditionType,
        comparison: bytes[cursor + 1] as Comparison,
        operand: signedWord(bytes, cursor + 2),
      });
    }

    const actions: DecodedAction[] = [];
    for (let a = 0; a < actionCount; a++, cursor += 33) {
      actions.push({ type: bytes[cursor] as ActionType, operand: word(bytes, cursor + 1) });
    }

    rules.push({ conditions, durationSeconds, actions });
    at = cursor;
  }
  if (at !== bytes.length) throw new Error("Rule program has trailing bytes.");
  return { version, rules };
}

/* ------------------------------------------------------------------ rendering helpers */

const CONDITION_WORD: Record<ConditionType, string> = {
  [ConditionType.VOLATILITY]: "volatility",
  [ConditionType.PRICE]: "price",
  [ConditionType.PRICE_CHANGE_5M]: "5-minute price change",
  [ConditionType.PRICE_CHANGE_1H]: "1-hour price change",
  [ConditionType.TIME_SINCE_TRANSITION]: "time in this state",
  [ConditionType.MODE]: "state",
  [ConditionType.ORACLE_CONFIDENCE]: "oracle confidence",
  [ConditionType.CUMULATIVE_VOLUME]: "cumulative volume",
};

const COMPARISON_WORD: Record<Comparison, string> = {
  [Comparison.GT]: "above",
  [Comparison.GTE]: "at or above",
  [Comparison.LT]: "below",
  [Comparison.LTE]: "at or below",
  [Comparison.EQ]: "is",
  [Comparison.NEQ]: "is not",
};

const MODE_WORD: Record<number, string> = {
  [StrategyMode.NORMAL]: "Normal",
  [StrategyMode.DEFENSIVE]: "Defensive",
  [StrategyMode.RECOVERY]: "Recovering",
};

/** Seconds as the shortest exact phrase: 600 -> "10 minutes", never "0.17 hours". */
export function humanDuration(seconds: number): string {
  if (seconds === 0) return "immediately";
  for (const [unit, size] of [["hour", 3600], ["minute", 60]] as const) {
    if (seconds % size === 0) {
      const n = seconds / size;
      return `${n} ${unit}${n === 1 ? "" : "s"}`;
    }
  }
  return `${seconds} second${seconds === 1 ? "" : "s"}`;
}

export function describeCondition(c: DecodedCondition): string {
  if (c.type === ConditionType.MODE) {
    return `state ${COMPARISON_WORD[c.comparison]} ${MODE_WORD[Number(c.operand)] ?? "unknown"}`;
  }
  if (c.type === ConditionType.TIME_SINCE_TRANSITION) {
    return `time in this state ${COMPARISON_WORD[c.comparison]} ${humanDuration(Number(c.operand))}`;
  }
  // Everything else in this format is a bps quantity; prices are WAD but are not exposed by the
  // builder, so they are shown raw rather than mislabelled as a percentage.
  if (c.type === ConditionType.PRICE) return `price ${COMPARISON_WORD[c.comparison]} ${c.operand}`;
  return `${CONDITION_WORD[c.type] ?? "condition"} ${COMPARISON_WORD[c.comparison]} ${Number(c.operand) / 100}%`;
}

export function describeAction(a: DecodedAction): string {
  switch (a.type) {
    case ActionType.SET_MODE:
      return `enter ${MODE_WORD[Number(a.operand)] ?? "unknown"}`;
    case ActionType.SET_LIQUIDITY:
      return `quote ${Number(a.operand) / 100}% of deliverable`;
    case ActionType.MULTIPLY_LIQUIDITY:
      return `scale liquidity to ${Number(a.operand) / 100}%`;
    case ActionType.SET_SPREAD:
      return `charge ${Number(a.operand) / 100}%`;
    case ActionType.ADD_SPREAD:
      return `widen by ${Number(a.operand) / 100}%`;
  }
}

/**
 * The calm gate a strategy actually requires before it will leave DEFENSIVE: the first duration-
 * gated rule whose trigger is volatility. Read from the program, so it is this strategy's
 * requirement rather than the demo strategy's.
 */
export function recoveryRequirement(program: DecodedProgram): { thresholdBps: number; seconds: number } | undefined {
  for (const rule of program.rules) {
    if (rule.durationSeconds === 0) continue;
    const trigger = rule.conditions.find((c) => c.type === ConditionType.VOLATILITY);
    if (trigger) return { thresholdBps: Number(trigger.operand), seconds: rule.durationSeconds };
  }
  return undefined;
}
