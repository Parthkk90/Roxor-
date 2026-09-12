import {
  ActionType,
  CompileError,
  Comparison,
  ConditionType,
  LIMITS,
  StrategyMode,
  type ActionNode,
  type ConditionNode,
  type Diagnostic,
  type IRAction,
  type IRCondition,
  type IRRule,
  type Literal,
  type StrategyAST,
  type StrategyIR,
} from "../types/index.js";

/** Units a source value may carry into a given position. */
type Expect = "ratio" | "duration" | "price" | "mode" | "raw";

interface VariableSpec {
  type: ConditionType;
  expect: Expect;
  /** Call form only: which ConditionType a given argument (in seconds) maps to. */
  byArg?: Record<number, ConditionType>;
  /** Inverts the comparison and negates the operand, for `priceDrop`. */
  invert?: boolean;
  requiresCall?: boolean;
}

const VARIABLES: Record<string, VariableSpec> = {
  volatility: { type: ConditionType.VOLATILITY, expect: "ratio" },
  price: { type: ConditionType.PRICE, expect: "price" },
  mode: { type: ConditionType.MODE, expect: "mode" },
  oracleConfidence: { type: ConditionType.ORACLE_CONFIDENCE, expect: "ratio" },
  volume: { type: ConditionType.CUMULATIVE_VOLUME, expect: "raw" },
  timeSinceTransition: {
    type: ConditionType.TIME_SINCE_TRANSITION,
    expect: "duration",
    requiresCall: true,
  },
  priceChange: {
    type: ConditionType.PRICE_CHANGE_5M,
    expect: "ratio",
    requiresCall: true,
    byArg: { 300: ConditionType.PRICE_CHANGE_5M, 3600: ConditionType.PRICE_CHANGE_1H },
  },
  // `priceDrop(5m) > 3%` reads naturally but means "priceChange5m < -3%", so it lowers to the
  // same register with the comparison flipped and the operand negated.
  priceDrop: {
    type: ConditionType.PRICE_CHANGE_5M,
    expect: "ratio",
    requiresCall: true,
    invert: true,
    byArg: { 300: ConditionType.PRICE_CHANGE_5M, 3600: ConditionType.PRICE_CHANGE_1H },
  },
};

const MODES: Record<string, StrategyMode> = {
  NORMAL: StrategyMode.NORMAL,
  DEFENSIVE: StrategyMode.DEFENSIVE,
  RECOVERY: StrategyMode.RECOVERY,
};

const FLIP: Record<Comparison, Comparison> = {
  [Comparison.GT]: Comparison.LT,
  [Comparison.GTE]: Comparison.LTE,
  [Comparison.LT]: Comparison.GT,
  [Comparison.LTE]: Comparison.GTE,
  [Comparison.EQ]: Comparison.EQ,
  [Comparison.NEQ]: Comparison.NEQ,
};

const WAD = 10n ** 18n;

/**
 * Validate the AST and lower it to the backend-independent IR.
 *
 * Every diagnostic is collected rather than thrown on first sight, so a single compile reports all
 * of a file's problems instead of making the author fix them one at a time.
 */
