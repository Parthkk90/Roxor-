import { CompileError, TokenKind, type Diagnostic, type SourcePos, type Token } from "../types/index.js";

const KEYWORDS: Record<string, TokenKind> = {
  strategy: TokenKind.STRATEGY,
  base: TokenKind.BASE,
  when: TokenKind.WHEN,
  for: TokenKind.FOR,
  and: TokenKind.AND,
};

/**
 * Duration suffixes recognised directly after a number, e.g. `10m`, `1h`.
 * Longhand words (`minutes`, `hours`) are handled as identifiers by {tokenize}.
 */
const DURATION_SUFFIX: Record<string, number> = { s: 1, m: 60, h: 3600, d: 86400 };

const DURATION_WORD: Record<string, number> = {
  second: 1,
  seconds: 1,
  minute: 60,
  minutes: 60,
  hour: 3600,
  hours: 3600,
  day: 86400,
  days: 86400,
};

export function isDurationWord(word: string): number | undefined {
  return DURATION_WORD[word];
}

/**
 * Convert CLF source into a token stream.
 *
 * The lexer is deliberately unit-aware: `50%`, `20bps` and `10m` each produce a distinct token
 * kind rather than a bare number. That lets the semantic pass reject `liquidity = 20bps` as a unit
 * error instead of silently accepting a meaningless value.
 */
export function tokenize(source: string): Token[] {
  const tokens: Token[] = [];
  const errors: Diagnostic[] = [];
  const lines = source.split("\n");

  let line = 1;
  let column = 1;
  let i = 0;

  const here = (): SourcePos => ({ line, column });
  const advance = (n = 1) => {
    for (let k = 0; k < n; k++) {
      if (source[i] === "\n") {
        line++;
        column = 1;
      } else {
        column++;
      }
      i++;
    }
  };
  const push = (kind: TokenKind, text: string, pos: SourcePos, value?: number) => {
    tokens.push(value === undefined ? { kind, text, pos } : { kind, text, pos, value });
  };

  while (i < source.length) {
    const ch = source[i]!;

    if (ch === " " || ch === "\t" || ch === "\r" || ch === "\n") {
      advance();
      continue;
    }

    // Comments: `//` to end of line, and `#` for convenience.
    if ((ch === "/" && source[i + 1] === "/") || ch === "#") {
      while (i < source.length && source[i] !== "\n") advance();
      continue;
    }

    const pos = here();

    // Numbers, with an optional unit suffix.
    if (/[0-9]/.test(ch)) {
      let text = "";
      while (i < source.length && /[0-9_.]/.test(source[i]!)) {
        text += source[i];
        advance();
      }
      const numeric = Number(text.replace(/_/g, ""));
      if (!Number.isFinite(numeric)) {
        errors.push({ message: `malformed number '${text}'`, pos, sourceLine: lines[pos.line - 1] ?? "" });
        continue;
      }

      if (source[i] === "%") {
        advance();
        push(TokenKind.PERCENT, `${text}%`, pos, numeric);
        continue;
      }

      // `bps` suffix.
      if (source.slice(i, i + 3) === "bps") {
        advance(3);
        push(TokenKind.BPS, `${text}bps`, pos, numeric);
        continue;
      }

      // Single-letter duration suffix, but only when not part of a longer word.
      const suffix = source[i];
      if (suffix && DURATION_SUFFIX[suffix] !== undefined && !/[a-zA-Z0-9_]/.test(source[i + 1] ?? "")) {
        advance();
        push(TokenKind.DURATION_UNIT, `${text}${suffix}`, pos, numeric * DURATION_SUFFIX[suffix]!);
        continue;
      }

      push(TokenKind.NUMBER, text, pos, numeric);
      continue;
    }

    // Identifiers and keywords.
    if (/[a-zA-Z_]/.test(ch)) {
      let text = "";
      while (i < source.length && /[a-zA-Z0-9_]/.test(source[i]!)) {
        text += source[i];
        advance();
      }
      const keyword = KEYWORDS[text.toLowerCase()];
      if (keyword) {
        push(keyword, text, pos);
      } else {
        push(TokenKind.IDENTIFIER, text, pos);
      }
      continue;
    }

    // Operators and punctuation.
    const two = source.slice(i, i + 2);
    if (two === ">=") {
      advance(2);
      push(TokenKind.GTE, two, pos);
      continue;
    }
    if (two === "<=") {
      advance(2);
      push(TokenKind.LTE, two, pos);
      continue;
    }
    if (two === "==") {
      advance(2);
      push(TokenKind.EQ, two, pos);
      continue;
    }
    if (two === "!=") {
      advance(2);
      push(TokenKind.NEQ, two, pos);
      continue;
    }
    if (two === "*=") {
      advance(2);
      push(TokenKind.MUL_ASSIGN, two, pos);
      continue;
    }
    if (two === "+=") {
      advance(2);
      push(TokenKind.ADD_ASSIGN, two, pos);
      continue;
    }

    switch (ch) {
      case ">":
        advance();
        push(TokenKind.GT, ch, pos);
        continue;
      case "<":
        advance();
        push(TokenKind.LT, ch, pos);
        continue;
      case "=":
        advance();
        push(TokenKind.ASSIGN, ch, pos);
        continue;
      case "{":
        advance();
        push(TokenKind.LBRACE, ch, pos);
        continue;
      case "}":
        advance();
        push(TokenKind.RBRACE, ch, pos);
        continue;
      case "(":
        advance();
        push(TokenKind.LPAREN, ch, pos);
        continue;
      case ")":
        advance();
        push(TokenKind.RPAREN, ch, pos);
        continue;
      case "-":
        advance();
        push(TokenKind.MINUS, ch, pos);
        continue;
      default:
        errors.push({
          message: `unexpected character '${ch}'`,
          pos,
          sourceLine: lines[pos.line - 1] ?? "",
        });
        advance();
    }
  }

  if (errors.length > 0) throw new CompileError(errors);

  tokens.push({ kind: TokenKind.EOF, text: "", pos: here() });
  return tokens;
}
