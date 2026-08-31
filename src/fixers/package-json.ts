/**
 * Surgical package.json editing for --fix (spec §7.1): rewrite ONLY the
 * changed script values inside the original text, preserving indentation,
 * line endings, field order, and every other byte. Atomic write via
 * temp file + rename.
 */
import { createHash } from 'node:crypto';
import { readFileSync } from 'node:fs';
import { dirname } from 'node:path';
import { TextDecoder } from 'node:util';
import { resolveContainedPath } from '../core/root';
import { executeWriteTransaction } from './transaction';

interface ScriptValueSpan {
  /** Span of the full JSON string literal, including quotes. */
  quoteStart: number;
  quoteEnd: number;
  /** Decoded script text. */
  value: string;
}

export class PackageJsonEditError extends Error {
  constructor(message: string) {
    super(message);
    this.name = 'PackageJsonEditError';
  }
}

interface JsonStringToken {
  raw: string;
  value: string;
  end: number;
}

function skipWhitespace(text: string, start: number): number {
  let i = start;
  while (i < text.length && /\s/.test(text.charAt(i))) i += 1;
  return i;
}

function readJsonString(text: string, start: number): JsonStringToken | null {
  if (text.charAt(start) !== '"') return null;
  let i = start + 1;
  while (i < text.length) {
    const char = text.charAt(i);
    if (char === '\\') {
      i += 2;
      continue;
    }
    if (char === '"') {
      const raw = text.slice(start, i + 1);
      const value = jsonDecode(raw);
      return value === null ? null : { raw, value, end: i + 1 };
    }
    i += 1;
  }
  return null;
}

function skipJsonValue(text: string, start: number): number | null {
  const first = text.charAt(start);
  if (first === '"') return readJsonString(text, start)?.end ?? null;
  if (first !== '{' && first !== '[') {
    let i = start;
    while (i < text.length && !/[\s,}\]]/.test(text.charAt(i))) i += 1;
    return i > start ? i : null;
  }

  const stack = [first];
  let i = start + 1;
  while (i < text.length && stack.length > 0) {
    const char = text.charAt(i);
    if (char === '"') {
      const token = readJsonString(text, i);
      if (token === null) return null;
      i = token.end;
      continue;
    }
    if (char === '{' || char === '[') stack.push(char);
    if (char === '}' || char === ']') {
      const expected = char === '}' ? '{' : '[';
      if (stack.pop() !== expected) return null;
    }
    i += 1;
  }
  return stack.length === 0 ? i : null;
}

function rootScriptsObjectStart(text: string): number | null {
  let i = skipWhitespace(text, 0);
  if (text.charAt(i) !== '{') return null;
  i += 1;
  let scriptsStart: number | null = null;

  for (;;) {
    i = skipWhitespace(text, i);
    if (text.charAt(i) === '}') return scriptsStart;
    const key = readJsonString(text, i);
    if (key === null) return null;
    i = skipWhitespace(text, key.end);
    if (text.charAt(i) !== ':') return null;
    i = skipWhitespace(text, i + 1);
    if (key.value === 'scripts') {
      if (scriptsStart !== null) {
        throw new PackageJsonEditError('package.json has duplicate root "scripts" keys');
      }
      if (text.charAt(i) !== '{') {
        throw new PackageJsonEditError('package.json root "scripts" value must be an object');
      }
      scriptsStart = i + 1;
    }
    const end = skipJsonValue(text, i);
    if (end === null) return null;
    i = skipWhitespace(text, end);
    if (text.charAt(i) === ',') {
      i += 1;
      continue;
    }
    if (text.charAt(i) === '}') return scriptsStart;
    return null;
  }
}

/**
 * Locate `scripts` object member value spans in a package.json text.
 * A tiny scanner (no JSON.parse round-trip) walks the scripts object and
 * records each key/value with exact offsets.
 */
