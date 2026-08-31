import { mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { describe, expect, it } from 'vitest';
import {
  applyRewritesToFile,
  locateScriptSpans,
  rewriteScripts,
} from '../../src/fixers/package-json';

const PKG_2SPACE = `{
  "name": "demo",
  "version": "1.0.0",
  "scripts": {
    "clean": "rm -rf dist",
    "build": "NODE_ENV=production vite build"
  },
  "dependencies": {
    "vite": "^5.0.0"
  }
}
`;

describe('locateScriptSpans', () => {
  it('finds every script with decoded values', () => {
    const spans = locateScriptSpans(PKG_2SPACE);
    expect(spans.get('clean')?.value).toBe('rm -rf dist');
    expect(spans.get('build')?.value).toBe('NODE_ENV=production vite build');
    expect(spans.has('vite')).toBe(false);
  });

  it('handles escaped quotes and backslashes in script values', () => {
    const text = '{"scripts": {"a": "echo \\"rm -rf x\\" && copy \\\\path"}}';
    const spans = locateScriptSpans(text);
    expect(spans.get('a')?.value).toBe('echo "rm -rf x" && copy \\path');
  });
});

describe('rewriteScripts preserves formatting', () => {
  it('changes only the target value with 2-space indentation', () => {
    const next = rewriteScripts(PKG_2SPACE, [{ scriptName: 'clean', newValue: 'rimraf dist' }]);
    expect(next).not.toBeNull();
    expect(next).toContain('"clean": "rimraf dist"');
    expect(next).toContain('"build": "NODE_ENV=production vite build"');
    expect(next).toContain('"vite": "^5.0.0"');
    // indentation, field order, and newline at EOF untouched
    expect(next?.startsWith('{\n  "name": "demo",')).toBe(true);
    expect(next?.endsWith('}\n')).toBe(true);
  });

  it('preserves 4-space indentation and tabs', () => {
    const four = PKG_2SPACE.replace(/ {2}/g, '    ');
    const next4 = rewriteScripts(four, [{ scriptName: 'clean', newValue: 'rimraf dist' }]);
    expect(next4).toContain('    "clean": "rimraf dist"');
    const tabbed = PKG_2SPACE.replace(/ {2}/g, '\t');
    const nextTab = rewriteScripts(tabbed, [{ scriptName: 'clean', newValue: 'rimraf dist' }]);
    expect(nextTab).toContain('\t"clean": "rimraf dist"');
  });

  it('preserves CRLF line endings', () => {
    const crlf = PKG_2SPACE.replace(/\n/g, '\r\n');
    const next = rewriteScripts(crlf, [{ scriptName: 'clean', newValue: 'rimraf dist' }]);
    expect(next).toContain('"clean": "rimraf dist",\r\n');
    expect(next?.split('\r\n').length).toBe(crlf.split('\r\n').length);
  });

  it('escapes newlines in rewritten script values', () => {
    const next = rewriteScripts(PKG_2SPACE, [{ scriptName: 'clean', newValue: 'a &&\nb' }]);
    expect(next).toContain('"clean": "a &&\\nb"');
  });

  it('returns null when nothing changes', () => {
    expect(
      rewriteScripts(PKG_2SPACE, [{ scriptName: 'clean', newValue: 'rm -rf dist' }]),
    ).toBeNull();
    expect(rewriteScripts(PKG_2SPACE, [])).toBeNull();
  });

  it('applies multiple rewrites without offset corruption', () => {
    const next = rewriteScripts(PKG_2SPACE, [
      { scriptName: 'clean', newValue: 'rimraf dist' },
      { scriptName: 'build', newValue: 'vite build' },
    ]);
    expect(next).toContain('"clean": "rimraf dist"');
    expect(next).toContain('"build": "vite build"');
  });
});

describe('applyRewritesToFile', () => {
  it('writes only when asked (dry-run leaves the file untouched)', () => {
    const dir = mkdtempSync(join(tmpdir(), 'ss-fix-'));
    try {
      const file = join(dir, 'package.json');
      writeFileSync(file, PKG_2SPACE);
      const dry = applyRewritesToFile(
        file,
        [{ scriptName: 'clean', newValue: 'rimraf dist' }],
        false,
      );
      expect(dry).toContain('rimraf dist');
      expect(readFileSync(file, 'utf8')).toBe(PKG_2SPACE);
      applyRewritesToFile(file, [{ scriptName: 'clean', newValue: 'rimraf dist' }], true);
      expect(readFileSync(file, 'utf8')).toContain('"clean": "rimraf dist"');
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });
});
