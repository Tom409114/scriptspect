/**
 * The ten negative cases from docs/architecture.md — the parser contract.
 * A parser change that breaks any of these cannot merge (spec §5.3).
 */
import { describe, expect, it } from 'vitest';
import type { CommandNode } from '../../src/parser/ir';
import { commandName, walkCommands } from '../../src/parser/ir';
import { parseScript } from '../../src/parser/parse';

function names(src: string): string[] {
  return [...walkCommands(parseScript(src).root)]
    .map(commandName)
    .filter((n): n is string => n !== null);
}

describe('parser contract (docs/architecture.md negative cases)', () => {
  it('echo "rm -rf dist" — never treats rm inside a string as a command', () => {
    expect(names('echo "rm -rf dist"')).toEqual(['echo']);
  });

  it('node -e "console.log(\'cp -r\')" — never scans inside string arguments', () => {
    expect(names('node -e "console.log(\'cp -r\')"')).toEqual(['node']);
  });

  it('cross-env NODE_ENV=production vite build — no env assignment at command head', () => {
    const [cmd] = [...walkCommands(parseScript('cross-env NODE_ENV=production vite build').root)];
    expect(cmd?.leadingEnv).toEqual([]);
    expect(commandName(cmd as CommandNode)).toBe('cross-env');
  });

  it('shx rm -rf dist — the command is shx, not rm', () => {
    expect(names('shx rm -rf dist')).toEqual(['shx']);
  });

  it('rimraf dist — the command is rimraf, not rm', () => {
    expect(names('rimraf dist')).toEqual(['rimraf']);
  });

  it('bash -c "rm -rf dist" — explicit bash dependency node, inner tokens not re-reported', () => {
    const all = [...walkCommands(parseScript('bash -c "rm -rf dist"').root)];
    expect(all).toHaveLength(1);
    expect(all[0]?.wrapper?.shell).toBe('bash');
    expect(commandName(all[0] as CommandNode)).toBe('bash');
  });

  it('echo foo && echo bar — && is legal on sh and cmd, two plain echo commands', () => {
    expect(names('echo foo && echo bar')).toEqual(['echo', 'echo']);
  });

  it('echo "a && b" — quoted operators never split', () => {
    const all = [...walkCommands(parseScript('echo "a && b"').root)];
    expect(all).toHaveLength(1);
    expect(all[0]?.argv).toHaveLength(2);
  });

  it('cmd /c "set FOO=bar&& node app.js" — recognized as explicit cmd wrapper', () => {
    const all = [...walkCommands(parseScript('cmd /c "set FOO=bar&& node app.js"').root)];
    expect(all).toHaveLength(1);
    expect(all[0]?.wrapper?.shell).toBe('cmd');
  });

  it('powershell -NoProfile -Command "$env:FOO=\'bar\'; node app.js" — explicit powershell wrapper', () => {
    const src = 'powershell -NoProfile -Command "$env:FOO=\'bar\'; node app.js"';
    const all = [...walkCommands(parseScript(src).root)];
    expect(all).toHaveLength(1);
    expect(all[0]?.wrapper?.shell).toBe('powershell');
  });
});
