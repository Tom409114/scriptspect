import { describe, expect, it } from 'vitest';
import {
  DEFAULT_CORPUS_LIMITS,
  parseRepoLocator,
  redactCorpusText,
  selectCorpusFiles,
  type TreeEntry,
} from '../../tools/corpus-lib';

const SHA = '0123456789abcdef0123456789abcdef01234567';

describe('immutable corpus locators', () => {
  it('accepts only owner/repo plus an exact 40-character commit', () => {
    expect(parseRepoLocator(`open-source/project@${SHA}`)).toEqual({
      repo: 'open-source/project',
      commit: SHA,
    });
    for (const locator of ['open-source/project', 'open-source/project@main', `../repo@${SHA}`]) {
      expect(() => parseRepoLocator(locator)).toThrow(/immutable repository locator/);
    }
  });
});

describe('bounded workspace manifest selection', () => {
  it('keeps root/workspace manifests and excludes dependencies, output, VCS, and symlinks', () => {
    const tree: TreeEntry[] = [
      { path: 'package.json', type: 'blob', mode: '100644', size: 100, sha: 'a' },
      { path: 'pnpm-workspace.yaml', type: 'blob', mode: '100644', size: 50, sha: 'b' },
      { path: 'packages/app/package.json', type: 'blob', mode: '100644', size: 100, sha: 'c' },
      { path: 'node_modules/x/package.json', type: 'blob', mode: '100644', size: 100, sha: 'd' },
      { path: 'dist/package.json', type: 'blob', mode: '100644', size: 100, sha: 'e' },
      { path: '.git/package.json', type: 'blob', mode: '100644', size: 100, sha: 'f' },
      { path: 'packages/link/package.json', type: 'blob', mode: '120000', size: 10, sha: 'g' },
    ];

    expect(selectCorpusFiles(tree, DEFAULT_CORPUS_LIMITS)).toEqual({
      files: [tree[0], tree[1], tree[2]],
      truncations: [],
    });
  });

  it('reports deterministic truncation instead of silently sampling beyond limits', () => {
    const tree: TreeEntry[] = [
      { path: 'package.json', type: 'blob', mode: '100644', size: 80, sha: 'a' },
      { path: 'a/package.json', type: 'blob', mode: '100644', size: 80, sha: 'b' },
      { path: 'b/package.json', type: 'blob', mode: '100644', size: 80, sha: 'c' },
      { path: 'too/deep/for/scan/package.json', type: 'blob', mode: '100644', size: 10, sha: 'd' },
    ];

    const selected = selectCorpusFiles(tree, {
      ...DEFAULT_CORPUS_LIMITS,
      maxManifests: 2,
      maxDepth: 3,
      maxTotalBytes: 160,
    });

    expect(selected.files.map((entry) => entry.path)).toEqual(['package.json', 'a/package.json']);
    expect(selected.truncations).toEqual(
      expect.arrayContaining(['manifest-limit:2', 'depth-limit:3', 'byte-limit:160']),
    );
  });
});

describe('corpus evidence redaction', () => {
  it('removes common credential shapes without copying script source', () => {
    const raw =
      'TOKEN=super-secret npm_abcdefghijklmnopqrstuvwxyz0123456789 ghp_abcdefghijklmnopqrstuvwxyz0123456789';
    const redacted = redactCorpusText(raw);

    expect(redacted).not.toContain('super-secret');
    expect(redacted).not.toContain('npm_abcdefghijklmnopqrstuvwxyz0123456789');
    expect(redacted).not.toContain('ghp_abcdefghijklmnopqrstuvwxyz0123456789');
    expect(redacted).toContain('[REDACTED]');
  });
});
