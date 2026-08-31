/**
 * Command IR for parsed npm scripts.
 *
 * A script parses to a tree: sequences (split on `;`, `&`, newlines), boolean
 * chains (`&&`, `||`), pipelines (`|`), groups (parentheses), and leaf
 * commands carrying their argv, leading env assignments, redirections, and —
 * for explicit shell wrappers like `bash -c "…"` — a nested inner script.
 */
import type { Token } from './lexer';

export type ShellTarget = 'posix-sh' | 'cmd' | 'powershell';

export interface EnvAssignment {
  name: string;
  value: string;
  span: [number, number];
}

export interface Redirection {
  op: string;
  /** Redirect target (file word), when present. */
  target: Token | null;
  span: [number, number];
}

export type WrapperShell = 'bash' | 'sh' | 'cmd' | 'powershell';

export interface WrapperInfo {
  shell: WrapperShell;
  /** Wrapper invocation as written (`bash -c`). */
  raw: string;
  span: [number, number];
  /** Parsed payload; spans are relative to the payload string, not the script. */
  inner: ScriptIr | null;
}

export interface CommandNode {
  kind: 'command';
  raw: string;
  span: [number, number];
  argv: Token[];
  leadingEnv: EnvAssignment[];
  redirects: Redirection[];
  wrapper?: WrapperInfo;
}

export type SequenceOp = ';' | '&' | '\n';
export type BooleanOp = '&&' | '||';

export interface SequenceNode {
  kind: 'sequence';
  parts: ScriptNode[];
  ops: SequenceOp[];
  /** Span of each operator token (same length as `ops`). */
  opSpans: [number, number][];
  span: [number, number];
}

export interface BooleanNode {
  kind: 'boolean';
  parts: ScriptNode[];
  ops: BooleanOp[];
  span: [number, number];
}

export interface PipelineNode {
  kind: 'pipeline';
  parts: ScriptNode[];
  span: [number, number];
}

export interface GroupNode {
  kind: 'group';
  body: ScriptNode;
  span: [number, number];
}

export type ScriptNode = CommandNode | SequenceNode | BooleanNode | PipelineNode | GroupNode;

export interface ScriptIr {
  root: ScriptNode;
}

/** Yield every command in the tree, without descending into wrapper payloads. */
export function* walkCommands(node: ScriptNode): Generator<CommandNode> {
  switch (node.kind) {
    case 'command':
      yield node;
      return;
    case 'group':
      yield* walkCommands(node.body);
      return;
    case 'sequence':
    case 'boolean':
    case 'pipeline':
      for (const part of node.parts) yield* walkCommands(part);
      return;
  }
}

/** Command name (argv[0] value), lowercased for comparison; null when absent. */
export function commandName(cmd: CommandNode): string | null {
  const first = cmd.argv[0];
  return first ? first.value : null;
}

/** True when the command's name (case-insensitive) is in `names`. */
export function commandIs(cmd: CommandNode, names: ReadonlySet<string>): boolean {
  const name = commandName(cmd);
  return name !== null && names.has(name.toLowerCase());
}
