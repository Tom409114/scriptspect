/**
 * Minimal glob → RegExp matcher for config `ignore` entries (packages,
 * scripts). Supports `*` (within a segment), `**` (across separators), `?`.
 * No external dependency: deterministic, tiny, sufficient for config globs.
 */

export function globToRegExp(pattern: string): RegExp {
  let re = '';
  let i = 0;
  while (i < pattern.length) {
    const ch = pattern.charAt(i);
    if (ch === '*') {
      if (pattern.charAt(i + 1) === '*') {
        // `**` matches across separators; swallow a following slash so
        // `examples/**` also matches `examples` itself via the optional group.
        re += '.*';
        i += 2;
        if (pattern.charAt(i) === '/') i += 1;
      } else {
        re += '[^/]*';
        i += 1;
      }
      continue;
    }
    if (ch === '?') {
      re += '[^/]';
      i += 1;
      continue;
    }
    re += ch.replace(/[.+^${}()|[\]\\]/g, '\\$&');
    i += 1;
  }
  return new RegExp(`^${re}$`);
}

export function globMatch(pattern: string, value: string): boolean {
  return globToRegExp(pattern).test(value);
}
