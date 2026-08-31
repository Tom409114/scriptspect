/**
 * Shared rule helpers: IR walking and the POSIX command-availability rule
 * factory used by PS010–PS019. Each rule stays a standalone module with its
 * own metadata; only the mechanical traversal is shared.
 */
import { commandName, walkCommands } from '../parser/ir';
import type { CommandNode, ScriptIr, ScriptNode } from '../parser/ir';
import type { Finding, RuleContext, RuleModule } from './types';
import { makeFinding } from '../core/finding';

/** Tools whose usage already implies the portability problem is handled. */
export const PORTABILITY_TOOLS = new Set(['cross-env', 'cross-env-shell', 'shx', 'rimraf']);

/** Collect sequence operators (`;`, `&`, newline) used anywhere in the tree. */
export function collectSequenceOps(
  node: ScriptNode,
  acc: { op: string; span: [number, number] }[] = [],
): { op: string; span: [number, number] }[] {
  switch (node.kind) {
    case 'sequence':
      node.ops.forEach((op, i) => {
        const span = node.opSpans[i];
        if (span !== undefined) acc.push({ op, span });
      });
      for (const part of node.parts) collectSequenceOps(part, acc);
      return acc;
    case 'boolean':
    case 'pipeline':
      for (const part of node.parts) collectSequenceOps(part, acc);
      return acc;
    case 'group':
      return collectSequenceOps(node.body, acc);
    default:
      return acc;
  }
}

/** Yield every command in the tree (never descends into wrapper payloads). */
export function commandsOf(ir: ScriptIr): CommandNode[] {
  return [...walkCommands(ir.root)];
}

export interface AvailabilityOptions {
  /** Command names the rule matches (lowercase). */
  names: ReadonlySet<string>;
  message: (cmd: CommandNode) => string;
  fixSummary: string;
  /** Extra guard; return false to skip this command. */
  matches?: (cmd: CommandNode) => boolean;
}

/**
 * Factory for “command X does not exist / differs on target shells” rules.
 * Findings anchor on argv[0]; tools that already solve portability
 * (shx/rimraf/…) never appear in command position, so they never fire.
 */
export function availabilityRule(
  rule: Omit<RuleModule, 'check'>,
  options: AvailabilityOptions,
): RuleModule {
  return {
    ...rule,
    check(ir: ScriptIr, ctx: RuleContext): Finding[] {
      const findings: Finding[] = [];
      for (const cmd of commandsOf(ir)) {
        const name = commandName(cmd);
        if (name === null) continue;
        if (!options.names.has(name.toLowerCase())) continue;
        if (options.matches && !options.matches(cmd)) continue;
        const first = cmd.argv[0];
        if (first === undefined) continue;
        const finding = makeFinding(rule, ctx, {
          message: options.message(cmd),
          span: first.span,
          fix: {
            ruleId: rule.id,
            safety: rule.fixSafety,
            description: options.fixSummary,
          },
        });
        if (finding !== null) findings.push(finding);
      }
      return findings;
    },
  };
}

/** True when the command name (lowercased) equals `name`. */
export function isCommand(cmd: CommandNode, name: string): boolean {
  return commandName(cmd)?.toLowerCase() === name;
}

/** Lowercased flag arguments (tokens starting with `-`) of a command. */
export function flagsOf(cmd: CommandNode): string[] {
  return cmd.argv.slice(1).map((t) => t.value).filter((v) => v.startsWith('-'));
}
