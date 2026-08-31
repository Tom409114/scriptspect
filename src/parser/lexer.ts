/**
 * Quote/escape/operator-aware lexical scanner for npm script strings.
 *
 * The lexer is deliberately shell-agnostic: npm scripts run under POSIX `sh`
 * on macOS/Linux and `cmd.exe` on Windows, so segmentation must be valid for
 * both dialects at once. It recognizes:
 *
 * - single and double quotes (with backslash escapes inside double quotes)
 * - POSIX backslash escapes and cmd `^` escapes (for shell-special characters)
 * - POSIX expansions: `$VAR`, `${VAR}`, `$(cmd)` (nesting- and quote-aware)
 * - cmd expansions: `%VAR%` (only outside quotes, only with a closing `%`)
 * - operators: `&&`, `||`, `|`, `;`, `&`, newlines, redirections (`>`, `>>`,
 *   `2>`, `2>&1`, `&>`, `<`, ...)
 *
 * Everything else becomes a word token. Tokens never split inside quotes and
 * never merge across unquoted operators — the two guarantees the rule engine
 * relies on to avoid string-content false positives.
 */

export type TokenKind = 'word' | 'operator' | 'lparen' | 'rparen';

/** Quote style a token (or a segment of it) was written in. */
export type QuoteKind = "'" | '"' | null;

export type ExpansionKind =
  /** `$NAME` */
  | 'var'
  /** `${NAME}` or `${NAME:-default}` */
  | 'braced'
  /** `$(command)` command substitution */
  | 'command'
  /** `%NAME%` cmd-style variable */
  | 'cmdvar'
  /** `$?`, `$$`, `$0`…`$9`, `$@`, `$*`, `$!` */
  | 'special';

export interface Expansion {
  kind: ExpansionKind;
  /** As written, including `$`/`%` sigils and delimiters. */
  raw: string;
  /** Span relative to the script string. */
  span: [number, number];
}

export interface Token {
  kind: TokenKind;
  /** Exact source slice (quotes included for quoted tokens). */
  raw: string;
  /** Semantic value (quotes stripped, escapes resolved). */
  value: string;
  span: [number, number];
  /** First quote style seen inside this token, if any. */
  quote: QuoteKind;
  /** Operator text (`&&`, `|`, `2>`, …) for operator tokens. */
  op?: string;
  /** Expansions found in this token (quoted or not). */
  expansions: Expansion[];
}

/** Operators that act as redirections rather than control flow. */
export const REDIRECT_OPS = new Set([
  '>',
  '>>',
  '<',
  '2>',
  '2>>',
  '1>',
  '1>>',
  '&>',
  '>&',
  '2>&1',
  '1>&2',
]);

/** Operators that split a script into separate commands. */
export const SEQ_OPS = new Set([';', '&', '\n']);

const NAME_RE = /^[A-Za-z_][A-Za-z0-9_]*$/;
const CMDVAR_RE = /^%[A-Za-z_][A-Za-z0-9_]*%/;
/** Characters for which cmd treats a preceding `^` as an escape. */
const CMD_CARET_SPECIALS = new Set(['&', '|', '<', '>', '(', ')', '^', '%', ' ', '\t']);

function isWordBreak(ch: string): boolean {
  return ch === ' ' || ch === '\t' || ch === '\r' || ch === '\n';
}

/** Longest-match operator table at position `i`. */
function matchOperator(src: string, i: number): string | null {
  const four = src.slice(i, i + 4);
  if (four === '2>&1' || four === '1>&2') return four;
  const two = src.slice(i, i + 2);
  if (two === '&&' || two === '||' || two === '>>' || two === '&>' || two === '>&') return two;
  const one = src.charAt(i);
  if (one === '|' || one === ';' || one === '&' || one === '>' || one === '<') return one;
  return null;
}

/**
 * Tokenize a script string. Errors are impossible by design: unterminated
 * quotes consume to end-of-input, and every byte maps to some token.
 */
