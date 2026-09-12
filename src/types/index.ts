/**
 * Shared types for the Conditional Liquidity Function (CLF) compiler.
 *
 * The numeric values of every enum below are part of the on-chain ABI: they are emitted directly
 * into the rule-program bytecode that `contracts/libraries/RuleProgram.sol` decodes. They must stay
 * in lockstep with the Solidity enums of the same name. Never reorder them.
 */

/** Mirrors `IStrategyTypes.StrategyMode`. */
export enum StrategyMode {
  NORMAL = 0,
  DEFENSIVE = 1,
  RECOVERY = 2,
}

/** Mirrors `RuleProgram.ConditionType`. */
export enum ConditionType {
  VOLATILITY = 0,
  PRICE = 1,
  PRICE_CHANGE_5M = 2,
  PRICE_CHANGE_1H = 3,
  TIME_SINCE_TRANSITION = 4,
  MODE = 5,
  ORACLE_CONFIDENCE = 6,
  CUMULATIVE_VOLUME = 7,
}

/** Mirrors `RuleProgram.Comparison`. */
export enum Comparison {
  GT = 0,
  GTE = 1,
  LT = 2,
  LTE = 3,
  EQ = 4,
  NEQ = 5,
}

/** Mirrors `RuleProgram.ActionType`. */
export enum ActionType {
  SET_MODE = 0,
  SET_LIQUIDITY = 1,
  SET_SPREAD = 2,
  MULTIPLY_LIQUIDITY = 3,
  ADD_SPREAD = 4,
}

/** Mirrors the ceilings in `RuleProgram` and `StrategyLib`. */
export const LIMITS = {
  VERSION: 1,
  MAX_RULES: 16,
  MAX_CONDITIONS_PER_RULE: 4,
  MAX_ACTIONS_PER_RULE: 4,
  MAX_LIQUIDITY_BPS: 10_000,
  MAX_SPREAD_BPS: 5_000,
  BPS: 10_000,
} as const;

/* -------------------------------------------------------------------------- tokens */

export enum TokenKind {
  STRATEGY = "STRATEGY",
  BASE = "BASE",
  WHEN = "WHEN",
  FOR = "FOR",
  AND = "AND",
  IDENTIFIER = "IDENTIFIER",
  NUMBER = "NUMBER",
  PERCENT = "PERCENT",
  BPS = "BPS",
  DURATION_UNIT = "DURATION_UNIT",
  GT = "GT",
  GTE = "GTE",
  LT = "LT",
  LTE = "LTE",
  EQ = "EQ",
  NEQ = "NEQ",
  ASSIGN = "ASSIGN",
  MUL_ASSIGN = "MUL_ASSIGN",
  ADD_ASSIGN = "ADD_ASSIGN",
  LBRACE = "LBRACE",
  RBRACE = "RBRACE",
  LPAREN = "LPAREN",
  RPAREN = "RPAREN",
  MINUS = "MINUS",
  EOF = "EOF",
}

export interface SourcePos {
  line: number;
  column: number;
}

export interface Token {
  kind: TokenKind;
  /** Raw source text of the token. */
  text: string;
  /** Numeric payload for NUMBER tokens. */
  value?: number;
  pos: SourcePos;
}

/* -------------------------------------------------------------------------- AST */

/** A literal with its unit, kept separate from its value so the checker can reject unit errors. */
export type Unit = "percent" | "bps" | "duration" | "bare";

export interface Literal {
  value: number;
  unit: Unit;
  pos: SourcePos;
}

export interface ConditionNode {
  /** Source-level variable or call, e.g. `volatility` or `priceDrop(5m)`. */
  subject: string;
  /** Argument of a call form, in seconds. Present only for `priceDrop`/`priceChange`. */
  subjectArg?: number;
  comparison: Comparison;
  operand: Literal | { mode: string; pos: SourcePos };
  pos: SourcePos;
}

export interface ActionNode {
  target: string;
  operand: Literal | { mode: string; pos: SourcePos };
  /** True for `liquidity *= x`, which compiles to MULTIPLY_LIQUIDITY. */
  multiply?: boolean;
  /** True for `spread += x`, which compiles to ADD_SPREAD. */
  add?: boolean;
  pos: SourcePos;
}

export interface RuleNode {
  conditions: ConditionNode[];
  /** Sustained-condition window in seconds; absent means fire immediately. */
  durationSeconds?: number;
  actions: ActionNode[];
  pos: SourcePos;
}

export interface BaseConfigNode {
  liquidityBps: number;
  spreadBps: number;
  pos: SourcePos;
}

export interface StrategyAST {
  name: string;
  base: BaseConfigNode;
  rules: RuleNode[];
  pos: SourcePos;
}

/* -------------------------------------------------------------------------- IR */

export interface IRCondition {
  type: ConditionType;
  operator: Comparison;
  /** Already converted to the protocol's fixed-point convention. */
  value: string;
}

export interface IRAction {
  type: ActionType;
  value: string;
}

export interface IRRule {
  conditions: IRCondition[];
  durationSeconds: number;
  actions: IRAction[];
}

/**
 * Backend-independent intermediate representation.
 *
 * This is the compiler's real output: the SwapVM bytecode and any future Uniswap v4 representation
 * are both derived from it. Keeping the IR free of backend concepts is what makes a second backend
 * cheap to add.
 */
export interface StrategyIR {
  version: number;
  name: string;
  base: {
    liquidityBps: number;
    spreadBps: number;
  };
  rules: IRRule[];
}

/* -------------------------------------------------------------------------- diagnostics */

export interface Diagnostic {
  message: string;
  pos: SourcePos;
  /** Source line, for rendering a caret. */
  sourceLine?: string;
}

export class CompileError extends Error {
  readonly diagnostics: Diagnostic[];

  constructor(diagnostics: Diagnostic[]) {
    super(diagnostics.map((d) => `${d.pos.line}:${d.pos.column} ${d.message}`).join("\n"));
    this.name = "CompileError";
    this.diagnostics = diagnostics;
  }
}

export interface CompilationResult {
  success: boolean;
  strategyName: string;
  /** keccak256 of the emitted rule-program bytecode. */
  programHash: `0x${string}`;
  ast: StrategyAST;
  ir: StrategyIR;
  /** Hex-encoded rule program consumed by `RuleProgram.sol`. */
  bytecode: `0x${string}`;
  errors: Diagnostic[];
  warnings: Diagnostic[];
}
