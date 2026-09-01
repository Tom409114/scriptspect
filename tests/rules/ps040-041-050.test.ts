import { describe, expect, it } from 'vitest';
import { only, run } from './helpers';

describe('PS040 MISSING_LOCAL_BIN', () => {
  it('positive: known tool absent from dependencies', () => {
    expect(only(run('vite build'), 'PS040')).toHaveLength(1);
    expect(only(run('jest src/'), 'PS040')).toHaveLength(1);
    expect(only(run('tsc --noEmit && vite build'), 'PS040')).toHaveLength(2);
  });

  it('negative: tool is a dependency', () => {
    expect(only(run('vite build', { dependencies: new Set(['vite']) }), 'PS040')).toEqual([]);
    expect(only(run('tsc --noEmit', { dependencies: new Set(['typescript']) }), 'PS040')).toEqual(
      [],
    );
    expect(
      only(run('biome check .', { dependencies: new Set(['@biomejs/biome']) }), 'PS040'),
    ).toEqual([]);
    expect(only(run('cpy src out', { dependencies: new Set(['cpy-cli']) }), 'PS040')).toEqual([]);
  });

  it('accepts every verified provider for shared executable names', () => {
    expect(only(run('gatsby build', { dependencies: new Set(['gatsby']) }), 'PS040')).toEqual([]);
    expect(only(run('gatsby build', { dependencies: new Set(['gatsby-cli']) }), 'PS040')).toEqual(
      [],
    );
    expect(
      only(run('playwright test', { dependencies: new Set(['playwright']) }), 'PS040'),
    ).toEqual([]);
    expect(
      only(run('playwright test', { dependencies: new Set(['@playwright/test']) }), 'PS040'),
    ).toEqual([]);
  });

  it('still reports shared executables when none of their providers is declared', () => {
    expect(only(run('gatsby build'), 'PS040')).toEqual([
      expect.objectContaining({ message: expect.stringContaining('gatsby-cli') }),
    ]);
    expect(only(run('playwright test'), 'PS040')).toEqual([
      expect.objectContaining({ message: expect.stringContaining('@playwright/test') }),
    ]);
  });

  it('does not accept a command-named package when a different package provides the bin', () => {
    expect(only(run('cpy src out', { dependencies: new Set(['cpy']) }), 'PS040')).toEqual([
      expect.objectContaining({
        message: expect.stringContaining('provided by `cpy-cli`'),
      }),
    ]);
  });

  it('negative: workspace bins count as present', () => {
    expect(only(run('my-tool x', { workspaceBins: new Set(['my-tool']) }), 'PS040')).toEqual([]);
  });

  it('negative: unknown commands are never flagged (precision first)', () => {
    expect(only(run('my-unknown-cli do things'), 'PS040')).toEqual([]);
    expect(only(run('node app.js'), 'PS040')).toEqual([]);
    expect(only(run('npm test'), 'PS040')).toEqual([]);
  });

  it('suggests the providing package without installing it', () => {
    const [f] = only(run('vite build'), 'PS040');
    expect(f?.fix?.requiresDependency).toBe('vite');
    expect(f?.fix?.safety).toBe('conditional');
  });
});

describe('PS041 PLATFORM_EXE_SUFFIX', () => {
  it('positive: windows executable invocations', () => {
    expect(only(run('build.cmd'), 'PS041')).toHaveLength(1);
    expect(only(run('scripts/deploy.bat --flag'), 'PS041')).toHaveLength(1);
    expect(only(run('tool.exe x'), 'PS041')).toHaveLength(1);
  });

  it('negative: cross-platform commands and node files', () => {
    expect(only(run('node scripts/deploy.js'), 'PS041')).toEqual([]);
    expect(only(run('vite build'), 'PS041')).toEqual([]);
    expect(only(run('echo "run build.cmd later"'), 'PS041')).toEqual([]);
  });

  it('negative: .exe paths passed as arguments are data, not invocations', () => {
    expect(only(run('cp dist/app.exe release/'), 'PS041')).toEqual([]);
    expect(only(run('node scripts/sign.js dist/app.exe'), 'PS041')).toEqual([]);
  });

  it('affected target is posix-sh', () => {
    const [f] = only(run('build.cmd'), 'PS041');
    expect(f?.affectedTargets).toEqual(['posix-sh']);
  });
});

describe('PS050 SHELL_SPECIFIC_SEPARATOR', () => {
  it('positive: semicolon separators (advisory)', () => {
    expect(only(run('a; b'), 'PS050')).toHaveLength(1);
    expect(only(run('node a.js; node b.js'), 'PS050')).toHaveLength(1);
    expect(only(run('x; y; z'), 'PS050')).toHaveLength(2);
  });

  it('positive: single ampersand differs semantically', () => {
    expect(only(run('a & b'), 'PS050')).toHaveLength(1);
  });

  it('negative: && || | are fine everywhere', () => {
    expect(only(run('a && b || c | d'), 'PS050')).toEqual([]);
    expect(only(run('node a.js && node b.js'), 'PS050')).toEqual([]);
    expect(only(run('cat x | grep y'), 'PS050')).toEqual([]);
  });

  it('negative: quoted separators do not split', () => {
    expect(only(run('echo "a; b"'), 'PS050')).toEqual([]);
  });

  it('compares target graphs for single quotes and dialect-specific escapes', () => {
    expect(only(run("echo 'a & b'"), 'PS050')).toHaveLength(1);
    expect(only(run('echo \\& echo next'), 'PS050')).toHaveLength(1);
    expect(only(run('echo ^& echo next'), 'PS050')).toHaveLength(1);
  });

  it('reports executable-role drift caused by POSIX leading assignments', () => {
    const findings = only(run('FOO=x node app.js'), 'PS050');

    expect(findings).toEqual([
      expect.objectContaining({ span: [0, 5] }),
      expect.objectContaining({ span: [6, 10] }),
    ]);
  });

  it('walks grouped command graphs while locating the divergent separator', () => {
    expect(only(run('(a; b)'), 'PS050')).toEqual([
      expect.objectContaining({ span: [2, 3], affectedTargets: ['posix-sh', 'cmd'] }),
    ]);
  });

  it('distinguishes POSIX backslash escapes from cmd redirection syntax', () => {
    expect(only(run('echo \\> out'), 'PS050')).toEqual([
      expect.objectContaining({ span: [6, 7], affectedTargets: ['posix-sh', 'cmd'] }),
    ]);
  });

  it('reports caret-escaped redirection graph divergence at the raw operator span', () => {
    const findings = only(run('echo ^> /dev/null'), 'PS050');

    expect(findings).toEqual([
      expect.objectContaining({
        affectedTargets: ['posix-sh', 'cmd'],
        span: [6, 7],
      }),
    ]);
    expect(only(run('echo ^> /dev/null'), 'PS025')).toEqual([]);
  });

  it('derives graph-divergence targets from the active comparison set', () => {
    expect(only(run('echo ^> out', { targets: ['posix-sh'] }), 'PS050')).toEqual([]);
    expect(
      only(run('echo ^> out', { targets: ['posix-sh', 'cmd'] }), 'PS050')[0]?.affectedTargets,
    ).toEqual(['posix-sh', 'cmd']);
  });

  it('does not substitute the generic graph for PowerShell outside its subset', () => {
    expect(
      only(run('a; b', { targets: ['posix-sh', 'cmd', 'powershell'] }), 'PS050')[0]
        ?.affectedTargets,
    ).toEqual(['posix-sh', 'cmd']);
  });
});
