import { describe, expect, it } from 'vitest';
import { diffLines, renderPatch } from '../../src/fixers/diff';

describe('diff', () => {
  it('single-line scripts produce -old +new', () => {
    const ops = diffLines('rm -rf dist', 'rimraf dist');
    expect(ops).toEqual([
      { kind: '-', line: 'rm -rf dist' },
      { kind: '+', line: 'rimraf dist' },
    ]);
  });

  it('unchanged lines survive', () => {
    const ops = diffLines('same', 'same');
    expect(ops).toEqual([{ kind: ' ', line: 'same' }]);
  });

  it('multi-line scripts keep common lines', () => {
    const before = 'node a.js\nrm -rf dist\nnode c.js';
    const after = 'node a.js\nrimraf dist\nnode c.js';
    const ops = diffLines(before, after);
    expect(ops).toEqual([
      { kind: ' ', line: 'node a.js' },
      { kind: '-', line: 'rm -rf dist' },
      { kind: '+', line: 'rimraf dist' },
      { kind: ' ', line: 'node c.js' },
    ]);
  });

  it('renders a unified-style patch', () => {
    const patch = renderPatch('package.json', 'clean', 'rm -rf dist', 'rimraf dist');
    expect(patch).toContain('--- a/package.json (scripts.clean)');
    expect(patch).toContain('+++ b/package.json (scripts.clean)');
    expect(patch.split('\n')[2]).toBe('-rm -rf dist');
    expect(patch.split('\n')[3]).toBe('+rimraf dist');
  });
});
