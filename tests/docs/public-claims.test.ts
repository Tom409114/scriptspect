import { readFileSync } from 'node:fs';
import { describe, expect, it } from 'vitest';

const read = (path: string): string => readFileSync(path, 'utf8');

describe('public project claims', () => {
  it('does not advertise an unpublished major Action tag or completed release gates', () => {
    const roadmap = read('docs/roadmap.md');

    expect(roadmap).not.toContain('@v1');
    expect(roadmap).not.toMatch(/M6[^\n]+✅/u);
    expect(roadmap).not.toMatch(/M7[^\n]+✅/u);
    expect(roadmap).not.toMatch(/M8[^\n]+✅/u);
    expect(roadmap).toContain('PR #64');
  });

  it('keeps the competitive gate pending until a shared-corpus comparison exists', () => {
    const roadmap = read('docs/roadmap.md');
    const report = read('docs/validation/corpus-2026-08.md');

    expect(roadmap).not.toMatch(/Competitive edge[^\n]+✅ pass/iu);
    expect(report).toMatch(/Competitive edge[^\n]+PENDING/iu);
    expect(report).toContain('Not a scripts-doctor head-to-head');
  });

  it('documents the configured failure universe instead of a confidence shortcut', () => {
    const english = read('README.md');
    const chinese = read('README.zh-CN.md');
    const comparison = read('docs/comparison.md');

    expect(english).toContain('configured `error`');
    expect(chinese).toContain('配置为 `error`');
    expect(comparison).not.toContain('fails only on high-confidence errors');
  });

  it('labels npm support and release artifacts as pre-release commitments', () => {
    const security = read('SECURITY.md');
    const maintainers = read('MAINTAINERS.md');
    const changelog = read('CHANGELOG.md');
    const releaseManifest = JSON.parse(read('.release-please-manifest.json')) as Record<
      string,
      string
    >;

    expect(security).toContain('No npm release has been published yet');
    expect(maintainers).toContain('After the first release');
    if (releaseManifest['.'] === '0.0.0') {
      expect(changelog).toBe('');
    } else {
      expect(changelog).toMatch(/^# Changelog$/mu);
    }
    expect(changelog).not.toMatch(/^## \d+\.\d+\.\d+ \(Unreleased\)$/mu);
    expect(changelog).not.toMatch(/^## Changelog$/mu);
  });
});
