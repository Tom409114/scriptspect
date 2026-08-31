/**
 * Token stream → command IR.
 *
 * Recursive descent with precedence (loosest to tightest):
 *   sequence  `;` `&` `\n`
 *   boolean   `&&` `||`
 *   pipeline  `|`
 *   group     `( … )`
 *   command   words (+ leading env assignments, redirections, shell wrappers)
 *
 * Explicit shell wrappers (`bash -c "…"`, `cmd /c "…"`, `powershell -Command
 * "…"`) recursively parse their payload and record it as `wrapper.inner`.
 * Walking the tree never descends into wrapper payloads — inner findings are
 * suppressed by design and replaced by explicit-dependency findings at rule
 * level (see docs/architecture.md).
 */
import type {
  CommandNode,
  EnvAssignment,
  ParseDiagnostic,
  ParseMatrix,
  ParseTarget,
  Redirection,
  ScriptIr,
  ScriptNode,
  TargetParse,
  WrapperInfo,
  WrapperShell,
} from './ir';
import { walkCommands } from './ir';
import type { Token } from './lexer';
import { isEnvAssignmentWord, REDIRECT_OPS, tokenize, tokenizeForTarget } from './lexer';

const SH_SHELLS = new Set(['bash', 'sh']);
const CMD_SHELLS = new Set(['cmd', 'cmd.exe']);
const PS_SHELLS = new Set(['powershell', 'pwsh', 'pwsh.exe', 'powershell.exe']);

/** Parse a raw script string into its command IR. */
export function parseScript(src: string): ScriptIr {
  const tokens = tokenize(src);
  const [node] = parseSequence(tokens, 0, tokens.length, 'posix-sh');
  const root = node ?? emptyCommand();
  const diagnostics: ParseDiagnostic[] = [];
  for (const cmd of walkCommands(root)) {
    cmd.raw = src.slice(cmd.span[0], cmd.span[1]);
    const wrapper = detectWrapper(cmd, src, diagnostics);
    if (wrapper !== null) cmd.wrapper = wrapper;
  }
  return { root };
}

/** Evidence parses always needed by the selected target/rule combination. */
export function requiredEvidenceTargets(
  activeTargets: Iterable<ParseTarget>,
  selectedRules: Iterable<string>,
): ReadonlySet<ParseTarget> {
  const required = new Set<ParseTarget>(['posix-sh', 'cmd']);
  for (const target of activeTargets) required.add(target);
  for (const ruleId of selectedRules) {
    if (ruleId === 'PS003' || ruleId === 'PS032') required.add('powershell');
  }
  return required;
}

/** Parse one source independently according to one target shell. */
export function parseForTarget(src: string, target: ParseTarget): TargetParse {
  const diagnostics = lexicalDiagnostics(src, target);
  const tokens = tokenizeForTarget(src, target);
  diagnostics.push(...groupDiagnostics(tokens));
  if (target === 'powershell') diagnostics.push(...powershellSubsetDiagnostics(src, tokens));
  diagnostics.push(...syntaxDiagnostics(tokens, target));
  const [node] = parseSequence(tokens, 0, tokens.length, target);
  const root = node ?? emptyCommand();
  // `raw` is the exact source slice (quotes preserved) for every command.
  for (const cmd of walkCommands(root)) {
    cmd.raw = src.slice(cmd.span[0], cmd.span[1]);
    const wrapper = detectWrapper(cmd, src, diagnostics);
    if (wrapper !== null) cmd.wrapper = wrapper;
  }
  return { target, root, diagnostics };
}

/** Build active and evidence-only parses without conflating their roles. */
export function parseMatrix(
  source: string,
  activeTargets: Iterable<ParseTarget>,
  selectedRules: Iterable<string>,
): ParseMatrix {
  const active = new Set(activeTargets);
  const byTarget = new Map<ParseTarget, TargetParse>();
  for (const target of requiredEvidenceTargets(active, selectedRules)) {
    byTarget.set(target, parseForTarget(source, target));
  }
  if (
    !byTarget.has('powershell') &&
    [...byTarget.values()].some((parsed) =>
      [...walkCommands(parsed.root)].some(
        (command) => command.wrapper?.payloadTarget === 'powershell',
      ),
    )
  ) {
    byTarget.set('powershell', parseForTarget(source, 'powershell'));
  }
  return { source, activeTargets: active, byTarget };
}

