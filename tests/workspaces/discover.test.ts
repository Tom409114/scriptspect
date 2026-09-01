import { mkdirSync, mkdtempSync, rmSync, symlinkSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { describe, expect, it, vi } from 'vitest';
import { parseConfig } from '../../src/config/load';
import type { PackageUnit } from '../../src/core/analyze';
import { AnalyzeError, analyze } from '../../src/core/analyze';
import {
  discoverPackages,
  unitDependencyNames,
  visibleWorkspaceBins,
  workspaceBinNames,
} from '../../src/workspaces/discover';
import { workspaceGlobEngine } from '../../src/workspaces/glob';
import { npmWorkspaceGlobs } from '../../src/workspaces/npm';
import { pnpmWorkspaceGlobs } from '../../src/workspaces/pnpm';

function pkg(
  name: string,
  scripts: Record<string, string> = {},
  extra: Record<string, unknown> = {},
): string {
  return JSON.stringify({ name, scripts, ...extra }, null, 2);
}

function makeProject(files: Record<string, string>): string {
  const root = mkdtempSync(join(tmpdir(), 'ss-ws-'));
  for (const [rel, content] of Object.entries(files)) {
    const file = join(root, rel);
    mkdirSync(join(file, '..'), { recursive: true });
    writeFileSync(file, content);
  }
  return root;
}

const itWithFileSymlinks = process.platform === 'win32' ? it.skip : it;

const UNSAFE_WORKSPACE_GLOBS = [
  ['parent traversal', '../outside/*'],
  ['nested parent traversal', 'packages/../../outside/*'],
  ['POSIX absolute path', '/outside/*'],
  ['Windows drive path', 'C:/outside/*'],
  ['Windows drive-relative path', 'C:outside/*'],
  ['Windows UNC path', String.raw`\\server\share\*`],
  ['slash-form UNC path', '//server/share/*'],
  ['negated traversal', '!../outside/**'],
  ['brace-hidden traversal', 'packages/{safe,../../outside/**}'],
  ['brace-composed traversal', '.{.,safe}/outside/**'],
  ['brace-hidden absolute path', '{packages/*,/outside/*}'],
  ['brace-composed Windows drive path', 'C{:,safe}/outside/**'],
] as const;

describe('npm/Yarn/Bun workspaces field parsing', () => {
  it('accepts the array form', () => {
    expect(npmWorkspaceGlobs(['packages/*', 'tools'])).toEqual(['packages/*', 'tools']);
  });

  it('accepts the packages-object form', () => {
    expect(npmWorkspaceGlobs({ packages: ['apps/*'] })).toEqual(['apps/*']);
  });

  it('ignores malformed fields', () => {
    expect(npmWorkspaceGlobs(undefined)).toEqual([]);
    expect(npmWorkspaceGlobs(42)).toEqual([]);
    expect(npmWorkspaceGlobs({ packages: 'nope' })).toEqual([]);
    expect(npmWorkspaceGlobs([1, 'ok', null])).toEqual(['ok']);
  });

  it.each(UNSAFE_WORKSPACE_GLOBS)(
    'rejects %s before the pattern can reach filesystem discovery',
    (_label, pattern) => {
      expect(() => npmWorkspaceGlobs([pattern])).toThrow(AnalyzeError);
      expect(() => npmWorkspaceGlobs([pattern])).toThrow(/unsafe workspace glob/i);
    },
  );

  it('preserves safe negation and brace patterns inside the workspace root', () => {
    expect(
      npmWorkspaceGlobs([
        'packages/**',
        '!packages/legacy/**',
        'packages/{api,web}',
        'packages/{api,web}/src/**',
      ]),
    ).toEqual([
      'packages/**',
      '!packages/legacy/**',
      'packages/{api,web}',
      'packages/{api,web}/src/**',
    ]);
  });
});

describe('pnpm-workspace.yaml parsing', () => {
  it('reads packages globs without executing pnpm', () => {
    const root = makeProject({ 'pnpm-workspace.yaml': 'packages:\n  - "packages/**"\n' });
    expect(pnpmWorkspaceGlobs(join(root, 'pnpm-workspace.yaml'))).toEqual(['packages/**']);
    rmSync(root, { recursive: true, force: true });
  });

  it.each(UNSAFE_WORKSPACE_GLOBS)(
    'rejects %s before the pattern can reach filesystem discovery',
    (_label, pattern) => {
      const yamlPattern = pattern.replaceAll("'", "''");
      const root = makeProject({
        'pnpm-workspace.yaml': `packages:\n  - '${yamlPattern}'\n`,
      });
      try {
        const file = join(root, 'pnpm-workspace.yaml');
        expect(() => pnpmWorkspaceGlobs(file)).toThrow(AnalyzeError);
        expect(() => pnpmWorkspaceGlobs(file)).toThrow(/unsafe workspace glob/i);
      } finally {
        rmSync(root, { recursive: true, force: true });
      }
    },
  );

  it('preserves safe negation and brace patterns inside the workspace root', () => {
    const root = makeProject({
      'pnpm-workspace.yaml': [
        'packages:',
        "  - 'packages/**'",
        "  - '!packages/legacy/**'",
        "  - 'packages/{api,web}'",
        "  - 'packages/{api,web}/src/**'",
        '',
      ].join('\n'),
    });
    try {
      expect(pnpmWorkspaceGlobs(join(root, 'pnpm-workspace.yaml'))).toEqual([
        'packages/**',
        '!packages/legacy/**',
        'packages/{api,web}',
        'packages/{api,web}/src/**',
      ]);
    } finally {
      rmSync(root, { recursive: true, force: true });
    }
  });

  it('returns empty when the workspace manifest does not exist', () => {
    const root = makeProject({});
    expect(pnpmWorkspaceGlobs(join(root, 'pnpm-workspace.yaml'))).toEqual([]);
    rmSync(root, { recursive: true, force: true });
  });

  it('rejects invalid YAML instead of silently dropping workspace packages', () => {
    const root = makeProject({ 'pnpm-workspace.yaml': 'packages: [1, 2\n' });
    expect(() => pnpmWorkspaceGlobs(join(root, 'pnpm-workspace.yaml'))).toThrow(AnalyzeError);
    expect(() => pnpmWorkspaceGlobs(join(root, 'pnpm-workspace.yaml'))).toThrow(
      /pnpm-workspace\.yaml.*invalid YAML/i,
    );
    rmSync(root, { recursive: true, force: true });
  });

  it('rejects malformed UTF-8 bytes instead of decoding replacement characters', () => {
    const root = makeProject({});
    const file = join(root, 'pnpm-workspace.yaml');
    writeFileSync(
      file,
      Buffer.concat([Buffer.from('packag'), Buffer.from([0xff]), Buffer.from('es: []\n')]),
    );

    expect(() => pnpmWorkspaceGlobs(file)).toThrow(AnalyzeError);
    expect(() => pnpmWorkspaceGlobs(file)).toThrow(/pnpm-workspace\.yaml.*must be valid UTF-8/i);
    rmSync(root, { recursive: true, force: true });
  });

  it.each(['[]\n', 'workspace\n', ''])('rejects a non-object workspace manifest root', (yaml) => {
    const root = makeProject({ 'pnpm-workspace.yaml': yaml });
    expect(() => pnpmWorkspaceGlobs(join(root, 'pnpm-workspace.yaml'))).toThrow(AnalyzeError);
    expect(() => pnpmWorkspaceGlobs(join(root, 'pnpm-workspace.yaml'))).toThrow(
      /pnpm-workspace\.yaml.*workspace manifest root must be an object/i,
    );
    rmSync(root, { recursive: true, force: true });
  });

  it.each([
    ['binary', '!!binary SGVsbG8=\n'],
    ['ordered map', '!!omap\n  - packages: []\n'],
    ['set', '!!set\n  ? packages\n'],
  ])('rejects a tagged %s root instead of treating it as an empty workspace', (_label, yaml) => {
    const root = makeProject({ 'pnpm-workspace.yaml': yaml });
    expect(() => pnpmWorkspaceGlobs(join(root, 'pnpm-workspace.yaml'))).toThrow(AnalyzeError);
    expect(() => pnpmWorkspaceGlobs(join(root, 'pnpm-workspace.yaml'))).toThrow(
      /pnpm-workspace\.yaml.*root must be a plain mapping object/i,
    );
    rmSync(root, { recursive: true, force: true });
  });

  it('allows a valid pnpm settings file with no packages field', () => {
    const root = makeProject({ 'pnpm-workspace.yaml': 'catalog:\n  react: ^19.0.0\n' });
    expect(pnpmWorkspaceGlobs(join(root, 'pnpm-workspace.yaml'))).toEqual([]);
    rmSync(root, { recursive: true, force: true });
  });

  it.each([
    ['a non-array packages field', 'packages: "packages/*"\n'],
    ['a non-string packages entry', 'packages:\n  - "packages/*"\n  - 42\n'],
  ])('rejects %s', (_label, yaml) => {
    const root = makeProject({ 'pnpm-workspace.yaml': yaml });
    expect(() => pnpmWorkspaceGlobs(join(root, 'pnpm-workspace.yaml'))).toThrow(AnalyzeError);
    expect(() => pnpmWorkspaceGlobs(join(root, 'pnpm-workspace.yaml'))).toThrow(
      /pnpm-workspace\.yaml.*"packages" must be an array of non-empty strings/i,
    );
    rmSync(root, { recursive: true, force: true });
  });

  it('rejects an existing workspace manifest that cannot be read as a file', () => {
    const root = makeProject({});
    mkdirSync(join(root, 'pnpm-workspace.yaml'));
    expect(() => pnpmWorkspaceGlobs(join(root, 'pnpm-workspace.yaml'))).toThrow(AnalyzeError);
    expect(() => pnpmWorkspaceGlobs(join(root, 'pnpm-workspace.yaml'))).toThrow(
      /pnpm-workspace\.yaml.*cannot be read/i,
    );
    rmSync(root, { recursive: true, force: true });
  });
});

describe('workspace discovery', () => {
  it('fails closed when the root directory cannot be canonicalized', () => {
    expect(() => discoverPackages(join(tmpdir(), 'scriptspect-definitely-missing-root'))).toThrow(
      AnalyzeError,
    );
  });

  itWithFileSymlinks('rejects a root manifest symlink that escapes the root', () => {
    const root = mkdtempSync(join(tmpdir(), 'ss-ws-root-link-'));
    const outside = makeProject({ 'package.json': pkg('outside') });
    symlinkSync(join(outside, 'package.json'), join(root, 'package.json'), 'file');

    expect(() => discoverPackages(root)).toThrow(/outside the project root|escapes/i);

    rmSync(root, { recursive: true, force: true });
    rmSync(outside, { recursive: true, force: true });
  });

  itWithFileSymlinks('rejects a workspace manifest symlink that escapes the root', () => {
    const root = makeProject({
      'package.json': pkg('root', {}, { workspaces: ['packages/*'] }),
      'packages/linked/placeholder.txt': 'inside',
    });
    const outside = makeProject({ 'package.json': pkg('outside') });
    symlinkSync(join(outside, 'package.json'), join(root, 'packages/linked/package.json'), 'file');

    expect(() => discoverPackages(root)).toThrow(/outside the project root|escapes/i);

    rmSync(root, { recursive: true, force: true });
    rmSync(outside, { recursive: true, force: true });
  });

  itWithFileSymlinks('rejects a pnpm workspace file symlink that escapes the root', () => {
    const root = makeProject({ 'package.json': pkg('root') });
    const outside = makeProject({ 'pnpm-workspace.yaml': 'packages: []\n' });
    symlinkSync(join(outside, 'pnpm-workspace.yaml'), join(root, 'pnpm-workspace.yaml'), 'file');

    expect(() => discoverPackages(root)).toThrow(/outside the project root|escapes/i);

    rmSync(root, { recursive: true, force: true });
    rmSync(outside, { recursive: true, force: true });
  });

  it.each(['packages/link/*', 'packages/link/missing/*', 'packages/{link,real}/*'])(
    'rejects an escaping symlink in static glob base %s before fast-glob runs',
    (pattern) => {
      const root = makeProject({
        'package.json': pkg('root', {}, { workspaces: [pattern] }),
        'packages/real/child/package.json': pkg('inside'),
      });
      const outside = makeProject({ 'child/package.json': pkg('outside') });
      symlinkSync(
        outside,
        join(root, 'packages/link'),
        process.platform === 'win32' ? 'junction' : 'dir',
      );
      const globSync = vi.spyOn(workspaceGlobEngine, 'sync');

      try {
        expect(() => discoverPackages(root)).toThrow(/outside the project root|escapes/i);
        expect(globSync).not.toHaveBeenCalled();
      } finally {
        globSync.mockRestore();
        rmSync(root, { recursive: true, force: true });
        rmSync(outside, { recursive: true, force: true });
      }
    },
  );

  it('allows a static glob base symlink that canonicalizes inside the root', () => {
    const root = makeProject({
      'package.json': pkg('root', {}, { workspaces: ['packages/link/*'] }),
      'packages/real/child/package.json': pkg('inside'),
    });
    symlinkSync(
      join(root, 'packages/real'),
      join(root, 'packages/link'),
      process.platform === 'win32' ? 'junction' : 'dir',
    );

    try {
      expect(discoverPackages(root).packages.map((unit) => unit.relPath)).toEqual([
        'package.json',
        'packages/real/child/package.json',
      ]);
    } finally {
      rmSync(root, { recursive: true, force: true });
    }
  });

  it('keeps safe dynamic, negated, brace, and extglob workspace patterns', () => {
    const root = makeProject({
      'package.json': pkg(
        'root',
        {},
        {
          workspaces: ['packages/{api,web}/*', 'packages/@(api|web)/*', '!packages/web/legacy/*'],
        },
      ),
      'packages/api/tool/package.json': pkg('api-tool'),
      'packages/web/tool/package.json': pkg('web-tool'),
      'packages/web/legacy/old/package.json': pkg('legacy'),
    });

    try {
      expect(discoverPackages(root).packages.map((unit) => unit.relPath)).toEqual([
        'package.json',
        'packages/api/tool/package.json',
        'packages/web/tool/package.json',
      ]);
    } finally {
      rmSync(root, { recursive: true, force: true });
    }
  });

  it('finds root + workspace packages (npm array form)', () => {
    const root = makeProject({
      'package.json': pkg('root', {}, { workspaces: ['packages/*'] }),
      'packages/web/package.json': pkg('web', { build: 'rm -rf dist' }),
      'packages/node-lib/package.json': pkg('node-lib'),
    });
    const { packages } = discoverPackages(root);
    expect(packages.map((p) => p.relPath)).toEqual([
      'package.json',
      'packages/node-lib/package.json',
      'packages/web/package.json',
    ]);
    rmSync(root, { recursive: true, force: true });
  });

  it('finds a package nested more than one directory below a workspace glob', () => {
    const root = makeProject({
      'package.json': pkg('root', {}, { workspaces: ['packages/**'] }),
      'packages/group/tool/package.json': pkg('nested-tool'),
    });
    try {
      expect(discoverPackages(root).packages.map((unit) => unit.relPath)).toEqual([
        'package.json',
        'packages/group/tool/package.json',
      ]);
    } finally {
      rmSync(root, { recursive: true, force: true });
    }
  });

  it('supports the packages-object form (Yarn/Bun style)', () => {
    const root = makeProject({
      'package.json': pkg('root', {}, { workspaces: { packages: ['apps/*'] } }),
      'apps/api/package.json': pkg('api'),
    });
    const { packages } = discoverPackages(root);
    expect(packages).toHaveLength(2);
    rmSync(root, { recursive: true, force: true });
  });

  it('supports pnpm globs alongside package.json workspaces', () => {
    const root = makeProject({
      'package.json': pkg('root', {}, { workspaces: ['packages/a'] }),
      'pnpm-workspace.yaml': 'packages:\n  - "packages/b"\n',
      'packages/a/package.json': pkg('a'),
      'packages/b/package.json': pkg('b'),
    });
    const { packages } = discoverPackages(root);
    expect(packages).toHaveLength(3);
    rmSync(root, { recursive: true, force: true });
  });

  it('skips glob matches without package.json and node_modules content', () => {
    const root = makeProject({
      'package.json': pkg('root', {}, { workspaces: ['packages/*'] }),
      'packages/empty/package.json': pkg('empty'),
      'packages/no-manifest/readme.txt': 'hi',
      'packages/empty/node_modules/dep/package.json': pkg('should-not-appear'),
    });
    const { packages } = discoverPackages(root);
    expect(packages).toHaveLength(2);
    rmSync(root, { recursive: true, force: true });
  });

  it('dedupes packages matched by multiple globs', () => {
    const root = makeProject({
      'package.json': pkg(
        'root',
        {},
        { workspaces: ['packages/*', 'packages/web', 'packages/**'] },
      ),
      'packages/web/package.json': pkg('web'),
    });
    const { packages } = discoverPackages(root);
    expect(packages.filter((p) => p.relPath === 'packages/web/package.json')).toHaveLength(1);
    rmSync(root, { recursive: true, force: true });
  });

  it('never follows symlink loops into recursion (canonical dedupe)', () => {
    const root = makeProject({
      'package.json': pkg('root', {}, { workspaces: ['packages/*'] }),
      'packages/real/package.json': pkg('real'),
    });
    symlinkSync(
      join(root, 'packages/real'),
      join(root, 'packages/link'),
      process.platform === 'win32' ? 'junction' : 'dir',
    );
    const { packages } = discoverPackages(root);
    expect(packages).toHaveLength(2); // root + real (link deduped by realpath)
    rmSync(root, { recursive: true, force: true });
  });

  it('single-package projects return just the root', () => {
    const root = makeProject({ 'package.json': pkg('solo', { build: 'vite build' }) });
    const { packages } = discoverPackages(root);
    expect(packages.map((p) => p.relPath)).toEqual(['package.json']);
    rmSync(root, { recursive: true, force: true });
  });
});

describe('workspace bins and dependencies', () => {
  it('unions only real bin declarations across packages', () => {
    const units: PackageUnit[] = [
      {
        relPath: 'package.json',
        absDir: '/r',
        manifest: { name: 'root', bin: { 'root-cli': './x' } },
      },
      {
        relPath: 'packages/w/package.json',
        absDir: '/r/w',
        manifest: { name: '@scope/w', bin: { wtool: './y' } },
      },
    ];
    expect(workspaceBinNames(units)).toEqual(new Set(['root-cli', 'wtool']));
  });

  it('derives a string bin from the package name and ignores packages without bin', () => {
    const units: PackageUnit[] = [
      { relPath: 'a/package.json', absDir: '/r/a', manifest: { name: 'plain', bin: './cli.js' } },
      {
        relPath: 'b/package.json',
        absDir: '/r/b',
        manifest: { name: '@scope/scoped-cli', bin: './cli.js' },
      },
      { relPath: 'c/package.json', absDir: '/r/c', manifest: { name: 'library-only' } },
    ];

    expect(workspaceBinNames(units)).toEqual(new Set(['plain', 'scoped-cli']));
  });

  it('exposes workspace bins only to packages declaring that workspace dependency', () => {
    const caller: PackageUnit = {
      relPath: 'apps/a/package.json',
      absDir: '/r/apps/a',
      manifest: { dependencies: { '@scope/tool': 'workspace:*' } },
    };
    const undeclaredCaller: PackageUnit = {
      relPath: 'apps/b/package.json',
      absDir: '/r/apps/b',
      manifest: {},
    };
    const tool: PackageUnit = {
      relPath: 'packages/tool/package.json',
      absDir: '/r/packages/tool',
      manifest: { name: '@scope/tool', bin: { custom: './cli.js' } },
    };

    expect(visibleWorkspaceBins(caller, [caller, undeclaredCaller, tool])).toEqual(
      new Set(['custom']),
    );
    expect(visibleWorkspaceBins(undeclaredCaller, [caller, undeclaredCaller, tool])).toEqual(
      new Set(),
    );
  });

  it('unitDependencyNames merges all dependency blocks', () => {
    const unit: PackageUnit = {
      relPath: 'package.json',
      absDir: '/r',
      manifest: {
        dependencies: { a: '1' },
        devDependencies: { b: '1' },
        optionalDependencies: { c: '1' },
        peerDependencies: { d: '1' },
      },
    };
    expect(unitDependencyNames(unit)).toEqual(new Set(['a', 'b', 'c', 'd']));
  });
});

describe('monorepo analysis', () => {
  it('reports findings with per-package paths and script names (spec §8.1)', () => {
    const root = makeProject({
      'package.json': pkg('root', { clean: 'rm -rf dist' }, { workspaces: ['packages/*'] }),
      'packages/web/package.json': pkg(
        'web',
        { build: 'NODE_ENV=production vite build' },
        { devDependencies: { vite: '^5' } },
      ),
    });
    const result = analyze(root, { config: parseConfig({}, 'test') });
    const paths = result.findings.map((f) => `${f.packagePath} ${f.scriptName} ${f.ruleId}`);
    expect(paths).toContain('package.json clean PS010');
    expect(paths).toContain('packages/web/package.json build PS001');
    expect(result.summary.packagesScanned).toBe(2);
    expect(result.summary.scriptsScanned).toBe(2);
    rmSync(root, { recursive: true, force: true });
  });

  it('PS040 recognizes workspace bins (no false missing)', () => {
    const root = makeProject({
      'package.json': pkg(
        'root',
        { build: 'vite build' },
        { workspaces: ['packages/*'], devDependencies: { w: 'workspace:*' } },
      ),
      'packages/w/package.json': pkg('w', {}, { bin: { vite: './bin.js' } }),
    });
    const result = analyze(root, { config: parseConfig({}, 'test') });
    expect(result.findings.filter((f) => f.ruleId === 'PS040')).toHaveLength(0);
    rmSync(root, { recursive: true, force: true });
  });

  it('PS040 reports an undeclared sibling workspace bin', () => {
    const root = makeProject({
      'package.json': pkg('root', { build: 'vite build' }, { workspaces: ['packages/*'] }),
      'packages/w/package.json': pkg('w', {}, { bin: { vite: './bin.js' } }),
    });
    const result = analyze(root, { config: parseConfig({}, 'test') });
    expect(result.findings.filter((finding) => finding.ruleId === 'PS040')).toHaveLength(1);
    rmSync(root, { recursive: true, force: true });
  });

  it('PS040 does not treat a workspace package without bin as executable', () => {
    const root = makeProject({
      'package.json': pkg('root', { build: 'vite build' }, { workspaces: ['packages/*'] }),
      'packages/vite/package.json': pkg('vite'),
    });
    const result = analyze(root, { config: parseConfig({}, 'test') });
    expect(result.findings.filter((finding) => finding.ruleId === 'PS040')).toHaveLength(1);
    rmSync(root, { recursive: true, force: true });
  });

  it('config ignore works per package glob (spec §9)', () => {
    const config = parseConfig(
      { ignore: [{ packages: ['packages/web/**'], rules: ['PS010'] }] },
      'test',
    );
    const root = makeProject({
      'package.json': pkg('root', { clean: 'rm -rf dist' }, { workspaces: ['packages/*'] }),
      'packages/web/package.json': pkg('web', { clean: 'rm -rf dist' }),
    });
    const result = analyze(root, { config });
    const paths = result.findings.filter((f) => f.ruleId === 'PS010').map((f) => f.packagePath);
    expect(paths).toEqual(['package.json']);
    rmSync(root, { recursive: true, force: true });
  });

  it('scans 100 workspace packages in under 2 seconds (spec §8.1)', () => {
    const files: Record<string, string> = {
      'package.json': pkg('root', { build: 'node build.js' }, { workspaces: ['packages/*'] }),
    };
    for (let i = 0; i < 100; i += 1) {
      files[`packages/p${i}/package.json`] = pkg(`p${i}`, {
        build: 'vite build',
        test: 'node test.js',
      });
    }
    const root = makeProject(files);
    const start = performance.now();
    const result = analyze(root, { config: parseConfig({}, 'test') });
    const elapsed = performance.now() - start;
    expect(result.summary.packagesScanned).toBe(101);
    expect(elapsed).toBeLessThan(2000);
    rmSync(root, { recursive: true, force: true });
  });
});
