/**
 * Minimal unified-style diff for fix dry-runs (spec §7.1): before/after
 * script lines with LCS matching, printed as a unified diff hunk.
 */

function splitLines(text: string): string[] {
  return text.split(/\r?\n/);
}

/** Longest-common-subsequence table for line arrays. */
function lcsTable(a: readonly string[], b: readonly string[]): number[][] {
  const table: number[][] = Array.from({ length: a.length + 1 }, () =>
    new Array<number>(b.length + 1).fill(0),
  );
  for (let i = a.length - 1; i >= 0; i -= 1) {
    for (let j = b.length - 1; j >= 0; j -= 1) {
      table[i]![j] =
        a[i]! === b[j]!
          ? (table[i + 1]?.[j + 1] ?? 0) + 1
          : Math.max(table[i + 1]?.[j] ?? 0, table[i]?.[j + 1] ?? 0);
    }
  }
  return table;
}

export type DiffOp = { kind: ' ' | '-' | '+'; line: string };

/** Line diff operations between two texts (LCS-based). */
export function diffLines(before: string, after: string): DiffOp[] {
  const a = splitLines(before);
  const b = splitLines(after);
  const table = lcsTable(a, b);
  const ops: DiffOp[] = [];
  let i = 0;
  let j = 0;
  while (i < a.length && j < b.length) {
    if (a[i] === b[j]) {
      ops.push({ kind: ' ', line: a[i] as string });
      i += 1;
      j += 1;
    } else if ((table[i + 1]?.[j] ?? 0) >= (table[i]?.[j + 1] ?? 0)) {
      ops.push({ kind: '-', line: a[i] as string });
      i += 1;
    } else {
      ops.push({ kind: '+', line: b[j] as string });
      j += 1;
    }
  }
  while (i < a.length) {
    ops.push({ kind: '-', line: a[i] as string });
    i += 1;
  }
  while (j < b.length) {
    ops.push({ kind: '+', line: b[j] as string });
    j += 1;
  }
  return ops;
}

/** Render a unified-style patch for one script change. */
export function renderPatch(
  path: string,
  scriptName: string,
  before: string,
  after: string,
): string {
  const ops = diffLines(before, after);
  const lines = [`--- a/${path} (scripts.${scriptName})`, `+++ b/${path} (scripts.${scriptName})`];
  for (const op of ops) {
    lines.push(`${op.kind}${op.line}`);
  }
  return lines.join('\n');
}
