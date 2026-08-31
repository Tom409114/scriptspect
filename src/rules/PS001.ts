/**
 * PS001 — POSIX_INLINE_ENV: `FOO=bar command` assignments are POSIX-shell
 * syntax with no equivalent in cmd.exe.
 */
import { commandName } from '../parser/ir';
import { makeFinding } from '../core/finding';
import { commandsOf, PORTABILITY_TOOLS } from './util';
import type { Finding, RuleContext, RuleModule } from './types';

export const PS001: RuleModule = {
  id: 'PS001',
  title: 'POSIX_INLINE_ENV',
  summary: 'Inline environment assignments (`FOO=bar cmd`) do not work in cmd.exe npm scripts.',
  severity: 'error',
  confidence: 'high',
  affectedTargets: ['cmd'],
  badExamples: ['NODE_ENV=production vite build', 'A=1 B=2 node app.js', 'GIT_AUTHOR_NAME=x npm publish'],
  goodExamples: ['cross-env NODE_ENV=production vite build', 'node app.js', 'vite build'],
  falsePositiveNotes:
    'Not reported when the command is already cross-env/cross-env-shell (the portability layer exists), or inside explicit shell wrappers.',
  fixSafety: 'conditional',
  provenance: [
    {
      source: 'https://www.gnu.org/software/bash/manual/html_node/Environment.html',
      claim: 'Assignment prefixes are a POSIX shell feature that applies env vars to one command.',
    },
    {
      source: 'https://learn.microsoft.com/en-us/windows-server/administration/windows-commands/set_1',
      claim: 'cmd.exe has no per-command assignment; `set` persists in the session and `FOO=bar cmd` would try to run a program literally named FOO=bar.',
    },
  ],
  check(ir, ctx: RuleContext): Finding[] {
    const findings: Finding[] = [];
    for (const cmd of commandsOf(ir)) {
      if (cmd.leadingEnv.length === 0) continue;
      const name = commandName(cmd);
      if (name !== null && PORTABILITY_TOOLS.has(name.toLowerCase())) continue;
      const first = cmd.leadingEnv[0];
      if (first === undefined) continue;
      const hasCrossEnv = ctx.dependencies.has('cross-env');
      const finding = makeFinding(this, ctx, {
        message: `POSIX inline env assignment \`${first.name}=${first.value}\` is not portable to cmd.exe`,
        span: first.span,
        fix: {
          ruleId: this.id,
          safety: hasCrossEnv ? 'safe' : 'conditional',
          description: hasCrossEnv
            ? `rewrite as \`${first.name}=${first.value} …\` under cross-env (cross-env is already a dependency)`
            : 'add cross-env as a devDependency, then wrap the assignment',
          requiresDependency: hasCrossEnv ? undefined : 'cross-env',
          replacement: hasCrossEnv
            ? { span: [first.span[0], first.span[0]], text: 'cross-env ' }
            : undefined,
        },
      });
      if (finding !== null) findings.push(finding);
    }
    return findings;
  },
};
