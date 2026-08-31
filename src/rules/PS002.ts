/**
 * PS002 — CMD_SET_ENV: `set FOO=bar&& cmd` persists env in cmd.exe but is a
 * no-op assignment in POSIX sh (`set` only manages shell options there).
 */
import { makeFinding } from '../core/finding';
import type { Finding, RuleContext, RuleModule } from './types';
import { commandsOf, isCommand } from './util';

const CMD_SET_RE = /^[A-Za-z_][A-Za-z0-9_]*=/;

export const PS002: RuleModule = {
  id: 'PS002',
  title: 'CMD_SET_ENV',
  summary:
    '`set FOO=bar&& …` sets the variable only for cmd.exe; POSIX sh ignores it as an assignment.',
  severity: 'warn',
  confidence: 'high',
  affectedTargets: ['posix-sh'],
  badExamples: ['set NODE_ENV=production&& node app.js', 'set FOO=bar&& vite build'],
  goodExamples: ['cross-env NODE_ENV=production node app.js', 'node app.js'],
  falsePositiveNotes:
    'Only fires when the argument looks like NAME=VALUE. POSIX `set` option forms (`set -e`, `set -o pipefail`) are not reported by this rule.',
  fixSafety: 'conditional',
  provenance: [
    {
      source:
        'https://learn.microsoft.com/en-us/windows-server/administration/windows-commands/set_1',
      claim:
        'cmd.exe `set VAR=value` defines the variable in the session; `&&` then runs the next command with it set.',
    },
    {
      source: 'https://pubs.opengroup.org/onlinepubs/9699919799/utilities/V3_chap02.html#set',
      claim:
        'POSIX `set` changes shell options / positional parameters — `set FOO=bar` never exports an environment variable.',
    },
  ],
  check(ir, ctx: RuleContext): Finding[] {
    const findings: Finding[] = [];
    for (const cmd of commandsOf(ir)) {
      if (!isCommand(cmd, 'set')) continue;
      const assignment = cmd.argv[1];
      if (assignment === undefined || !CMD_SET_RE.test(assignment.value)) continue;
      const finding = makeFinding(this, ctx, {
        message: `\`set ${assignment.value}\` only sets the variable under cmd.exe; POSIX sh treats it as a positional parameter`,
        span: assignment.span,
        fix: {
          ruleId: this.id,
          safety: 'conditional',
          description:
            'use cross-env for per-command env vars, or restructure to avoid session state',
          requiresDependency: 'cross-env',
        },
      });
      if (finding !== null) findings.push(finding);
    }
    return findings;
  },
};