/** Parse a token range; returns the node plus the index where parsing stopped. */
function parseSequence(
  tokens: Token[],
  start: number,
  end: number,
  target: ParseTarget,
): [ScriptNode, number] {
  const parts: ScriptNode[] = [];
  const ops: (';' | '&' | '\n')[] = [];
  const opSpans: [number, number][] = [];
  let i = start;
  while (i < end) {
    const [node, next] = parseBoolean(tokens, i, end, target);
    parts.push(node);
    i = next;
    const tok = tokens[i];
    if (i >= end || tok === undefined) break;
    if (
      tok.kind === 'operator' &&
      (tok.op === ';' || tok.op === '&' || tok.op === '\n') &&
      i < end
    ) {
      ops.push(tok.op as ';' | '&' | '\n');
      opSpans.push(tok.span);
      i += 1;
      continue;
    }
    break; // rparen or other boundary — caller decides
  }
  if (parts.length === 0) return [emptyCommand(), start];
  if (parts.length === 1) return [parts[0] ?? emptyCommand(), i];
  const first = parts[0] as ScriptNode;
  const last = parts[parts.length - 1] as ScriptNode;
  return [{ kind: 'sequence', parts, ops, opSpans, span: [first.span[0], last.span[1]] }, i];
}

function parseBoolean(
  tokens: Token[],
  start: number,
  end: number,
  target: ParseTarget,
): [ScriptNode, number] {
  const parts: ScriptNode[] = [];
  const ops: ('&&' | '||')[] = [];
  const opSpans: [number, number][] = [];
  let i = start;
  while (i < end) {
    const [node, next] = parsePipeline(tokens, i, end, target);
    parts.push(node);
    i = next;
    const tok = tokens[i];
    if (tok === undefined) break;
    if (tok.kind === 'operator' && (tok.op === '&&' || tok.op === '||')) {
      ops.push(tok.op as '&&' | '||');
      opSpans.push(tok.span);
      i += 1;
      continue;
    }
    break;
  }
  if (parts.length === 1) return [parts[0] as ScriptNode, i];
  const first = parts[0] as ScriptNode;
  const last = parts[parts.length - 1] as ScriptNode;
  return [{ kind: 'boolean', parts, ops, opSpans, span: [first.span[0], last.span[1]] }, i];
}

function parsePipeline(
  tokens: Token[],
  start: number,
  end: number,
  target: ParseTarget,
): [ScriptNode, number] {
  const parts: ScriptNode[] = [];
  const opSpans: [number, number][] = [];
  let i = start;
  while (i < end) {
    const [node, next] = parseUnary(tokens, i, end, target);
    parts.push(node);
    i = next;
    const tok = tokens[i];
    if (tok === undefined) break;
    if (tok.kind === 'operator' && tok.op === '|') {
      opSpans.push(tok.span);
      i += 1;
      continue;
    }
    break;
  }
  if (parts.length === 1) return [parts[0] as ScriptNode, i];
  const first = parts[0] as ScriptNode;
  const last = parts[parts.length - 1] as ScriptNode;
  return [{ kind: 'pipeline', parts, opSpans, span: [first.span[0], last.span[1]] }, i];
}

function parseUnary(
  tokens: Token[],
  start: number,
  end: number,
  target: ParseTarget,
): [ScriptNode, number] {
  const tok = tokens[start];
  if (tok === undefined) return [emptyCommand(), start];
  if (tok.kind === 'lparen') {
    let depth = 0;
    let i = start;
    for (; i < end; i += 1) {
      const t = tokens[i] as Token;
      if (t.kind === 'lparen') depth += 1;
      else if (t.kind === 'rparen') {
        depth -= 1;
        if (depth === 0) break;
      }
    }
    const closeIdx = i; // index of matching rparen (or end)
    const [body] = parseSequence(tokens, start + 1, closeIdx, target);
    const close = tokens[closeIdx];
    const spanEnd =
      close !== undefined && close.kind === 'rparen'
        ? close.span[1]
        : (tokens[closeIdx - 1] ?? tok).span[1];
    return [
      { kind: 'group', body, span: [tok.span[0], spanEnd] },
      closeIdx + 1 <= end ? closeIdx + 1 : end,
    ];
  }
  if (tok.kind === 'rparen') {
    // stray `)` — treat as empty and let the caller continue
    return [emptyCommand(), start + 1];
  }
  return parseCommand(tokens, start, end, target);
}

