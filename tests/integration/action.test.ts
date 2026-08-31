import { mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { parse } from 'yaml';
import { runAction } from '../../src/action';
import { type ActionIo, createActionIo } from '../../src/action-output';

const root = join(dirname(fileURLToPath(import.meta.url)), '..', '..');
let workspace: string;

beforeEach(() => {
  workspace = mkdtempSync(join(tmpdir(), 'ss-action-'));
});

afterEach(() => {
  rmSync(workspace, { recursive: true, force: true });
});

function writeProject(scripts: Record<string, string>): void {
  writeFileSync(join(workspace, 'package.json'), JSON.stringify({ name: 'fixture', scripts }));
}

function actionEnvironment(extra: Record<string, string> = {}): NodeJS.ProcessEnv {
  return { GITHUB_WORKSPACE: workspace, ...extra };
}

function recordingIo(events: string[], values: Map<string, number> = new Map()): ActionIo {
  return {
    annotation: () => events.push('annotation'),
    output: (name, value) => {
      events.push(`output:${name}`);
      values.set(name, value);
    },
    summary: (markdown) => {
      events.push('summary');
      values.set('summary-warnings', markdown.includes('| warnings | 1 |') ? 1 : 0);
      values.set(
        'summary-hidden-warning-note',
        markdown.includes('Hidden warnings still count toward the failure budget.') ? 1 : 0,
      );
    },
    fail: () => events.push('fail'),
  };
}

describe('GitHub Action runtime', () => {
  it('uses hidden warnings for failure without reporting them above the display threshold', () => {
    writeProject({ check: 'echo $HOME' });
    const events: string[] = [];
    const values = new Map<string, number>();

    const result = runAction(
      actionEnvironment({ INPUT_SEVERITY: 'error', 'INPUT_MAX-WARNINGS': '0' }),
      recordingIo(events, values),
    );

    expect(result.exitCode).toBe(1);
    expect(events).not.toContain('annotation');
    expect(values.get('warnings')).toBe(0);
    expect(values.get('summary-warnings')).toBe(0);
    expect(values.get('summary-hidden-warning-note')).toBe(1);
  });

  it('fails when config explicitly promotes a medium-confidence rule to error', () => {
    writeFileSync(
      join(workspace, 'package.json'),
      JSON.stringify({
        name: 'fixture',
        scripts: { check: 'echo $HOME' },
        scriptspect: { severity: { PS023: 'error' } },
      }),
    );

    const result = runAction(actionEnvironment(), recordingIo([]));

    expect(result.exitCode).toBe(1);
  });

  it('writes every fixed output and the summary before failing a broken project', () => {
    writeProject({ clean: 'rm -rf dist' });
    const events: string[] = [];

    const result = runAction(actionEnvironment(), recordingIo(events));

    expect(result.exitCode).toBe(1);
    expect(events).toContain('annotation');
    expect(events).toContain('summary');
    expect(events).toEqual(
      expect.arrayContaining([
        'output:exit-code',
        'output:packages',
        'output:scripts',
        'output:errors',
        'output:warnings',
        'output:advisories',
      ]),
    );
    expect(events.indexOf('summary')).toBeLessThan(events.indexOf('fail'));
    expect(
      events
        .filter((event) => event.startsWith('output:'))
        .every((event) => events.indexOf(event) < events.indexOf('fail')),
    ).toBe(true);
  });

  it('writes numeric workflow outputs to GITHUB_OUTPUT', () => {
    writeProject({ build: 'node build.js' });
    const outputFile = join(workspace, 'output');
    const summaryFile = join(workspace, 'summary');

    const result = runAction(
      actionEnvironment({ GITHUB_OUTPUT: outputFile, GITHUB_STEP_SUMMARY: summaryFile }),
    );

    expect(result.exitCode).toBe(0);
    expect(readFileSync(outputFile, 'utf8').trim().split('\n')).toEqual([
      'exit-code=0',
      'packages=1',
      'scripts=1',
      'errors=0',
      'warnings=0',
      'advisories=0',
    ]);
    expect(readFileSync(summaryFile, 'utf8')).toContain('## scriptspect');
  });

  it('turns a GITHUB_OUTPUT write failure into a tool error after preserving the summary', () => {
    writeProject({ build: 'node build.js' });
    const outputDirectory = join(workspace, 'output-directory');
    const summaryFile = join(workspace, 'summary');
    mkdirSync(outputDirectory);
    const env = actionEnvironment({
      GITHUB_OUTPUT: outputDirectory,
      GITHUB_STEP_SUMMARY: summaryFile,
    });
    const io = createActionIo(env);
    const events: string[] = [];

    const result = runAction(env, { ...io, fail: () => events.push('fail') });

    expect(result.exitCode).toBe(2);
    expect(events).toContain('fail');
    expect(readFileSync(summaryFile, 'utf8')).toContain('Scanned **1 script**');
  });
});

describe('GitHub Action metadata', () => {
  it('uses the bundled Node 24 entry and exposes no version input', () => {
    const action = parse(readFileSync(join(root, 'action.yml'), 'utf8')) as {
      inputs: Record<string, unknown>;
      outputs: Record<string, unknown>;
      runs: { using: string; main: string };
    };

    expect(action.runs).toEqual({ using: 'node24', main: 'dist/action.mjs' });
    expect(Object.keys(action.inputs)).toEqual(['path', 'target', 'severity', 'max-warnings']);
    expect(Object.keys(action.outputs)).toEqual([
      'exit-code',
      'packages',
      'scripts',
      'errors',
      'warnings',
      'advisories',
    ]);
  });
});
