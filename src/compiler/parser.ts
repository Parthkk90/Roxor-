import { isDurationWord, tokenize } from "./lexer.js";
import {
  CompileError,
  Comparison,
  TokenKind,
  type ActionNode,
  type BaseConfigNode,
  type ConditionNode,
  type Diagnostic,
  type Literal,
  type RuleNode,
  type StrategyAST,
  type Token,
} from "../types/index.js";

const COMPARISON_TOKENS: Partial<Record<TokenKind, Comparison>> = {
  [TokenKind.GT]: Comparison.GT,
  [TokenKind.GTE]: Comparison.GTE,
  [TokenKind.LT]: Comparison.LT,
  [TokenKind.LTE]: Comparison.LTE,
  [TokenKind.EQ]: Comparison.EQ,
  [TokenKind.NEQ]: Comparison.NEQ,
};

/** Identifiers that name a mode rather than a numeric value. */
const MODE_NAMES = new Set(["NORMAL", "DEFENSIVE", "RECOVERY"]);

/**
 * Recursive-descent parser for the CLF grammar:
 *
 *   strategy   := 'strategy' IDENT '{' base? rule* '}'
 *   base       := 'base' '{' assignment* '}'
 *   rule       := 'when' condition ('and' condition)* duration? '{' assignment* '}'
 *   duration   := 'for' NUMBER unit
 *   condition  := subject comparison operand
 *   subject    := IDENT | IDENT '(' NUMBER unit ')'
 *   assignment := IDENT ('=' | '*=' | '+=') operand
 *
 * The parser only enforces shape. Whether `banana` is a real variable, or whether `liquidity` may
 * be 500%, is the semantic pass's job, so errors stay specific.
 */
class Parser {
  private readonly tokens: Token[];
  private readonly lines: string[];
  private readonly errors: Diagnostic[] = [];
  private index = 0;

  constructor(source: string) {
    this.tokens = tokenize(source);
    this.lines = source.split("\n");
  }

  private peek(offset = 0): Token {
    return this.tokens[Math.min(this.index + offset, this.tokens.length - 1)]!;
  }

  private next(): Token {
    const token = this.peek();
    if (this.index < this.tokens.length - 1) this.index++;
    return token;
  }

  private fail(message: string, token: Token = this.peek()): never {
    this.errors.push({ message, pos: token.pos, sourceLine: this.lines[token.pos.line - 1] ?? "" });
    throw new CompileError(this.errors);
  }

  private expect(kind: TokenKind, what: string): Token {
    const token = this.peek();
    if (token.kind !== kind) {
      this.fail(`expected ${what} but found '${token.text || "end of input"}'`, token);
    }
    return this.next();
  }

  parse(): StrategyAST {
    const start = this.expect(TokenKind.STRATEGY, "'strategy'");
    const name = this.expect(TokenKind.IDENTIFIER, "a strategy name");
    this.expect(TokenKind.LBRACE, "'{'");

    let base: BaseConfigNode | undefined;
    const rules: RuleNode[] = [];

    while (this.peek().kind !== TokenKind.RBRACE && this.peek().kind !== TokenKind.EOF) {
      if (this.peek().kind === TokenKind.BASE) {
        if (base) this.fail("duplicate 'base' block; a strategy may declare it only once");
        base = this.parseBase();
      } else if (this.peek().kind === TokenKind.WHEN) {
        rules.push(this.parseRule());
      } else {
        this.fail(`expected 'base' or 'when' but found '${this.peek().text}'`);
      }
    }
    this.expect(TokenKind.RBRACE, "'}'");

    if (!base) {
      this.fail("strategy must declare a 'base' block giving its starting liquidity and spread", start);
    }

    return { name: name.text, base, rules, pos: start.pos };
  }

  private parseBase(): BaseConfigNode {
    const start = this.expect(TokenKind.BASE, "'base'");
    this.expect(TokenKind.LBRACE, "'{'");

    let liquidityBps: number | undefined;
    let spreadBps: number | undefined;

    while (this.peek().kind !== TokenKind.RBRACE && this.peek().kind !== TokenKind.EOF) {
      const action = this.parseAssignment();
      if (action.multiply || action.add) {
        this.fail("'base' assignments must be plain '='; compound assignment only makes sense inside a rule");
      }
      const operand = action.operand;
      if ("mode" in operand) this.fail("'base' cannot set a mode; strategies always start in NORMAL");

      if (action.target === "liquidity") {
        liquidityBps = toBps(operand);
      } else if (action.target === "spread") {
        spreadBps = toBps(operand);
      } else {
        this.fail(`unknown base setting '${action.target}'; expected 'liquidity' or 'spread'`);
      }
    }
    this.expect(TokenKind.RBRACE, "'}'");

    if (liquidityBps === undefined) this.fail("'base' must set 'liquidity'", start);
    if (spreadBps === undefined) this.fail("'base' must set 'spread'", start);

    return { liquidityBps, spreadBps, pos: start.pos };
  }

