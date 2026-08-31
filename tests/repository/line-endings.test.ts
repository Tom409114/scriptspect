import { readFileSync } from 'node:fs';
import { resolve } from 'node:path';
import { describe, expect, it } from 'vitest';

describe('repository line-ending contract', () => {
  it('forces source and generated text to LF while keeping Windows scripts CRLF', () => {
    const attributes = readFileSync(resolve(import.meta.dirname, '../../.gitattributes'), 'utf8');
    expect(attributes).toContain('* text=auto eol=lf');
    expect(attributes).toContain('*.cmd text eol=crlf');
    expect(attributes).toContain('*.ps1 text eol=crlf');
    expect(attributes).toContain('*.png binary');
  });
});
