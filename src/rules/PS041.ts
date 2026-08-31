/**
 * PS041 — PLATFORM_EXE_SUFFIX: `.bat` / `.cmd` / `.exe` invocations bind the
 * script to Windows artifacts.
 */
import { makeFinding } from '../core/finding';
import type { Finding, RuleContext, RuleModule } from './types';
import { commandsOf } from './util';

const EXE_RE = /\.(bat|cmd|exe|ps1)$/i;

export const PS041: RuleModule = {
  id: 'PS041',
  title: 'PLATFORM_EXE_SUFFIX',
  summary: 'Invoking .bat/.cmd/.exe/.ps1 files ties the script to Windows.',
  severity: 'warn',
  confidence: 'high',
  affectedTargets: ['posix-sh'],
  badExamples: ['build.cmd', 'scripts\\deploy.bat', 'tool.exe --flag'],
  goodExamples: ['node scripts/deploy.js', 'cross-platform-bin --flag'],
  falsePositiveNotes:
    'Only the invoked command (argv[0]) is checked — .bat/.cmd/.exe paths passed as arguments are data, not invocations. Intentional Windows-only steps should be suppressed via config.',
  fixSafety: 'manual',
  provenance: [
    {
      source: 'https://en.wikipedia.org/wiki/Batch_file',
      claim:
        '.bat/.cmd/.exe are Windows executable formats; POSIX systems cannot run them directly.',
    },
  ],
  check(ir, ctx: RuleContext): Finding[] {
    const findings: Finding[] = [];
    for (const cmd of commandsOf(ir)) {
      // Only the invoked program (argv[0]) counts — a .exe path passed as an
      // argument (e.g. `node sign.js dist/app.exe`) is data, not an invocation.
      const first = cmd.argv[0];
      if (first === undefined || !EXE_RE.test(first.value)) continue;
      const finding = makeFinding(this, ctx, {
        message: `\`${first.value}\` is a Windows executable; it will not run on macOS/Linux`,
        span: first.span,
        fix: {
          ruleId: this.id,
          safety: 'manual',
          description: "use the package's cross-platform bin or a Node wrapper",
        },
      });
      if (finding !== null) findings.push(finding);
    }
    return findings;
  },
};