  private parseRule(): RuleNode {
    const start = this.expect(TokenKind.WHEN, "'when'");

    const conditions: ConditionNode[] = [this.parseCondition()];
    while (this.peek().kind === TokenKind.AND) {
      this.next();
      conditions.push(this.parseCondition());
    }

    let durationSeconds: number | undefined;
    if (this.peek().kind === TokenKind.FOR) {
      this.next();
      durationSeconds = this.parseDuration();
    }

    this.expect(TokenKind.LBRACE, "'{'");
    const actions: ActionNode[] = [];
    while (this.peek().kind !== TokenKind.RBRACE && this.peek().kind !== TokenKind.EOF) {
      actions.push(this.parseAssignment());
    }
    this.expect(TokenKind.RBRACE, "'}'");

    if (actions.length === 0) this.fail("rule body is empty; a rule must perform at least one action", start);

    return durationSeconds === undefined
      ? { conditions, actions, pos: start.pos }
      : { conditions, durationSeconds, actions, pos: start.pos };
  }

  private parseCondition(): ConditionNode {
    const subject = this.expect(TokenKind.IDENTIFIER, "a variable name");

    // Optional call form, e.g. `priceChange(1h)` or `timeSinceTransition()`.
    let subjectArg: number | undefined;
    let isCall = false;
    if (this.peek().kind === TokenKind.LPAREN) {
      isCall = true;
      this.next();
      if (this.peek().kind !== TokenKind.RPAREN) {
        subjectArg = this.parseDuration();
      }
      this.expect(TokenKind.RPAREN, "')'");
    }

    const opToken = this.peek();
    const comparison = COMPARISON_TOKENS[opToken.kind];
    if (comparison === undefined) {
      this.fail(`expected a comparison operator (>, >=, <, <=, ==, !=) but found '${opToken.text}'`, opToken);
    }
    this.next();

    const operand = this.parseOperand();

    const node: ConditionNode = { subject: subject.text, comparison, operand, pos: subject.pos };
    if (isCall && subjectArg !== undefined) node.subjectArg = subjectArg;
    if (isCall && subjectArg === undefined) node.subjectArg = 0;
    return node;
  }

  private parseAssignment(): ActionNode {
    const target = this.expect(TokenKind.IDENTIFIER, "a setting name");

    let multiply = false;
    let add = false;
    const t = this.peek();
    if (t.kind === TokenKind.ASSIGN) {
      this.next();
    } else if (t.kind === TokenKind.MUL_ASSIGN) {
      this.next();
      multiply = true;
    } else if (t.kind === TokenKind.ADD_ASSIGN) {
      this.next();
      add = true;
    } else {
      this.fail(`expected '=', '*=' or '+=' after '${target.text}' but found '${t.text}'`, t);
    }

    const operand = this.parseOperand();

    const node: ActionNode = { target: target.text, operand, pos: target.pos };
    if (multiply) node.multiply = true;
    if (add) node.add = true;
    return node;
  }

  private parseOperand(): Literal | { mode: string; pos: { line: number; column: number } } {
    if (this.peek().kind === TokenKind.MINUS) {
      const minus = this.next();
      const operand = this.parseOperand();
      if ("mode" in operand) this.fail("'-' cannot be applied to a mode", minus);
      if (operand.unit === "duration") this.fail("a duration cannot be negative", minus);
      return { value: -operand.value, unit: operand.unit, pos: minus.pos };
    }

    const token = this.peek();

    if (token.kind === TokenKind.IDENTIFIER) {
      this.next();
      if (!MODE_NAMES.has(token.text.toUpperCase())) {
        this.fail(
          `unknown value '${token.text}'; expected a number with a unit (50%, 20bps, 10m) or a mode ` +
            `(${[...MODE_NAMES].join(", ")})`,
          token,
        );
      }
      return { mode: token.text.toUpperCase(), pos: token.pos };
    }

    switch (token.kind) {
      case TokenKind.PERCENT:
        this.next();
        return { value: token.value!, unit: "percent", pos: token.pos };
      case TokenKind.BPS:
        this.next();
        return { value: token.value!, unit: "bps", pos: token.pos };
      case TokenKind.DURATION_UNIT:
        this.next();
        return { value: token.value!, unit: "duration", pos: token.pos };
      case TokenKind.NUMBER: {
        // A bare number may still be a longhand duration: `10 minutes`.
        const after = this.peek(1);
        if (after.kind === TokenKind.IDENTIFIER) {
          const scale = isDurationWord(after.text.toLowerCase());
          if (scale !== undefined) {
            this.next();
            this.next();
            return { value: token.value! * scale, unit: "duration", pos: token.pos };
          }
        }
        this.next();
        return { value: token.value!, unit: "bare", pos: token.pos };
      }
      default:
        this.fail(`expected a value but found '${token.text || "end of input"}'`, token);
    }
  }

  private parseDuration(): number {
    const operand = this.parseOperand();
    if ("mode" in operand) this.fail("expected a duration such as '10 minutes' or '10m'");
    if (operand.unit !== "duration") {
      this.fail(
        `expected a duration such as '10 minutes' or '10m', but got a ${operand.unit === "bare" ? "plain number" : operand.unit + " value"}`,
      );
    }
    return operand.value;
  }
}

function toBps(operand: Literal): number {
  if (operand.unit === "percent") return Math.round(operand.value * 100);
  if (operand.unit === "bps") return Math.round(operand.value);
  throw new CompileError([
    {
      message: `expected a percentage or bps value, e.g. '25%' or '90bps'`,
      pos: operand.pos,
    },
  ]);
}

export function parse(source: string): StrategyAST {
  return new Parser(source).parse();
}

export { toBps };