export function locateScriptSpans(text: string): Map<string, ScriptValueSpan> {
  const spans = new Map<string, ScriptValueSpan>();
  const start = rootScriptsObjectStart(text);
  if (start === null) return spans;

  let i = start;
  const n = text.length;

  const skipWs = (): void => {
    while (i < n && /\s/.test(text.charAt(i))) i += 1;
  };
  const readString = (): string | null => {
    if (text.charAt(i) !== '"') return null;
    let j = i + 1;
    let raw = '"';
    while (j < n) {
      const c = text.charAt(j);
      raw += c;
      if (c === '\\') {
        if (j + 1 < n) {
          raw += text.charAt(j + 1);
          j += 2;
          continue;
        }
        break;
      }
      if (c === '"') break;
      j += 1;
    }
    if (text.charAt(j) !== '"') return null;
    const decoded = jsonDecode(raw);
    i = j + 1;
    return decoded === null ? null : raw;
  };

  for (;;) {
    skipWs();
    if (i >= n || text.charAt(i) === '}') break;
    const keyStart = i;
    const keyRaw = readString();
    if (keyRaw === null) break;
    const key = jsonDecode(keyRaw);
    skipWs();
    if (text.charAt(i) !== ':') break;
    i += 1;
    skipWs();
    if (text.charAt(i) !== '"') {
      throw new PackageJsonEditError(
        `package.json script ${JSON.stringify(key ?? '<invalid>')} must be a string`,
      );
    }
    const valueStart = i;
    const valueRaw = readString();
    if (valueRaw === null) break;
    if (key !== null) {
      if (spans.has(key)) {
        throw new PackageJsonEditError(
          `package.json has duplicate script key ${JSON.stringify(key)}`,
        );
      }
      spans.set(key, {
        quoteStart: valueStart,
        quoteEnd: valueStart + valueRaw.length,
        value: jsonDecode(valueRaw) ?? '',
      });
    }
    void keyStart;
    skipWs();
    if (text.charAt(i) === ',') i += 1;
  }
  return spans;
}

/** Decode a raw JSON string literal (with quotes); null on parse failure. */
function jsonDecode(raw: string): string | null {
  try {
    return JSON.parse(raw) as string;
  } catch {
    return null;
  }
}

export interface ScriptRewrite {
  scriptName: string;
  newValue: string;
}

export interface PackageJsonRewritePlan {
  content: Buffer;
  expectedSha256: string;
}

/** Replace changed script values in the package.json text, byte-surgically. */
export function rewriteScripts(text: string, rewrites: ScriptRewrite[]): string | null {
  if (rewrites.length === 0) return null;
  try {
    JSON.parse(text.charCodeAt(0) === 0xfeff ? text.slice(1) : text);
  } catch (error) {
    throw new PackageJsonEditError(
      `package.json must be strict JSON: ${error instanceof Error ? error.message : String(error)}`,
    );
  }
  const spans = locateScriptSpans(text);
  let out = text;
  // Apply right-to-left so offsets stay valid.
  const ordered = [...rewrites].sort(
    (a, b) =>
      (spans.get(b.scriptName)?.quoteStart ?? 0) - (spans.get(a.scriptName)?.quoteStart ?? 0),
  );
  for (const rewrite of ordered) {
    const span = spans.get(rewrite.scriptName);
    if (span === undefined || span.value === rewrite.newValue) continue;
    const encoded = JSON.stringify(rewrite.newValue);
    out = out.slice(0, span.quoteStart) + encoded + out.slice(span.quoteEnd);
  }
  return out === text ? null : out;
}

/** Calculate a rewrite against exact source bytes without changing the file. */
export function planRewritesForFile(
  root: string,
  file: string,
  rewrites: ScriptRewrite[],
): PackageJsonRewritePlan | null {
  const containedFile = resolveContainedPath(root, file);
  const bytes = readFileSync(containedFile);
  const hasBom = bytes.length >= 3 && bytes[0] === 0xef && bytes[1] === 0xbb && bytes[2] === 0xbf;
  let text: string;
  try {
    const decoded = new TextDecoder('utf-8', { fatal: true }).decode(
      hasBom ? bytes.subarray(3) : bytes,
    );
    text = hasBom ? `\uFEFF${decoded}` : decoded;
  } catch {
    throw new PackageJsonEditError('package.json must be valid UTF-8');
  }
  const next = rewriteScripts(text, rewrites);
  if (next === null) return null;
  return {
    content: Buffer.from(next, 'utf8'),
    expectedSha256: createHash('sha256').update(bytes).digest('hex'),
  };
}

/** Read, rewrite, and (optionally) write a package.json. Returns new text or null. */
export function applyRewritesToFile(
  file: string,
  rewrites: ScriptRewrite[],
  write: boolean,
): string | null {
  const root = dirname(file);
  const plan = planRewritesForFile(root, file, rewrites);
  if (plan === null) return null;
  const next = plan.content.toString('utf8');
  if (write) executeWriteTransaction(root, [{ path: file, ...plan }]);
  return next;
}