function parseCommand(
  tokens: Token[],
  start: number,
  end: number,
  target: ParseTarget,
): [ScriptNode, number] {
  const leadingEnv: EnvAssignment[] = [];
  const argv: Token[] = [];
  const redirects: Redirection[] = [];
  let i = start;
  let rawStart = -1;
  let rawEnd = -1;

  while (i < end) {
    const tok = tokens[i] as Token;
    if (tok.kind === 'word') {
      if (target === 'posix-sh' && argv.length === 0 && isEnvAssignmentWord(tok.value)) {
        const eq = tok.value.indexOf('=');
        leadingEnv.push({
          name: tok.value.slice(0, eq),
          value: tok.value.slice(eq + 1),
          span: tok.span,
        });
        if (rawStart === -1) rawStart = tok.span[0];
        rawEnd = tok.span[1];
        i += 1;
        continue;
      }
      argv.push(tok);
      if (rawStart === -1) rawStart = tok.span[0];
      rawEnd = tok.span[1];
      i += 1;
      continue;
    }
    if (tok.kind === 'operator' && tok.op !== undefined && REDIRECT_OPS.has(tok.op)) {
      const target = tokens[i + 1];
      redirects.push({
        op: tok.op,
        target: target !== undefined && target.kind === 'word' ? target : null,
        span: tok.span,
      });
      if (target !== undefined && target.kind === 'word') {
        rawEnd = target.span[1];
        i += 2;
      } else {
        // Target-less redirection (e.g. trailing `2>&1`): still extends the span.
        rawEnd = Math.max(rawEnd, tok.span[1]);
        i += 1;
      }
      continue;
    }
    break; // operator/lparen/rparen boundary
  }

  if (argv.length === 0 && leadingEnv.length === 0 && redirects.length === 0) {
    return [emptyCommand(), i];
  }

  const span: [number, number] = [
    rawStart === -1 ? (tokens[start] as Token).span[0] : rawStart,
    rawEnd,
  ];
  const cmd: CommandNode = {
    kind: 'command',
    raw: '', // filled by caller wrapper check below
    span,
    argv,
    leadingEnv,
    redirects,
  };

  return [cmd, i];
}

function emptyCommand(): CommandNode {
  return {
    kind: 'command',
    raw: '',
    span: [0, 0],
    argv: [],
    leadingEnv: [],
    redirects: [],
  };
}

/** Detect `bash -c payload`, `cmd /c payload`, `powershell -Command payload`. */
function detectWrapper(
  cmd: CommandNode,
  source: string,
  diagnostics: ParseDiagnostic[],
): WrapperInfo | null {
  if (cmd.argv.length < 2) return null;
  const executable = cmd.argv[0] as Token;
  if (!isLiteralToken(executable)) return null;
  const name = executable.value.toLowerCase();
  let shell: WrapperShell | null = null;
  if (SH_SHELLS.has(name)) shell = name === 'bash' ? 'bash' : 'sh';
  else if (CMD_SHELLS.has(name)) shell = 'cmd';
  else if (PS_SHELLS.has(name)) shell = 'powershell';
  if (shell === null) return null;
  const payloadTarget: ParseTarget =
    shell === 'cmd' ? 'cmd' : shell === 'powershell' ? 'powershell' : 'posix-sh';

  for (let i = 1; i < cmd.argv.length; i += 1) {
    const flagToken = cmd.argv[i] as Token;
    if (!isLiteralToken(flagToken)) continue;
    const flag = flagToken.value;
    const isRunFlag =
      shell === 'cmd'
        ? /^\/c$/i.test(flag)
        : shell === 'powershell'
          ? /^--?command$/i.test(flag) || flag === '-c'
          : flag === '-c';
    if (!isRunFlag) continue;
    if (!hasValidWrapperFlagPosition(shell, cmd.argv, i)) continue;
    const firstPayload = cmd.argv[i + 1];
    if (firstPayload === undefined) {
      diagnostics.push({
        code: 'missing-wrapper-payload',
        message: 'Wrapper execution flag requires a payload',
        span: flagToken.span,
        severity: 'error',
      });
      return {
        shell,
        raw: `${executable.raw} ${flag}`,
        span: [executable.span[0], flagToken.span[1]],
        payloadTarget,
        payloadSupport: 'unsupported-wrapper-boundary',
        payloadSourceSpan: null,
        payloadRaw: null,
        inner: null,
      };
    }
    const firstOuterRedirection = cmd.redirects
      .filter((redirect) => redirect.span[0] >= firstPayload.span[0])
      .sort((left, right) => left.span[0] - right.span[0])[0];
    const candidateEnd =
      shell === 'bash' || shell === 'sh'
        ? firstPayload.span[1]
        : firstOuterRedirection === undefined
          ? (cmd.argv[cmd.argv.length - 1]?.span[1] ?? firstPayload.span[1])
          : trimEndBefore(source, firstPayload.span[0], firstOuterRedirection.span[0]);
    const candidateSpan: [number, number] = [firstPayload.span[0], candidateEnd];
    const candidateTokens =
      shell === 'bash' || shell === 'sh'
        ? [firstPayload]
        : cmd.argv.slice(i + 1).filter((token) => token.span[1] <= candidateEnd);
    const payloadSourceSpan = exactPayloadSpan(source, candidateSpan, candidateTokens);
    const first = executable.span;
    const wrapperSpan: [number, number] = [first[0], candidateSpan[1]];
    if (payloadSourceSpan === null) {
      diagnostics.push({
        code: 'unsupported-wrapper-boundary',
        message: 'Wrapper payload cannot be mapped to an exact source slice',
        span: candidateSpan,
        severity: 'advisory',
      });
      return {
        shell,
        raw: `${executable.raw} ${flag}`,
        span: wrapperSpan,
        payloadTarget,
        payloadSupport: 'unsupported-wrapper-boundary',
        payloadSourceSpan: null,
        payloadRaw: null,
        inner: null,
      };
    }
    const payloadRaw = source.slice(payloadSourceSpan[0], payloadSourceSpan[1]);
    const innerParse = parseForTarget(payloadRaw, payloadTarget);
    translateNode(innerParse.root, payloadSourceSpan[0]);
    for (const diagnostic of innerParse.diagnostics) {
      diagnostics.push(translateDiagnostic(diagnostic, payloadSourceSpan[0]));
    }
    return {
      shell,
      raw: `${executable.raw} ${flag}`,
      span: wrapperSpan,
      payloadTarget,
      payloadSupport: 'supported',
      payloadSourceSpan,
      payloadRaw,
      inner: { root: innerParse.root },
    };
  }
  return null;
}

