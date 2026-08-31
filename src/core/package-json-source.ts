/** Source-level checks that JSON.parse cannot perform because duplicate keys are discarded. */

export class ManifestSourceError extends Error {
  constructor(message: string) {
    super(message);
    this.name = 'ManifestSourceError';
  }
}

interface JsonStringToken {
  value: string;
  end: number;
}

function whitespace(text: string, start: number): number {
  let index = start;
  while (index < text.length && /\s/.test(text.charAt(index))) index += 1;
  return index;
}

function jsonString(text: string, start: number): JsonStringToken | null {
  if (text.charAt(start) !== '"') return null;
  let index = start + 1;
  while (index < text.length) {
    const char = text.charAt(index);
    if (char === '\\') {
      index += 2;
      continue;
    }
    if (char === '"') {
      const raw = text.slice(start, index + 1);
      return { value: JSON.parse(raw) as string, end: index + 1 };
    }
    index += 1;
  }
  return null;
}

function jsonValueEnd(text: string, start: number): number | null {
  const first = text.charAt(start);
  if (first === '"') return jsonString(text, start)?.end ?? null;
  if (first !== '{' && first !== '[') {
    let index = start;
    while (index < text.length && !/[\s,}\]]/.test(text.charAt(index))) index += 1;
    return index > start ? index : null;
  }

  const stack = [first];
  let index = start + 1;
  while (index < text.length && stack.length > 0) {
    const char = text.charAt(index);
    if (char === '"') {
      const token = jsonString(text, index);
      if (token === null) return null;
      index = token.end;
      continue;
    }
    if (char === '{' || char === '[') stack.push(char);
    if (char === '}' || char === ']') {
      const expected = char === '}' ? '{' : '[';
      if (stack.pop() !== expected) return null;
    }
    index += 1;
  }
  return stack.length === 0 ? index : null;
}

function rootScriptsStart(text: string): number | null {
  let index = whitespace(text, 0);
  if (text.charAt(index) !== '{') return null;
  index += 1;
  let seenScripts = false;
  let scriptsStart: number | null = null;

  for (;;) {
    index = whitespace(text, index);
    if (text.charAt(index) === '}') return scriptsStart;
    const key = jsonString(text, index);
    if (key === null) return null;
    index = whitespace(text, key.end);
    if (text.charAt(index) !== ':') return null;
    index = whitespace(text, index + 1);
    if (key.value === 'scripts') {
      if (seenScripts)
        throw new ManifestSourceError('package.json has duplicate root "scripts" keys');
      seenScripts = true;
      if (text.charAt(index) === '{') scriptsStart = index + 1;
    }
    const end = jsonValueEnd(text, index);
    if (end === null) return null;
    index = whitespace(text, end);
    if (text.charAt(index) === ',') {
      index += 1;
      continue;
    }
    if (text.charAt(index) === '}') return scriptsStart;
    return null;
  }
}

/** Reject duplicate root `scripts` objects and duplicate keys inside that object. */
export function assertUnambiguousRootScripts(text: string): void {
  const start = rootScriptsStart(text);
  if (start === null) return;
  const keys = new Set<string>();
  let index = start;
  for (;;) {
    index = whitespace(text, index);
    if (text.charAt(index) === '}') return;
    const key = jsonString(text, index);
    if (key === null) return;
    if (keys.has(key.value)) {
      throw new ManifestSourceError(
        `package.json has duplicate script key ${JSON.stringify(key.value)}`,
      );
    }
    keys.add(key.value);
    index = whitespace(text, key.end);
    if (text.charAt(index) !== ':') return;
    index = whitespace(text, index + 1);
    const end = jsonValueEnd(text, index);
    if (end === null) return;
    index = whitespace(text, end);
    if (text.charAt(index) === ',') {
      index += 1;
      continue;
    }
    if (text.charAt(index) === '}') return;
    return;
  }
}
