/**
 * PS040 — MISSING_LOCAL_BIN: a script invokes a known local CLI tool that is
 * not declared as a dependency (or exposed by a workspace package).
 */
import { makeFinding } from '../core/finding';
import { KNOWN_TOOLS, SYSTEM_AND_TOOLCHAIN } from './known-tools';
import type { Finding, RuleContext, RuleModule } from './types';
import { commandsOf } from './util';

export const PS040: RuleModule = {
  id: 'PS040',
  title: 'MISSING_LOCAL_BIN',
  summary: 'Script uses a local CLI tool that is not declared in dependencies or workspace bins.',
  severity: 'warn',
  confidence: 'high',
  affectedTargets: ['posix-sh', 'cmd', 'powershell'],
  badExamples: ['vite build  (vite not in dependencies)', 'jest  (jest not installed)'],
  goodExamples: ['vite build  (vite in devDependencies)', 'my-workspace-tool  (workspace bin)'],
  falsePositiveNotes:
    'Only commands in the known-tool registry are checked — arbitrary words are never flagged. Declared dependencies and workspace package bins count as present.',
  fixSafety: 'conditional',
  provenance: [
    {
      source: 'https://docs.npmjs.com/cli/v10/using-npm/scripts',
      claim:
        'npm adds node_modules/.bin to PATH for script execution; an undeclared tool is not there.',
    },
    {
      source: 'https://pnpm.io/workspaces',
      claim: 'Workspace packages expose their bin field to sibling scripts.',
    },
  ],
  check(matrix, ctx: RuleContext): Finding[] {
    const findings: Finding[] = [];
    for (const target of matrix.activeTargets) {
      for (const cmd of commandsOf(matrix, target)) {
        const first = cmd.argv[0];
        if (first === undefined) continue;
        const name = first.value;
        const pkg = KNOWN_TOOLS.get(name);
        if (pkg === undefined) continue;
        if (SYSTEM_AND_TOOLCHAIN.has(name)) continue;
        const hasIt =
          ctx.dependencies.has(pkg) || ctx.dependencies.has(name) || ctx.workspaceBins.has(name);
        if (hasIt) continue;
        const finding = makeFinding(
          this,
          { ...ctx, targets: [target] },
          {
            message: `\`${name}\` is not declared as a dependency (provided by \`${pkg}\`)`,
            span: first.span,
            fix: {
              ruleId: this.id,
              safety: 'conditional',
              description: `add \`${pkg}\` to devDependencies (never auto-installed by scriptspect)`,
              requiresDependency: pkg,
            },
          },
        );
        if (finding !== null) findings.push(finding);
      }
    }
    return findings;
  },
};
