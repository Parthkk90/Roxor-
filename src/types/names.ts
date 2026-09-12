import { ActionType, Comparison, ConditionType } from "./index.js";

/** Human-readable labels for CLI output and error messages. */

export const ConditionNames: Record<ConditionType, string> = {
  [ConditionType.VOLATILITY]: "volatility",
  [ConditionType.PRICE]: "price",
  [ConditionType.PRICE_CHANGE_5M]: "priceChange(5m)",
  [ConditionType.PRICE_CHANGE_1H]: "priceChange(1h)",
  [ConditionType.TIME_SINCE_TRANSITION]: "timeSinceTransition()",
  [ConditionType.MODE]: "mode",
  [ConditionType.ORACLE_CONFIDENCE]: "oracleConfidence",
  [ConditionType.CUMULATIVE_VOLUME]: "volume",
};

export const ComparisonNames: Record<Comparison, string> = {
  [Comparison.GT]: ">",
  [Comparison.GTE]: ">=",
  [Comparison.LT]: "<",
  [Comparison.LTE]: "<=",
  [Comparison.EQ]: "==",
  [Comparison.NEQ]: "!=",
};

export const ActionNames: Record<ActionType, string> = {
  [ActionType.SET_MODE]: "SET_MODE",
  [ActionType.SET_LIQUIDITY]: "SET_LIQUIDITY",
  [ActionType.SET_SPREAD]: "SET_SPREAD",
  [ActionType.MULTIPLY_LIQUIDITY]: "MULTIPLY_LIQUIDITY",
  [ActionType.ADD_SPREAD]: "ADD_SPREAD",
};
