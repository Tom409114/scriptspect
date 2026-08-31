import { mkdirSync, mkdtempSync, realpathSync, rmSync, symlinkSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { describe, expect, it } from 'vitest';
import { ConfigError, isIgnored, loadConfig, parseConfig } from '../../src/config/load';
import { globMatch } from '../../src/config/match';

function temporaryDirectory(prefix: string): string {
  return realpathSync(mkdtempSync(join(tmpdir(), prefix)));
}

describe('glob matcher', () => {
  it('matches exact names', () => {
    expect(globMatch('docs:unix', 'docs:unix')).toBe(true);
    expect(globMatch('docs:unix', 'docs:win')).toBe(false);
  });

  it('matches single-star within segments', () => {
    expect(globMatch('docs:*', 'docs:unix')).toBe(true);
    expect(globMatch('docs:*', 'build:unix')).toBe(false);
  });

  it('matches double-star across segments', () => {
    expect(globMatch('examples/**', 'examples/foo/package.json')).toBe(true);
    expect(globMatch('examples/**', 'examples/package.json')).toBe(true);
    expect(globMatch('examples/**', 'packages/foo/package.json')).toBe(false);
  });

  it('matches star in one segment only', () => {
    expect(globMatch('packages/*', 'packages/web')).toBe(true);
    expect(globMatch('packages/*', 'packages/web/nested')).toBe(false);
  });
});

describe('parseConfig', () => {
  it('accepts the spec example shape', () => {
    const config = parseConfig(
      {
        targets: ['posix-sh', 'cmd'],
        severity: { PS015: 'advisory' },
        ignore: [
          { packages: ['examples/**'], rules: ['PS030'] },
          { scripts: ['docs:unix'], rules: ['PS010', 'PS011'] },
        ],
      },
      'test',
    );
    expect(config.targets).toEqual(['posix-sh', 'cmd']);
    expect(config.severity.get('PS015')).toBe('advisory');
    expect(config.ignore).toHaveLength(2);
  });

  it('defaults to posix-sh + cmd', () => {
    expect(parseConfig({}, 'test').targets).toEqual(['posix-sh', 'cmd']);
  });

  it('rejects invalid targets', () => {
    expect(() => parseConfig({ targets: ['fish'] }, 'test')).toThrow(ConfigError);
  });

  it('rejects duplicate targets instead of silently deduplicating them', () => {
    expect(() => parseConfig({ targets: ['cmd', 'cmd'] }, 'test')).toThrow(ConfigError);
  });

  it('rejects unknown root keys that are likely configuration typos', () => {
    expect(() => parseConfig({ target: ['cmd'] }, 'test')).toThrow(ConfigError);
  });

  it('rejects unknown rule ids in severity', () => {
    expect(() => parseConfig({ severity: { PS999: 'warn' } }, 'test')).toThrow(ConfigError);
  });

  it('rejects unknown rule ids in ignore', () => {
    expect(() => parseConfig({ ignore: [{ rules: ['PS999'] }] }, 'test')).toThrow(ConfigError);
  });

  it('rejects invalid severities', () => {
    expect(() => parseConfig({ severity: { PS010: 'fatal' } }, 'test')).toThrow(ConfigError);
  });

  it('rejects non-object roots', () => {
    expect(() => parseConfig([1, 2], 'test')).toThrow(ConfigError);
  });
});

describe('isIgnored', () => {
  const config = parseConfig(
    {
      ignore: [
        { packages: ['examples/**'], rules: ['PS030'] },
        { scripts: ['docs:unix'], rules: ['PS010', 'PS011'] },
        { packages: ['packages/legacy/package.json'], rules: ['PS001'] },
      ],
    },
    'test',
  );

  it('package glob + rule must both match', () => {
    expect(isIgnored(config, 'examples/a/package.json', 'build', 'PS030')).toBe(true);
    expect(isIgnored(config, 'examples/a/package.json', 'build', 'PS010')).toBe(false);
    expect(isIgnored(config, 'packages/a/package.json', 'build', 'PS030')).toBe(false);
  });

  it('script glob + rule must both match', () => {
    expect(isIgnored(config, 'package.json', 'docs:unix', 'PS011')).toBe(true);
    expect(isIgnored(config, 'package.json', 'docs:win', 'PS011')).toBe(false);
  });

  it('package + rule entries suppress only the named rule', () => {
    expect(isIgnored(config, 'packages/legacy/package.json', 'anything', 'PS001')).toBe(true);
    expect(isIgnored(config, 'packages/legacy/package.json', 'anything', 'PS010')).toBe(false);
  });
});

describe('ignore-all protection (spec §9)', () => {
  it('rejects entries with no keys', () => {
    expect(() => parseConfig({ ignore: [{}] }, 'test')).toThrow(ConfigError);
  });

  it('requires every ignore entry to name at least one rule', () => {
    expect(() => parseConfig({ ignore: [{ packages: ['packages/legacy/**'] }] }, 'test')).toThrow(
      ConfigError,
    );
  });

  it('rejects unknown ignore-entry keys instead of ignoring a typo', () => {
    expect(() =>
      parseConfig({ ignore: [{ rules: ['PS010'], scirpts: ['build'] }] }, 'test'),
    ).toThrow(ConfigError);
  });

  it('rejects empty key arrays', () => {
    expect(() => parseConfig({ ignore: [{ rules: [] }] }, 'test')).toThrow(ConfigError);
    expect(() => parseConfig({ ignore: [{ scripts: [], rules: ['PS010'] }] }, 'test')).toThrow(
      ConfigError,
    );
  });
});

describe('loadConfig discovery', () => {
  it.skipIf(process.platform === 'win32')(
    'rejects a root package.json symlink that escapes the analysis root',
    () => {
      const dir = temporaryDirectory('ss-cfg-root-');
      const outside = temporaryDirectory('ss-cfg-outside-');
      try {
        const outsideManifest = join(outside, 'package.json');
        writeFileSync(outsideManifest, JSON.stringify({ name: 'outside' }));
        symlinkSync(outsideManifest, join(dir, 'package.json'), 'file');

        expect(() => loadConfig(dir)).toThrow(/outside the analysis root/);
      } finally {
        rmSync(dir, { recursive: true, force: true });
        rmSync(outside, { recursive: true, force: true });
      }
    },
  );

  it.skipIf(process.platform === 'win32')(
    'rejects a default config symlink that escapes the analysis root',
    () => {
      const dir = temporaryDirectory('ss-cfg-root-');
      const outside = temporaryDirectory('ss-cfg-outside-');
      try {
        writeFileSync(join(dir, 'package.json'), JSON.stringify({ name: 'x' }));
        const outsideConfig = join(outside, 'scriptspect.config.json');
        writeFileSync(outsideConfig, JSON.stringify({ targets: ['cmd'] }));
        symlinkSync(outsideConfig, join(dir, 'scriptspect.config.json'), 'file');

        expect(() => loadConfig(dir)).toThrow(/outside the analysis root/);
      } finally {
        rmSync(dir, { recursive: true, force: true });
        rmSync(outside, { recursive: true, force: true });
      }
    },
  );

  it('resolves an explicit relative config from the analysis root', () => {
    const dir = temporaryDirectory('ss-cfg-root-');
    try {
      writeFileSync(join(dir, 'package.json'), JSON.stringify({ name: 'x' }));
      mkdirSync(join(dir, 'config'));
      writeFileSync(join(dir, 'config', 'scriptspect.json'), JSON.stringify({ targets: ['cmd'] }));

      const { config, source } = loadConfig(dir, 'config/scriptspect.json');

      expect(config.targets).toEqual(['cmd']);
      expect(source).toBe(join(dir, 'config', 'scriptspect.json'));
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });

  it('rejects an explicit config outside the canonical analysis root', () => {
    const dir = temporaryDirectory('ss-cfg-root-');
    const outside = temporaryDirectory('ss-cfg-outside-');
    try {
      writeFileSync(join(dir, 'package.json'), JSON.stringify({ name: 'x' }));
      const file = join(outside, 'scriptspect.json');
      writeFileSync(file, JSON.stringify({ targets: ['cmd'] }));

      expect(() => loadConfig(dir, file)).toThrow(/outside the analysis root/);
    } finally {
      rmSync(dir, { recursive: true, force: true });
      rmSync(outside, { recursive: true, force: true });
    }
  });

  it('reads the package.json field first', () => {
    const dir = temporaryDirectory('ss-cfg-');
    writeFileSync(
      join(dir, 'package.json'),
      JSON.stringify({ name: 'x', scriptspect: { targets: ['cmd'] } }),
    );
    const { config, source } = loadConfig(dir);
    expect(config.targets).toEqual(['cmd']);
    expect(source).toContain('package.json');
  });

  it('falls back to scriptspect.config.json', () => {
    const dir = temporaryDirectory('ss-cfg-');
    writeFileSync(join(dir, 'package.json'), JSON.stringify({ name: 'x' }));
    writeFileSync(
      join(dir, 'scriptspect.config.json'),
      JSON.stringify({ targets: ['powershell'] }),
    );
    const { config, source } = loadConfig(dir);
    expect(config.targets).toEqual(['powershell']);
    expect(source).toContain('scriptspect.config.json');
  });

  it('explicit --config path wins', () => {
    const dir = temporaryDirectory('ss-cfg-');
    writeFileSync(
      join(dir, 'package.json'),
      JSON.stringify({ name: 'x', scriptspect: { targets: ['cmd'] } }),
    );
    const file = join(dir, 'custom.json');
    writeFileSync(file, JSON.stringify({ targets: ['posix-sh'] }));
    const { config } = loadConfig(dir, file);
    expect(config.targets).toEqual(['posix-sh']);
  });

  it('returns defaults when nothing is configured', () => {
    const dir = temporaryDirectory('ss-cfg-');
    writeFileSync(join(dir, 'package.json'), JSON.stringify({ name: 'x' }));
    const { config, source } = loadConfig(dir);
    expect(config.targets).toEqual(['posix-sh', 'cmd']);
    expect(source).toBe('defaults');
  });

  it('throws ConfigError on broken JSON', () => {
    const dir = temporaryDirectory('ss-cfg-');
    writeFileSync(join(dir, 'package.json'), '{ nope');
    expect(() => loadConfig(dir)).toThrow(ConfigError);
  });
});
