/**
 * Fix builders for the POSIX command rules (spec §7.1):
 * - rm → rimraf when rimraf is already a dependency (flags folded away);
 *   shx rm as the alternative when shx is present
 * - cp/mv/mkdir -p/grep/sed/cat → `shx <cmd>` prefix when shx is a dependency
 * A missing dependency yields a plan (requiresDependency) and never a
 * replacement — no half-fixed states, no silent installs.
 */
import type { CommandNode } from '../parser/ir';
import type { FixCandidate, RuleContext } from './types';

const RECURSIVE_FLAGS = /^-{1,2}(r|rf|fr|R|-recursive)$/;

/** Index of the first non-flag argument (1-based scan of argv). */
function firstArgIndex(cmd: CommandNode): number {
  let i = 1;
  while (i < cmd.argv.length) {
    const v = cmd.argv[i]?.value ?? '';
    if (!v.startsWith('-')) break;
    i += 1;
  }
  return i;
}

/** `rm [-rf] x` → `rimraf x` (rimraf already a devDependency). */
export function rimrafFix(cmd: CommandNode, ctx: RuleContext): FixCandidate {
  const first = cmd.argv[0];
  if (first === undefined) {
    return { ruleId: 'PS010', safety: 'manual', description: 'replace rm with rimraf or shx rm' };
  }
  if (ctx.dependencies.has('rimraf')) {
    const flagsRecursive = cmd.argv.slice(1).some((t) => RECURSIVE_FLAGS.test(t.value));
    const nonFlag = cmd.argv[firstArgIndex(cmd)];
    if (flagsRecursive && nonFlag !== undefined) {
      // Fold `rm -rf` into plain `rimraf` (recursion is rimraf's default).
      return {
        ruleId: 'PS010',
        safety: 'safe',
        description: 'rewrite as `rimraf …` (rimraf is already a dependency)',
        replacement: { span: [first.span[0], nonFlag.span[0]], text: 'rimraf ' },
      };
    }
    return {
      ruleId: 'PS010',
      safety: 'safe',
      description: 'rewrite as `rimraf …` (rimraf is already a dependency)',
      replacement: { span: first.span, text: 'rimraf' },
    };
  }
  if (ctx.dependencies.has('shx')) {
    return {
      ruleId: 'PS010',
      safety: 'safe',
      description: 'rewrite as `shx rm …` (shx is already a dependency)',
      replacement: { span: [first.span[0], first.span[0]], text: 'shx ' },
    };
  }
  return {
    ruleId: 'PS010',
    safety: 'conditional',
    description: 'add rimraf (or shx) as a devDependency, then re-run --fix',
    requiresDependency: 'rimraf',
  };
}

/** `<cmd> …` → `shx <cmd> …` (shx already a dependency). */
export function shxPrefixFix(ruleId: string, cmd: CommandNode, ctx: RuleContext): FixCandidate {
  const first = cmd.argv[0];
  const description = 'prefix with shx (already a dependency)';
  if (first !== undefined && ctx.dependencies.has('shx')) {
    return {
      ruleId,
      safety: 'safe',
      description,
      replacement: { span: [first.span[0], first.span[0]], text: 'shx ' },
    };
  }
  return {
    ruleId,
    safety: 'conditional',
    description: 'add shx as a devDependency, then re-run --fix',
    requiresDependency: 'shx',
  };
}
