/**
 * Surgical package.json editing for --fix (spec §7.1): rewrite ONLY the
 * changed script values inside the original text, preserving indentation,
 * line endings, field order, and every other byte. Atomic write via
 * temp file + rename.
 */
import { readFileSync, renameSync, writeFileSync } from 'node:fs';

interface ScriptValueSpan {
  /** Span of the full JSON string literal, including quotes. */
  quoteStart: number;
  quoteEnd: number;
  /** Decoded script text. */
  value: string;
}

/**
 * Locate `scripts` object member value spans in a package.json text.
 * A tiny scanner (no JSON.parse round-trip) walks the scripts object and
 * records each key/value with exact offsets.
 */
export function locateScriptSpans(text: string): Map<string, ScriptValueSpan> {
  const spans = new Map<string, ScriptValueSpan>();
  const header = /"scripts"\s*:\s*\{/g;
  header.lastIndex = 0;
  const match = header.exec(text);
  if (match === null) return spans;

  let i = match.index + match[0].length;
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
      // non-string member (or nested object) — skip to next comma at this level
      while (i < n && text.charAt(i) !== ',' && text.charAt(i) !== '}') i += 1;
      if (text.charAt(i) === ',') i += 1;
      continue;
    }
    const valueStart = i;
    const valueRaw = readString();
    if (valueRaw === null) break;
    if (key !== null) {
      spans.set(key, { quoteStart: valueStart, quoteEnd: valueStart + valueRaw.length, value: jsonDecode(valueRaw) ?? '' });
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

/** Replace changed script values in the package.json text, byte-surgically. */
export function rewriteScripts(text: string, rewrites: ScriptRewrite[]): string | null {
  if (rewrites.length === 0) return null;
  const spans = locateScriptSpans(text);
  let out = text;
  // Apply right-to-left so offsets stay valid.
  const ordered = [...rewrites].sort(
    (a, b) => (spans.get(b.scriptName)?.quoteStart ?? 0) - (spans.get(a.scriptName)?.quoteStart ?? 0),
  );
  for (const rewrite of ordered) {
    const span = spans.get(rewrite.scriptName);
    if (span === undefined || span.value === rewrite.newValue) continue;
    const encoded = JSON.stringify(rewrite.newValue);
    out = out.slice(0, span.quoteStart) + encoded + out.slice(span.quoteEnd);
  }
  return out === text ? null : out;
}

/** Atomic file write: temp file in the same directory, then rename. */
export function writeFileAtomic(file: string, content: string): void {
  const tmp = `${file}.scriptspect-tmp`;
  writeFileSync(tmp, content, 'utf8');
  renameSync(tmp, file);
}

/** Read, rewrite, and (optionally) write a package.json. Returns new text or null. */
export function applyRewritesToFile(file: string, rewrites: ScriptRewrite[], write: boolean): string | null {
  const text = readFileSync(file, 'utf8');
  const next = rewriteScripts(text, rewrites);
  if (next !== null && write) writeFileAtomic(file, next);
  return next;
}