export function tokenize(src: string): Token[] {
  const tokens: Token[] = [];
  const n = src.length;
  let i = 0;

  while (i < n) {
    const ch = src.charAt(i);

    // Newline is a sequence operator, not mere whitespace — check it before
    // the whitespace skip so it always becomes a token (spec §5.1).
    if (ch === '\n') {
      tokens.push({
        kind: 'operator',
        raw: '\n',
        value: '\n',
        span: [i, i + 1],
        quote: null,
        op: '\n',
        expansions: [],
      });
      i += 1;
      continue;
    }
    if (isWordBreak(ch)) {
      i += 1;
      continue;
    }
    if (ch === '(') {
      tokens.push({
        kind: 'lparen',
        raw: '(',
        value: '(',
        span: [i, i + 1],
        quote: null,
        expansions: [],
      });
      i += 1;
      continue;
    }
    if (ch === ')') {
      tokens.push({
        kind: 'rparen',
        raw: ')',
        value: ')',
        span: [i, i + 1],
        quote: null,
        expansions: [],
      });
      i += 1;
      continue;
    }

    // Operator (possibly with a pending fd digit peeled off a word, e.g. `2>`).
    const op = matchOperator(src, i);
    if (op !== null) {
      tokens.push({
        kind: 'operator',
        raw: src.slice(i, i + op.length),
        value: op,
        span: [i, i + op.length],
        quote: null,
        op,
        expansions: [],
      });
      i += op.length;
      continue;
    }

    // Word: a run of characters that may contain quoted segments,
    // escapes and expansions back to back (`a"b c"d` is one token).
    const start = i;
    let value = '';
    let quote: QuoteKind = null;
    const expansions: Expansion[] = [];
    let pendingFd = '';

    while (i < n) {
      const c = src.charAt(i);
      if (isWordBreak(c)) break;
      if (c === '(' || c === ')') break;

      // `2>` style redirections: a lone trailing fd digit joins the operator.
      if (c === '>' && /^[0-9]$/.test(value) && i === start + 1) {
        pendingFd = value;
        value = '';
        break;
      }

      const opHere = matchOperator(src, i);
      if (opHere !== null) break;

      if (c === "'") {
        const close = src.indexOf("'", i + 1);
        const end = close === -1 ? n : close;
        value += src.slice(i + 1, end);
        quote ??= "'";
        i = close === -1 ? n : close + 1;
        continue;
      }
      if (c === '"') {
        const seg = scanDoubleQuoted(src, i, expansions);
        value += seg.value;
        quote ??= '"';
        i = seg.end;
        continue;
      }
      if (c === '\\') {
        const nx = src.charAt(i + 1);
        if (nx === '') {
          value += c;
          i += 1;
        } else {
          value += nx;
          i += 2;
        }
        continue;
      }
      if (c === '^' && CMD_CARET_SPECIALS.has(src.charAt(i + 1))) {
        value += src.charAt(i + 1);
        i += 2;
        continue;
      }
      if (c === '$') {
        const exp = scanDollar(src, i);
        if (exp !== null) {
          expansions.push(exp);
          value += exp.raw;
          i = exp.span[1];
          continue;
        }
        value += c;
        i += 1;
        continue;
      }
      if (c === '%') {
        const m = CMDVAR_RE.exec(src.slice(i));
        if (m !== null) {
          const exp: Expansion = { kind: 'cmdvar', raw: m[0], span: [i, i + m[0].length] };
          expansions.push(exp);
          value += m[0];
          i += m[0].length;
          continue;
        }
        value += c;
        i += 1;
        continue;
      }
      value += c;
      i += 1;
    }

    if (value !== '' || quote !== null) {
      tokens.push({
        kind: 'word',
        raw: src.slice(start, i),
        value,
        span: [start, i],
        quote,
        expansions,
      });
    }
    if (pendingFd !== '') {
      // The fd digit sits at `start`; the full operator may be N>, N>>, N>&M.
      let opText: string;
      const four = src.slice(start, start + 4);
      if (four === '2>&1' || four === '1>&2') {
        opText = four;
      } else {
        const two = src.slice(start, start + 2); // `N>`
        opText = src.charAt(start + 2) === '>' ? `${two}>` : two; // `N>>`
      }
      tokens.push({
        kind: 'operator',
        raw: src.slice(start, start + opText.length),
        value: opText,
        span: [start, start + opText.length],
        quote: null,
        op: opText,
        expansions: [],
      });
      i = start + opText.length;
    }
  }

  return tokens;
}