export function analyze(ast: StrategyAST): StrategyIR {
  const errors: Diagnostic[] = [];

  const err = (message: string, pos: { line: number; column: number }) => {
    errors.push({ message, pos });
  };

  /* base block */
  if (ast.base.liquidityBps < 0) {
    err(`base liquidity cannot be negative`, ast.base.pos);
  } else if (ast.base.liquidityBps > LIMITS.MAX_LIQUIDITY_BPS) {
    err(
      `base liquidity is ${fmtBps(ast.base.liquidityBps)} but a strategy can never quote more than 100% ` +
        `of the liquidity its maker actually committed to Aqua`,
      ast.base.pos,
    );
  }
  if (ast.base.spreadBps < 0) {
    err(`base spread cannot be negative`, ast.base.pos);
  } else if (ast.base.spreadBps > LIMITS.MAX_SPREAD_BPS) {
    err(
      `base spread is ${fmtBps(ast.base.spreadBps)} but the protocol caps spread at ${fmtBps(LIMITS.MAX_SPREAD_BPS)}`,
      ast.base.pos,
    );
  }

  /* complexity ceilings */
  if (ast.rules.length === 0) {
    err("strategy has no rules; it would never react to the market", ast.pos);
  }
  if (ast.rules.length > LIMITS.MAX_RULES) {
    err(`strategy has ${ast.rules.length} rules but the limit is ${LIMITS.MAX_RULES}`, ast.pos);
  }

  const rules: IRRule[] = [];

  for (const [index, rule] of ast.rules.entries()) {
    if (rule.conditions.length > LIMITS.MAX_CONDITIONS_PER_RULE) {
      err(
        `rule ${index + 1} has ${rule.conditions.length} conditions but the limit is ${LIMITS.MAX_CONDITIONS_PER_RULE}`,
        rule.pos,
      );
    }
    if (rule.actions.length > LIMITS.MAX_ACTIONS_PER_RULE) {
      err(
        `rule ${index + 1} has ${rule.actions.length} actions but the limit is ${LIMITS.MAX_ACTIONS_PER_RULE}`,
        rule.pos,
      );
    }
    if (rule.durationSeconds !== undefined && rule.durationSeconds > 0xffffffff) {
      err(`rule ${index + 1} duration exceeds the 32-bit seconds field`, rule.pos);
    }

    const conditions = rule.conditions.map((c) => lowerCondition(c, err));
    const actions = rule.actions.map((a) => lowerAction(a, err));

    rules.push({
      conditions,
      durationSeconds: rule.durationSeconds ?? 0,
      actions,
    });
  }

  if (errors.length > 0) throw new CompileError(errors);

  return {
    version: LIMITS.VERSION,
    name: ast.name,
    base: { liquidityBps: ast.base.liquidityBps, spreadBps: ast.base.spreadBps },
    rules,
  };
}

type Err = (message: string, pos: { line: number; column: number }) => void;

function lowerCondition(node: ConditionNode, err: Err): IRCondition {
  const spec = VARIABLES[node.subject];
  if (!spec) {
    err(
      `unknown variable '${node.subject}'; available variables are ${Object.keys(VARIABLES).sort().join(", ")}`,
      node.pos,
    );
    return { type: ConditionType.VOLATILITY, operator: node.comparison, value: "0" };
  }

  if (spec.requiresCall && node.subjectArg === undefined) {
    err(`'${node.subject}' is a function; write '${node.subject}(...)'`, node.pos);
  }
  if (!spec.requiresCall && node.subjectArg !== undefined) {
    err(`'${node.subject}' is a variable, not a function; drop the parentheses`, node.pos);
  }

  let type = spec.type;
  if (spec.byArg) {
    const arg = node.subjectArg ?? 0;
    const mapped = spec.byArg[arg];
    if (mapped === undefined) {
      const windows = Object.keys(spec.byArg)
        .map((s) => fmtDuration(Number(s)))
        .join(" or ");
      err(`'${node.subject}' only supports a window of ${windows}, but got ${fmtDuration(arg)}`, node.pos);
    } else {
      type = mapped;
    }
  }

  let operator = node.comparison;
  let value = coerceOperand(node.operand, spec.expect, node.subject, err);

  if (spec.invert) {
    operator = FLIP[operator];
    value = -value;
  }

  if (spec.expect === "mode" && operator !== Comparison.EQ && operator !== Comparison.NEQ) {
    err("'mode' can only be compared with '==' or '!='", node.pos);
  }

  return { type, operator, value: value.toString() };
}

