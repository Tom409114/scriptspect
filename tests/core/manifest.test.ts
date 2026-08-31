import { mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { AnalyzeError, readManifest } from '../../src/core/analyze';

let dir: string;
let file: string;

beforeEach(() => {
  dir = mkdtempSync(join(tmpdir(), 'scriptspect-manifest-'));
  file = join(dir, 'package.json');
});

afterEach(() => {
  rmSync(dir, { recursive: true, force: true });
});

describe('package manifest decoding', () => {
  it('accepts and strips one leading UTF-8 BOM', () => {
    const json = Buffer.from('{"name":"bom","scripts":{"build":"node build.js"}}');
    writeFileSync(file, Buffer.concat([Buffer.from([0xef, 0xbb, 0xbf]), json]));

    expect(readManifest(file)).toMatchObject({ name: 'bom', scripts: { build: 'node build.js' } });
  });

  it('rejects invalid UTF-8 before parsing JSON', () => {
    writeFileSync(file, Buffer.from([0x7b, 0x22, 0xff, 0x22, 0x3a, 0x31, 0x7d]));

    expect(() => readManifest(file)).toThrow(/valid UTF-8/);
  });

  it('rejects a non-object manifest root', () => {
    writeFileSync(file, '[]');

    expect(() => readManifest(file)).toThrow(AnalyzeError);
    expect(() => readManifest(file)).toThrow(/root must be an object/);
  });

  it('rejects non-string root script values with the exact key', () => {
    writeFileSync(file, '{"scripts":{"build":42}}');

    expect(() => readManifest(file)).toThrow(/script "build" must be a string/);
  });

  it('rejects duplicate root scripts objects as ambiguous', () => {
    writeFileSync(file, '{"scripts":{"a":"one"},"scripts":{"b":"two"}}');

    expect(() => readManifest(file)).toThrow(/duplicate root "scripts"/);
  });

  it('rejects duplicate keys inside root scripts as ambiguous', () => {
    writeFileSync(file, '{"scripts":{"build":"one","build":"two"}}');

    expect(() => readManifest(file)).toThrow(/duplicate script key "build"/);
  });
});