function hasValidWrapperFlagPosition(
  shell: WrapperShell,
  argv: readonly Token[],
  flagIndex: number,
): boolean {
  const prefix = argv.slice(1, flagIndex);
  if (prefix.some((token) => !isLiteralToken(token))) return false;
  if (shell === 'bash' || shell === 'sh') {
    return prefix.every((token) => token.value.startsWith('-'));
  }
  if (shell === 'cmd') {
    return prefix.every((token) => /^\/(?:d|q|a|u|s)$/i.test(token.value));
  }

  const switches = new Set(['-nologo', '-noprofile', '-noninteractive', '-mta', '-sta']);
  const valueOptions = new Set([
    '-executionpolicy',
    '-inputformat',
    '-outputformat',
    '-windowstyle',
  ]);
  for (let index = 0; index < prefix.length; index += 1) {
    const value = prefix[index]?.value.toLowerCase();
    if (value === undefined) return false;
    if (switches.has(value)) continue;
    if (valueOptions.has(value) && prefix[index + 1] !== undefined) {
      index += 1;
      continue;
    }
    return false;
  }
  return true;
}

function trimEndBefore(source: string, start: number, end: number): number {
  let cursor = end;
  while (cursor > start && /\s/.test(source.charAt(cursor - 1))) cursor -= 1;
  return cursor;
}

function isLiteralToken(token: Token): boolean {
  return token.expansions.length === 0;
}

function exactPayloadSpan(
  source: string,
  candidateSpan: [number, number],
  tokens: readonly Token[],
): [number, number] | null {
  const raw = source.slice(candidateSpan[0], candidateSpan[1]);
  if (tokens.some((token) => token.expansions.length > 0)) return null;

  if (
    tokens.length === 1 &&
    tokens[0]?.span[0] === candidateSpan[0] &&
    tokens[0].span[1] === candidateSpan[1]
  ) {
    const token = tokens[0];
    if (
      token.quote !== null &&
      raw.charAt(0) === token.quote &&
      raw.charAt(raw.length - 1) === token.quote &&
      token.value === raw.slice(1, -1)
    ) {
      return [candidateSpan[0] + 1, candidateSpan[1] - 1];
    }
  }

  if (tokens.every((token) => token.raw === token.value)) return candidateSpan;
  return null;
}