function lowerAction(node: ActionNode, err: Err): IRAction {
  const { target, operand } = node;

  if (target === "mode") {
    if (node.multiply || node.add) err("'mode' only supports plain assignment", node.pos);
    const value = coerceOperand(operand, "mode", target, err);
    return { type: ActionType.SET_MODE, value: value.toString() };
  }

  if (target === "liquidity") {
    if (node.add) err("'liquidity' supports '=' and '*=' but not '+='", node.pos);
    const value = coerceOperand(operand, "ratio", target, err);
    if (value < 0n) err("liquidity cannot be negative", node.pos);
    if (value > BigInt(LIMITS.MAX_LIQUIDITY_BPS)) {
      err(
        node.multiply
          ? `liquidity multiplier is ${fmtBps(Number(value))} but a multiplier above 100% would quote liquidity ` +
              `the maker never committed`
          : `liquidity is ${fmtBps(Number(value))} but a strategy can never quote more than 100% of the maker's balance`,
        node.pos,
      );
    }
    return { type: node.multiply ? ActionType.MULTIPLY_LIQUIDITY : ActionType.SET_LIQUIDITY, value: value.toString() };
  }

  if (target === "spread") {
    if (node.multiply) err("'spread' supports '=' and '+=' but not '*='", node.pos);
    const value = coerceOperand(operand, "ratio", target, err);
    if (value < 0n) err("spread cannot be negative", node.pos);
    if (value > BigInt(LIMITS.MAX_SPREAD_BPS)) {
      err(`spread is ${fmtBps(Number(value))} but the protocol caps spread at ${fmtBps(LIMITS.MAX_SPREAD_BPS)}`, node.pos);
    }
    return { type: node.add ? ActionType.ADD_SPREAD : ActionType.SET_SPREAD, value: value.toString() };
  }

  err(`unknown setting '${target}'; a rule can set 'mode', 'liquidity' or 'spread'`, node.pos);
  return { type: ActionType.SET_LIQUIDITY, value: "0" };
}

/** Convert a source literal into the protocol's fixed-point representation. */
function coerceOperand(
  operand: Literal | { mode: string; pos: { line: number; column: number } },
  expect: Expect,
  what: string,
  err: Err,
): bigint {
  if ("mode" in operand) {
    if (expect !== "mode") {
      err(`'${what}' expects a ${describe(expect)}, but got the mode '${operand.mode}'`, operand.pos);
      return 0n;
    }
    const mode = MODES[operand.mode];
    if (mode === undefined) {
      err(`unknown mode '${operand.mode}'; expected one of ${Object.keys(MODES).join(", ")}`, operand.pos);
      return 0n;
    }
    return BigInt(mode);
  }

  if (expect === "mode") {
    err(`'${what}' expects a mode name such as DEFENSIVE, but got a number`, operand.pos);
    return 0n;
  }

  switch (expect) {
    case "ratio":
      // Ratios are bps everywhere on-chain, so '50%' and '5000bps' are the same value.
      if (operand.unit === "percent") return BigInt(Math.round(operand.value * 100));
      if (operand.unit === "bps") return BigInt(Math.round(operand.value));
      err(`'${what}' expects a percentage or bps value such as '50%' or '90bps'`, operand.pos);
      return 0n;

    case "duration":
      if (operand.unit === "duration") return BigInt(Math.round(operand.value));
      err(`'${what}' expects a duration such as '10 minutes' or '10m'`, operand.pos);
      return 0n;

    case "price":
      // Prices are WAD on-chain; a bare '4000' means 4000.0.
      if (operand.unit === "bare") return BigInt(Math.round(operand.value)) * WAD;
      err(`'${what}' expects a plain number such as '4000'`, operand.pos);
      return 0n;

    case "raw":
      if (operand.unit === "bare") return BigInt(Math.round(operand.value));
      err(`'${what}' expects a plain number`, operand.pos);
      return 0n;
  }
}

function describe(expect: Expect): string {
  switch (expect) {
    case "ratio":
      return "percentage or bps value";
    case "duration":
      return "duration";
    case "price":
      return "price";
    case "raw":
      return "number";
    case "mode":
      return "mode";
  }
}

function fmtBps(bps: number): string {
  return `${bps / 100}%`;
}

function fmtDuration(seconds: number): string {
  if (seconds % 3600 === 0) return `${seconds / 3600}h`;
  if (seconds % 60 === 0) return `${seconds / 60}m`;
  return `${seconds}s`;
}
