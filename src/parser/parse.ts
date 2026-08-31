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
import type { ScriptIr, ScriptNode, CommandNode, EnvAssignment, Redirection, WrapperInfo, WrapperShell } from './ir';
import { REDIRECT_OPS, isEnvAssignmentWord, tokenize } from './lexer';
import type { Token } from './lexer';
import { walkCommands } from './ir';

const SH_SHELLS = new Set(['bash', 'sh', 'zsh', 'dash', 'ksh', 'ash']);
const CMD_SHELLS = new Set(['cmd', 'cmd.exe']);
const PS_SHELLS = new Set(['powershell', 'pwsh', 'pwsh.exe', 'powershell.exe']);

/** Parse a raw script string into its command IR. */
export function parseScript(src: string): ScriptIr {
  const tokens = tokenize(src);
  const [node] = parseSequence(tokens, 0, tokens.length);
  const root = node ?? emptyCommand();
  // `raw` is the exact source slice (quotes preserved) for every command.
  for (const cmd of walkCommands(root)) {
    cmd.raw = src.slice(cmd.span[0], cmd.span[1]);
  }
  return { root };
}

/** Parse a token range; returns the node plus the index where parsing stopped. */
function parseSequence(tokens: Token[], start: number, end: number): [ScriptNode, number] {
  const parts: ScriptNode[] = [];
  const ops: (';' | '&' | '\n')[] = [];
  const opSpans: [number, number][] = [];
  let i = start;
  while (i < end) {
    const [node, next] = parseBoolean(tokens, i, end);
    parts.push(node);
    i = next;
    const tok = tokens[i];
    if (i >= end) break;
    if (tok.kind === 'operator' && (tok.op === ';' || tok.op === '&' || tok.op === '\n') && i < end) {
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

function parseBoolean(tokens: Token[], start: number, end: number): [ScriptNode, number] {
  const parts: ScriptNode[] = [];
  const ops: ('&&' | '||')[] = [];
  let i = start;
  while (i < end) {
    const [node, next] = parsePipeline(tokens, i, end);
    parts.push(node);
    i = next;
    const tok = tokens[i];
    if (i < end && tok.kind === 'operator' && (tok.op === '&&' || tok.op === '||')) {
      ops.push(tok.op as '&&' | '||');
      i += 1;
      continue;
    }
    break;
  }
  if (parts.length === 1) return [parts[0] as ScriptNode, i];
  const first = parts[0] as ScriptNode;
  const last = parts[parts.length - 1] as ScriptNode;
  return [{ kind: 'boolean', parts, ops, span: [first.span[0], last.span[1]] }, i];
}

function parsePipeline(tokens: Token[], start: number, end: number): [ScriptNode, number] {
  const parts: ScriptNode[] = [];
  let i = start;
  while (i < end) {
    const [node, next] = parseUnary(tokens, i, end);
    parts.push(node);
    i = next;
    const tok = tokens[i];
    if (i < end && tok.kind === 'operator' && tok.op === '|') {
      i += 1;
      continue;
    }
    break;
  }
  if (parts.length === 1) return [parts[0] as ScriptNode, i];
  const first = parts[0] as ScriptNode;
  const last = parts[parts.length - 1] as ScriptNode;
  return [{ kind: 'pipeline', parts, span: [first.span[0], last.span[1]] }, i];
}

function parseUnary(tokens: Token[], start: number, end: number): [ScriptNode, number] {
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
    const [body] = parseSequence(tokens, start + 1, closeIdx);
    const close = tokens[closeIdx];
    const spanEnd = close !== undefined && close.kind === 'rparen' ? close.span[1] : (tokens[closeIdx - 1] ?? tok).span[1];
    return [{ kind: 'group', body, span: [tok.span[0], spanEnd] }, closeIdx + 1 <= end ? closeIdx + 1 : end];
  }
  if (tok.kind === 'rparen') {
    // stray `)` — treat as empty and let the caller continue
    return [emptyCommand(), start + 1];
  }
  return parseCommand(tokens, start, end);
}

function parseCommand(tokens: Token[], start: number, end: number): [ScriptNode, number] {
  const leadingEnv: EnvAssignment[] = [];
  const argv: Token[] = [];
  const redirects: Redirection[] = [];
  let i = start;
  let rawStart = -1;
  let rawEnd = -1;

  while (i < end) {
    const tok = tokens[i] as Token;
    if (tok.kind === 'word') {
      if (argv.length === 0 && isEnvAssignmentWord(tok.value)) {
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

  const span: [number, number] = [rawStart === -1 ? (tokens[start] as Token).span[0] : rawStart, rawEnd];
  const cmd: CommandNode = {
    kind: 'command',
    raw: '', // filled by caller wrapper check below
    span,
    argv,
    leadingEnv,
    redirects,
  };

  const wrapper = detectWrapper(cmd);
  if (wrapper !== null) {
    cmd.wrapper = wrapper;
  }
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
function detectWrapper(cmd: CommandNode): WrapperInfo | null {
  if (cmd.argv.length < 2) return null;
  const name = (cmd.argv[0] as Token).value.toLowerCase();
  let shell: WrapperShell | null = null;
  if (SH_SHELLS.has(name)) shell = name === 'bash' ? 'bash' : 'sh';
  else if (CMD_SHELLS.has(name)) shell = 'cmd';
  else if (PS_SHELLS.has(name)) shell = 'powershell';
  if (shell === null) return null;

  for (let i = 1; i < cmd.argv.length - 1; i += 1) {
    const flag = (cmd.argv[i] as Token).value;
    const isRunFlag =
      shell === 'cmd'
        ? /^\/c$/i.test(flag)
        : shell === 'powershell'
          ? /^--?command$/i.test(flag) || flag === '-c'
          : flag === '-c';
    if (!isRunFlag) continue;
    // Quoted form: one token holds the whole payload. Unquoted form
    // (`cmd /c node app.js`): every remaining token belongs to the payload.
    const payloadTokens = cmd.argv.slice(i + 1);
    const firstPayload = payloadTokens[0];
    const lastPayload = payloadTokens[payloadTokens.length - 1];
    if (firstPayload === undefined || lastPayload === undefined) return null;
    const payload = payloadTokens.map((t) => t.value).join(' ');
    const first = (cmd.argv[0] as Token).span;
    return {
      shell,
      raw: `${(cmd.argv[0] as Token).raw} ${flag}`,
      span: [first[0], lastPayload.span[1]],
      inner: parseScript(payload),
    };
  }
  return null;
}