function lexicalDiagnostics(source: string, target: ParseTarget): ParseDiagnostic[] {
  const diagnostics: ParseDiagnostic[] = [];
  let quote: "'" | '"' | null = null;
  let quoteStart = -1;
  let i = 0;
  while (i < source.length) {
    const char = source.charAt(i);
    if (quote === null) {
      if (char === "'" && target !== 'cmd') {
        quote = "'";
        quoteStart = i;
      } else if (char === '"') {
        quote = '"';
        quoteStart = i;
      } else if (char === '\\' && target === 'posix-sh') {
        i += 1;
      } else if (char === '^' && target === 'cmd') {
        i += 1;
      } else if (char === '`' && target === 'powershell') {
        i += 1;
      }
    } else if (quote === "'") {
      if (char === "'" && target === 'powershell' && source.charAt(i + 1) === "'") {
        i += 1;
      } else if (char === "'") {
        quote = null;
      }
    } else if (char === '\\' && target === 'posix-sh') {
      i += 1;
    } else if (char === '`' && target === 'powershell') {
      i += 1;
    } else if (char === '"') {
      quote = null;
    }
    i += 1;
  }
  if (quote !== null) {
    if (target === 'cmd') return diagnostics;
    diagnostics.push({
      code: 'unterminated-quote',
      message: `Unterminated ${quote === "'" ? 'single' : 'double'} quote`,
      span: [quoteStart, source.length],
      severity: 'error',
    });
  }
  return diagnostics;
}

function syntaxDiagnostics(tokens: readonly Token[], target: ParseTarget): ParseDiagnostic[] {
  const diagnostics: ParseDiagnostic[] = [];
  let needsCommand = true;
  for (const token of tokens) {
    const isControl =
      token.kind === 'operator' &&
      token.op !== undefined &&
      (token.op === '&&' ||
        token.op === '||' ||
        token.op === '|' ||
        token.op === ';' ||
        token.op === '&' ||
        token.op === '\n');
    if (isControl) {
      if (needsCommand && token.op !== '\n') {
        diagnostics.push({
          code: 'missing-command',
          message: `Missing command before \`${token.op}\``,
          span: token.span,
          severity: 'error',
        });
      }
      needsCommand = true;
      continue;
    }
    if (token.kind !== 'rparen') needsCommand = false;
  }
  const last = tokens[tokens.length - 1];
  if (
    last?.kind === 'operator' &&
    last.op !== undefined &&
    (last.op === '&&' || last.op === '||' || last.op === '|')
  ) {
    diagnostics.push({
      code: 'missing-command',
      message: `Missing command after \`${last.op}\``,
      span: last.span,
      severity: 'error',
    });
  }

  for (let i = 0; i < tokens.length; i += 1) {
    const token = tokens[i];
    if (
      target === 'powershell' &&
      token?.kind === 'operator' &&
      (token.op === '&&' || token.op === '||' || token.op === '&')
    ) {
      diagnostics.push({
        code: 'unsupported-subset',
        message: `PowerShell operator \`${token.op}\` is outside the supported analyzer subset`,
        span: token.span,
        severity: 'advisory',
      });
    }
    if (token?.kind === 'operator' && token.op !== undefined && REDIRECT_OPS.has(token.op)) {
      if (token.op !== '2>&1' && token.op !== '1>&2' && tokens[i + 1]?.kind !== 'word') {
        diagnostics.push({
          code: 'missing-redirection-target',
          message: `Missing operand after redirection \`${token.op}\``,
          span: token.span,
          severity: 'error',
        });
      }
    }
    if (token?.kind !== 'word') continue;
    for (const expansion of token.expansions) {
      if (target !== 'cmd' && expansion.kind === 'command' && !expansion.raw.endsWith(')')) {
        diagnostics.push({
          code: 'unterminated-expansion',
          message: 'Unterminated command substitution',
          span: expansion.span,
          severity: 'error',
        });
      } else if (target !== 'cmd' && expansion.kind === 'braced' && !expansion.raw.endsWith('}')) {
        diagnostics.push({
          code: 'unterminated-expansion',
          message: 'Unterminated parameter expansion',
          span: expansion.span,
          severity: 'error',
        });
      } else if (
        target === 'powershell' &&
        (expansion.kind === 'var' ||
          expansion.kind === 'braced' ||
          expansion.kind === 'command' ||
          expansion.kind === 'special')
      ) {
        diagnostics.push({
          code: 'unsupported-subset',
          message: 'PowerShell variable syntax is outside the supported analyzer subset',
          span: expansion.span,
          severity: 'advisory',
        });
      }
    }
  }
  return diagnostics;
}

