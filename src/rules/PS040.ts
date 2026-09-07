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
    'Only commands in the known-tool registry are checked — arbitrary words are never flagged. Dependency aliases are resolved to their provider, workspace packages must expose a real bin through a compatible dependency, and root toolchains count only for deterministically identified npm/pnpm or non-PnP Yarn Classic workspaces.',
  fixSafety: 'conditional',
  provenance: [
    {
      source: 'https://github.com/npm/run-script/blob/main/lib/set-path.js',
      claim:
        'npm run-script walks from the script cwd to the filesystem root and adds each ancestor node_modules/.bin to PATH.',
    },
    {
      source: 'https://pnpm.io/cli/run',
      claim:
        'pnpm run explicitly adds the workspace-root node_modules/.bin to every workspace package script PATH.',
    },
    {
      source: 'https://classic.yarnpkg.com/lang/en/docs/workspaces/',
      claim:
        'Yarn Classic hoists compatible workspace dependencies to the root node_modules tree, while version-mismatched dependencies come from the registry.',
    },
    {
      source: 'https://yarnpkg.com/features/pnp#shared-binaries',
      claim:
        'Yarn PnP keeps a root binary root-only; each workspace using the binary must declare its provider.',
    },
    {
      source: 'https://bun.sh/docs/pm/isolated-installs',
      claim:
        'New Bun workspaces default to isolated installs, where packages are expected to access only explicitly declared dependencies.',
    },
  ],
  check(matrix, ctx: RuleContext): Finding[] {
    const findings: Finding[] = [];
    for (const target of matrix.activeTargets) {
      for (const cmd of commandsOf(matrix, target)) {
        const first = cmd.argv[0];
        if (first === undefined) continue;
        const name = first.value;
        const providers = KNOWN_TOOLS.get(name);
        if (providers === undefined) continue;
        if (SYSTEM_AND_TOOLCHAIN.has(name)) continue;
        const primaryProvider = providers[0];
        if (primaryProvider === undefined) continue;
        const hasIt =
          providers.some((provider) => ctx.dependencies.has(provider)) ||
          ctx.workspaceBins.has(name);
        if (hasIt) continue;
        const providerDescription =
          providers.length === 1
            ? `\`${primaryProvider}\``
            : `one of ${providers.map((provider) => `\`${provider}\``).join(', ')}`;
        const finding = makeFinding(
          this,
          { ...ctx, targets: [target] },
          {
            message: `\`${name}\` is not declared as a dependency (provided by ${providerDescription})`,
            span: first.span,
            fix: {
              ruleId: this.id,
              safety: 'conditional',
              description: `add \`${primaryProvider}\` to devDependencies (never auto-installed by scriptspect)`,
              requiresDependency: primaryProvider,
            },
          },
        );
        if (finding !== null) findings.push(finding);
      }
    }
    return findings;
  },
};
