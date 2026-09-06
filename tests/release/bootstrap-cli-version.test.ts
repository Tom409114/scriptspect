import { spawnSync } from 'node:child_process';
import { readFileSync } from 'node:fs';
import { dirname, resolve } from 'node:path';
import { expect, it } from 'vitest';

const workflow = readFileSync('.github/workflows/npm-bootstrap.yml', 'utf8');
const assertions = workflow.split('\n').filter((line) => line.includes('--version)" =='));
const version = JSON.parse(readFileSync('package.json', 'utf8')).version;
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

it('bootstrap version gates accept the real CLI banner and reject a different version', () => {
  expect(assertions).toHaveLength(3);
  for (const assertion of assertions) {
    const command = assertion.replace(
      '$INSTALL_ROOT/node_modules/scriptspect/dist/cli.mjs',
      '$CLI_PATH',
    );
    for (const [expectedVersion, expectedStatus] of [
      [version, 0],
      ['99.99.99-wrong', 1],
    ] as const) {
      const result = spawnSync(bash, ['-c', command], {
        encoding: 'utf8',
        env: {
          ...process.env,
          VERSION: expectedVersion,
          CLI_PATH: resolve('dist/cli.mjs').replaceAll('\\', '/'),
        },
      });
      expect(result.error).toBeUndefined();
      expect(result.status, result.stderr).toBe(expectedStatus);
    }
  }
});
