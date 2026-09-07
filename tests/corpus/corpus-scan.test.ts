import { describe, expect, it } from 'vitest';
import {
  DEFAULT_CORPUS_LIMITS,
  gitBlobOid,
  parseRepoLocator,
  redactCorpusText,
  selectCorpusFiles,
  type TreeEntry,
} from '../../tools/corpus-lib';

const SHA = '0123456789abcdef0123456789abcdef01234567';

describe('Git blob integrity', () => {
  it('derives the canonical SHA-1 object ID from the exact blob bytes', () => {
    expect(gitBlobOid(Buffer.from('hello\n'))).toBe('ce013625030ba8dba906f756967f9e9ca394464a');
  });
});

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
      managerSignals: [],
      truncations: [],
    });
  });

  it('selects only root npm lockfiles as presence signals without applying byte limits', () => {
    const hugeLockBytes = DEFAULT_CORPUS_LIMITS.maxTotalBytes * 2;
    const tree: TreeEntry[] = [
      { path: 'package.json', type: 'blob', mode: '100644', size: 100, sha: 'root' },
      {
        path: 'package-lock.json',
        type: 'blob',
        mode: '100644',
        size: hugeLockBytes,
        sha: 'lock',
      },
      {
        path: 'npm-shrinkwrap.json',
        type: 'blob',
        mode: '120000',
        size: 10,
        sha: 'link',
      },
      {
        path: 'packages/app/package-lock.json',
        type: 'blob',
        mode: '100644',
        size: 10,
        sha: 'nested',
      },
    ];

    const selected = selectCorpusFiles(tree, DEFAULT_CORPUS_LIMITS);

    expect(selected.files).toEqual([tree[0]]);
    expect(selected.managerSignals).toEqual([tree[1]]);
    expect(selected.truncations).toEqual([]);
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

  it('keeps the root manifest inside the tree-entry budget even when GitHub lists it late', () => {
    const tree: TreeEntry[] = [
      { path: 'a/readme.md', type: 'blob', mode: '100644', size: 20, sha: 'a' },
      { path: 'b/readme.md', type: 'blob', mode: '100644', size: 20, sha: 'b' },
      { path: 'package.json', type: 'blob', mode: '100644', size: 80, sha: 'root' },
    ];

    const selected = selectCorpusFiles(tree, {
      ...DEFAULT_CORPUS_LIMITS,
      maxTreeEntries: 2,
    });

    expect(selected.files.map((entry) => entry.path)).toEqual(['package.json']);
    expect(selected.truncations).toEqual(['tree-entry-limit:2']);
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
