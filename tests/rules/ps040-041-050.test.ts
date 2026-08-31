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
});
