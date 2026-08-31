/**
 * Executable entry (bundled to dist/cli.mjs). Keeps side effects out of
 * cli/index.ts so tests can import runCli without triggering a run.
 */
import { runCli } from './cli/index';

const code = await runCli(process.argv.slice(2));
process.exitCode = code;
