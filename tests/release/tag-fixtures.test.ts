import { spawnSync } from 'node:child_process';
import { mkdtempSync, readFileSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { dirname, join, resolve } from 'node:path';
import { expect, it } from 'vitest';
import { parse } from 'yaml';

it('executes the immutable-tag fixture preparation with valid shell quoting', () => {
  const workflow = parse(readFileSync('.github/workflows/npm-publish.yml', 'utf8'));
  const step = workflow.jobs['verify-action-tag'].steps.find(
    (item: { name?: string }) => item.name === 'Prepare immutable-tag fixtures',
  );
  const directory = mkdtempSync(join(tmpdir(), 'scriptspect-tag-fixtures-'));
  const bash =
    process.platform === 'win32'
      ? resolve(
          dirname(
            spawnSync('where.exe', ['git'], { encoding: 'utf8' }).stdout.trim().split(/\r?\n/)[0] ??
              '',
          ),
          '../bin/bash.exe',
        )
      : 'bash';
  try {
    for (const args of [
      ['init'],
      [
        '-c',
        'user.name=Fixture',
        '-c',
        'user.email=fixture@example.invalid',
        'commit',
        '--allow-empty',
        '-m',
        'fixture',
      ],
    ]) {
      expect(spawnSync('git', args, { cwd: directory }).status).toBe(0);
    }
    const sha = spawnSync('git', ['rev-parse', 'HEAD'], {
      cwd: directory,
      encoding: 'utf8',
    }).stdout.trim();
    const result = spawnSync(bash, ['-c', step.run], {
      cwd: directory,
      encoding: 'utf8',
      env: { ...process.env, GITHUB_SHA: sha },
    });
    expect(result.status, result.stderr).toBe(0);
    expect(
      JSON.parse(readFileSync(join(directory, '.ci/release-clean/package.json'), 'utf8')).scripts
        .build,
    ).toBe('node --version');
    expect(
      JSON.parse(readFileSync(join(directory, '.ci/release-broken/package.json'), 'utf8')).scripts
        .clean,
    ).toBe('rm -rf dist');
  } finally {
    rmSync(directory, { recursive: true, force: true });
  }
});