function groupDiagnostics(tokens: readonly Token[]): ParseDiagnostic[] {
  const diagnostics: ParseDiagnostic[] = [];
  const openings: Token[] = [];
  for (const token of tokens) {
    if (token.kind === 'lparen') {
      openings.push(token);
    } else if (token.kind === 'rparen') {
      const opening = openings.pop();
      if (opening === undefined) {
        diagnostics.push({
          code: 'unbalanced-group',
          message: 'Unbalanced closing group delimiter',
          span: token.span,
          severity: 'error',
        });
      }
    }
  }
  for (const opening of openings) {
    diagnostics.push({
      code: 'unbalanced-group',
      message: 'Unbalanced opening group delimiter',
      span: opening.span,
      severity: 'error',
    });
  }
  return diagnostics;
}

function powershellSubsetDiagnostics(source: string, tokens: readonly Token[]): ParseDiagnostic[] {
  const diagnostics: ParseDiagnostic[] = [];
  const commentStart = findPowerShellCommentStart(source);
  if (commentStart !== -1) {
    diagnostics.push({
      code: 'unsupported-subset',
      message: 'PowerShell comments are outside the supported analyzer subset',
      span: [commentStart, source.length],
      severity: 'advisory',
    });
  }

  const openings: Token[] = [];
  for (const token of tokens) {
    if (token.kind === 'lparen') {
      openings.push(token);
      continue;
    }
    if (token.kind !== 'rparen') continue;
    const opening = openings.pop();
    if (opening === undefined) continue;
    const arrayPrefix = opening.span[0] > 0 && source.charAt(opening.span[0] - 1) === '@';
    diagnostics.push({
      code: 'unsupported-subset',
      message: arrayPrefix
        ? 'PowerShell array expressions are outside the supported analyzer subset'
        : 'PowerShell parenthesized expressions are outside the supported analyzer subset',
      span: [arrayPrefix ? opening.span[0] - 1 : opening.span[0], token.span[1]],
      severity: 'advisory',
    });
  }
  return diagnostics;
}

function findPowerShellCommentStart(source: string): number {
  let quote: "'" | '"' | null = null;
  for (let index = 0; index < source.length; index += 1) {
    const char = source.charAt(index);
    if (char === '`') {
      index += 1;
      continue;
    }
    if (quote === null) {
      if (char === "'" || char === '"') quote = char;
      else if (char === '#') return index;
      continue;
    }
    if (quote === "'" && char === "'" && source.charAt(index + 1) === "'") {
      index += 1;
      continue;
    }
    if (char === quote) quote = null;
  }
  return -1;
}

function translateDiagnostic(diagnostic: ParseDiagnostic, offset: number): ParseDiagnostic {
  return { ...diagnostic, span: translateSpan(diagnostic.span, offset) };
}

function translateSpan(span: [number, number], offset: number): [number, number] {
  return [span[0] + offset, span[1] + offset];
}

function translateToken(token: Token, offset: number): void {
  token.span = translateSpan(token.span, offset);
  for (const expansion of token.expansions) expansion.span = translateSpan(expansion.span, offset);
}

function translateNode(node: ScriptNode, offset: number): void {
  node.span = translateSpan(node.span, offset);
  switch (node.kind) {
    case 'command':
      for (const token of node.argv) translateToken(token, offset);
      for (const assignment of node.leadingEnv)
        assignment.span = translateSpan(assignment.span, offset);
      for (const redirect of node.redirects) {
        redirect.span = translateSpan(redirect.span, offset);
        if (redirect.target !== null) translateToken(redirect.target, offset);
      }
      if (node.wrapper !== undefined) {
        node.wrapper.span = translateSpan(node.wrapper.span, offset);
        if (node.wrapper.payloadSourceSpan !== null) {
          node.wrapper.payloadSourceSpan = translateSpan(node.wrapper.payloadSourceSpan, offset);
        }
        if (node.wrapper.inner !== null) translateNode(node.wrapper.inner.root, offset);
      }
      return;
    case 'group':
      translateNode(node.body, offset);
      return;
    case 'sequence':
      node.opSpans = node.opSpans.map((span) => translateSpan(span, offset));
      for (const part of node.parts) translateNode(part, offset);
      return;
    case 'boolean':
    case 'pipeline':
      node.opSpans = node.opSpans.map((span) => translateSpan(span, offset));
      for (const part of node.parts) translateNode(part, offset);
      return;
  }
}