/** Scan a double-quoted segment starting at the opening quote; returns value + end index. */
function scanDoubleQuoted(
  src: string,
  open: number,
  expansions: Expansion[],
): { value: string; end: number } {
  let i = open + 1;
  let value = '';
  const n = src.length;
  while (i < n) {
    const c = src.charAt(i);
    if (c === '"') return { value, end: i + 1 };
    if (c === '\\') {
      const nx = src.charAt(i + 1);
      // Inside double quotes a backslash only escapes these (POSIX sh);
      // elsewhere both characters are kept (matches cmd.exe for paths).
      if (nx === '"' || nx === '\\' || nx === '$' || nx === '`' || nx === '\n') {
        value += nx === '\n' ? '' : nx;
        i += 2;
        continue;
      }
      value += c;
      i += 1;
      continue;
    }
    if (c === '$') {
      const exp = scanDollar(src, i);
      if (exp !== null) {
        expansions.push(exp);
        value += exp.raw;
        i = exp.span[1];
        continue;
      }
    }
    if (c === '%' && i > open) {
      // cmd %VAR% works inside double quotes too
      const m = CMDVAR_RE.exec(src.slice(i));
      if (m !== null) {
        const exp: Expansion = { kind: 'cmdvar', raw: m[0], span: [i, i + m[0].length] };
        expansions.push(exp);
        value += m[0];
        i += m[0].length;
        continue;
      }
    }
    value += c;
    i += 1;
  }
  return { value, end: n }; // unterminated: consume the rest
}

/** Scan a `$` expansion at `i`; returns null when the `$` is literal. */
function scanDollar(src: string, i: number): Expansion | null {
  const n = src.length;
  const next = src.charAt(i + 1);
  if (next === '(') {
    // Command substitution: find the matching `)` honoring nesting and quotes.
    let depth = 0;
    let j = i + 1;
    while (j < n) {
      const c = src.charAt(j);
      if (c === "'") {
        const close = src.indexOf("'", j + 1);
        j = close === -1 ? n : close + 1;
        continue;
      }
      if (c === '"') {
        let k = j + 1;
        while (k < n && src.charAt(k) !== '"') k += 1;
        j = k + 1;
        continue;
      }
      if (c === '(') depth += 1;
      if (c === ')') {
        depth -= 1;
        if (depth === 0) {
          const raw = src.slice(i, j + 1);
          return { kind: 'command', raw, span: [i, j + 1] };
        }
      }
      j += 1;
    }
    const raw = src.slice(i);
    return { kind: 'command', raw, span: [i, n] };
  }
  if (next === '{') {
    let depth = 0;
    let j = i + 1;
    while (j < n) {
      const c = src.charAt(j);
      if (c === '{') depth += 1;
      if (c === '}') {
        depth -= 1;
        if (depth === 0) {
          const raw = src.slice(i, j + 1);
          return { kind: 'braced', raw, span: [i, j + 1] };
        }
      }
      j += 1;
    }
    const raw = src.slice(i);
    return { kind: 'braced', raw, span: [i, n] };
  }
  let j = i + 1;
  while (j < n && /[A-Za-z0-9_]/.test(src.charAt(j))) j += 1;
  if (j > i + 1) {
    const raw = src.slice(i, j);
    return { kind: 'var', raw, span: [i, j] };
  }
  if (next !== '' && '?#@*!$0123456789'.includes(next)) {
    return { kind: 'special', raw: src.slice(i, i + 2), span: [i, i + 2] };
  }
  return null;
}

/** True when a raw string is a valid POSIX env-assignment word (`NAME=value`). */
export function isEnvAssignmentWord(word: string): boolean {
  const eq = word.indexOf('=');
  if (eq <= 0) return false;
  return NAME_RE.test(word.slice(0, eq));
}
