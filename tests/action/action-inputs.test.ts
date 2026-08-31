import { mkdirSync, mkdtempSync, realpathSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { ActionInputError, parseActionInputs } from '../../src/action-inputs';

let workspace: string;

beforeEach(() => {
  workspace = realpathSync(mkdtempSync(join(tmpdir(), 'ss-action-inputs-')));
  mkdirSync(join(workspace, 'nested'));
});

afterEach(() => {
  rmSync(workspace, { recursive: true, force: true });
});

describe('Action inputs', () => {
  it('resolves a nested project path within GITHUB_WORKSPACE and validates options', () => {
    expect(
      parseActionInputs({
        GITHUB_WORKSPACE: workspace,
        INPUT_PATH: 'nested',
        INPUT_TARGET: 'posix-sh,cmd',
        INPUT_SEVERITY: 'warn',
        'INPUT_MAX-WARNINGS': '2',
      }),
    ).toMatchObject({
      path: join(workspace, 'nested'),
      targets: ['posix-sh', 'cmd'],
      severity: 'warn',
      maxWarnings: 2,
    });
  });

  it('rejects a path escaping GITHUB_WORKSPACE without echoing its raw value', () => {
    const rawPath = '..\\outside-secret';
    expect(() => parseActionInputs({ GITHUB_WORKSPACE: workspace, INPUT_PATH: rawPath })).toThrow(
      ActionInputError,
    );
    try {
      parseActionInputs({ GITHUB_WORKSPACE: workspace, INPUT_PATH: rawPath });
    } catch (error) {
      expect(String(error)).not.toContain(rawPath);
    }
  });

  it('rejects a file path instead of silently analyzing its parent directory', () => {
    writeFileSync(join(workspace, 'nested', 'not-a-project'), 'data');

    expect(() =>
      parseActionInputs({ GITHUB_WORKSPACE: workspace, INPUT_PATH: 'nested/not-a-project' }),
    ).toThrow(ActionInputError);
  });

  it.each([
    ['INPUT_TARGET', 'fish'],
    ['INPUT_SEVERITY', 'fatal'],
    ['INPUT_MAX-WARNINGS', '1.5'],
  ])('rejects invalid %s without echoing the raw value', (key, value) => {
    expect(() => parseActionInputs({ GITHUB_WORKSPACE: workspace, [key]: value })).toThrow(
      ActionInputError,
    );
    try {
      parseActionInputs({ GITHUB_WORKSPACE: workspace, [key]: value });
    } catch (error) {
      expect(String(error)).not.toContain(value);
    }
  });
});
