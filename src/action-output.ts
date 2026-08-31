import { appendFileSync } from 'node:fs';

export const ACTION_OUTPUT_NAMES = [
  'exit-code',
  'packages',
  'scripts',
  'errors',
  'warnings',
  'advisories',
] as const;

export type ActionOutputName = (typeof ACTION_OUTPUT_NAMES)[number];

export interface ActionIo {
  annotation: (text: string) => void;
  output: (name: ActionOutputName, value: number) => void;
  summary: (markdown: string) => void;
  fail: () => void;
}

function appendOutput(file: string | undefined, text: string): void {
  if (file === undefined || file === '') return;
  try {
    appendFileSync(file, text);
  } catch {
    throw new Error('unable to write GITHUB_OUTPUT');
  }
}

function appendSummary(file: string | undefined, text: string): void {
  if (file === undefined || file === '') return;
  try {
    appendFileSync(file, text);
  } catch {
    // The job summary is best-effort; analysis and workflow outputs remain authoritative.
  }
}

/** Dependency-free equivalent of the small @actions/core surface this Action needs. */
export function createActionIo(env: NodeJS.ProcessEnv): ActionIo {
  return {
    annotation: (text) => {
      if (text !== '') process.stdout.write(`${text}\n`);
    },
    output: (name, value) => appendOutput(env.GITHUB_OUTPUT, `${name}=${value}\n`),
    summary: (markdown) => appendSummary(env.GITHUB_STEP_SUMMARY, `${markdown}\n`),
    fail: () => {
      process.stderr.write('::error::scriptspect action failed\n');
      process.exitCode = 1;
    },
  };
}
