import { describe, expect, it } from 'vitest';
import type {
  BooleanNode,
  CommandNode,
  GroupNode,
  PipelineNode,
  SequenceNode,
} from '../../src/parser/ir';
import { commandName, walkCommands } from '../../src/parser/ir';
import { parseScript } from '../../src/parser/parse';

function cmds(src: string): CommandNode[] {
  return [...walkCommands(parseScript(src).root)];
}

function names(src: string): (string | null)[] {
  return cmds(src).map(commandName);
}

describe('ir: commands', () => {
  it('parses a simple command with argv', () => {
    const [cmd] = cmds('vite build --mode=production');
    expect(cmd?.argv.map((t) => t.value)).toEqual(['vite', 'build', '--mode=production']);
    expect(cmd?.leadingEnv).toEqual([]);
  });

  it('extracts a single leading env assignment', () => {
    const [cmd] = cmds('FOO=bar vite build');
    expect(cmd?.leadingEnv).toEqual([{ name: 'FOO', value: 'bar', span: [0, 7] }]);
    expect(commandName(cmd as CommandNode)).toBe('vite');
  });

  it('extracts multiple leading env assignments', () => {
    const [cmd] = cmds('A=1 B=2 node x');
    expect(cmd?.leadingEnv.map((e) => e.name)).toEqual(['A', 'B']);
    expect(commandName(cmd as CommandNode)).toBe('node');
  });

  it('keeps an assignment-only command', () => {
    const [cmd] = cmds('FOO=bar');
    expect(cmd?.leadingEnv[0]?.name).toBe('FOO');
    expect(cmd?.argv).toEqual([]);
  });

  it('does not extract assignments after the command name', () => {
    const [cmd] = cmds('cross-env NODE_ENV=production vite build');
    expect(cmd?.leadingEnv).toEqual([]);
    expect(cmd?.argv.map((t) => t.value)).toEqual([
      'cross-env',
      'NODE_ENV=production',
      'vite',
      'build',
    ]);
  });

  it('parses the empty script into one empty command', () => {
    const all = cmds('');
    expect(all).toHaveLength(1);
    expect(all[0]?.argv).toEqual([]);
  });
});

describe('ir: sequences, booleans, pipelines', () => {
  it('splits on semicolons into a sequence', () => {
    const root = parseScript('a;b').root as SequenceNode;
    expect(root.kind).toBe('sequence');
    expect(root.ops).toEqual([';']);
    expect(root.parts).toHaveLength(2);
  });

  it('splits on newlines', () => {
    const root = parseScript('a\nb').root as SequenceNode;
    expect(root.kind).toBe('sequence');
    expect(root.ops).toEqual(['\n']);
  });

  it('splits on single &', () => {
    const root = parseScript('a & b').root as SequenceNode;
    expect(root.kind).toBe('sequence');
    expect(root.ops).toEqual(['&']);
  });

  it('chains && into a boolean node', () => {
    const root = parseScript('a && b').root as BooleanNode;
    expect(root.kind).toBe('boolean');
    expect(root.ops).toEqual(['&&']);
    expect(root.opSpans).toEqual([[2, 4]]);
    expect(names('a && b')).toEqual(['a', 'b']);
  });

  it('chains || into a boolean node', () => {
    expect((parseScript('a || b').root as BooleanNode).ops).toEqual(['||']);
  });

  it('gives ; lower precedence than &&', () => {
    const root = parseScript('a && b; c').root as SequenceNode;
    expect(root.kind).toBe('sequence');
    const first = root.parts[0] as BooleanNode;
    expect(first.kind).toBe('boolean');
    expect(names('a && b; c')).toEqual(['a', 'b', 'c']);
  });

  it('parses pipelines', () => {
    const root = parseScript('cat x | grep y | wc -l').root as PipelineNode;
    expect(root.kind).toBe('pipeline');
    expect(root.parts).toHaveLength(3);
    expect(root.opSpans).toEqual([
      [6, 7],
      [15, 16],
    ]);
  });

  it('parses parenthesized groups', () => {
    const root = parseScript('(a && b) || c').root as BooleanNode;
    expect(root.kind).toBe('boolean');
    const group = root.parts[0] as GroupNode;
    expect(group.kind).toBe('group');
    expect((group.body as BooleanNode).kind).toBe('boolean');
    expect(names('(a && b) || c')).toEqual(['a', 'b', 'c']);
  });
});

describe('ir: redirections', () => {
  it('attaches stdout redirection with target', () => {
    const [cmd] = cmds('node x > out.txt');
    expect(cmd?.redirects[0]).toMatchObject({
      op: '>',
      target: expect.objectContaining({ value: 'out.txt' }),
    });
  });

  it('attaches stderr redirection', () => {
    const [cmd] = cmds('node x 2> err.txt');
    expect(cmd?.redirects[0]?.op).toBe('2>');
  });

  it('attaches multiple redirections', () => {
    const [cmd] = cmds('node x > out 2>&1');
    expect(cmd?.redirects.map((r) => r.op)).toEqual(['>', '2>&1']);
  });

  it('keeps redirections off argv', () => {
    const [cmd] = cmds('node x > out.txt');
    expect(cmd?.argv.map((t) => t.value)).toEqual(['node', 'x']);
  });
});

describe('ir: shell wrappers', () => {
  it('wraps bash -c payloads', () => {
    const [cmd] = cmds('bash -c "rm -rf dist"');
    expect(cmd?.wrapper).toMatchObject({ shell: 'bash', raw: 'bash -c' });
    const inner = cmd?.wrapper?.inner;
    expect(inner).toBeDefined();
    expect(commandName([...(inner ? walkCommands(inner.root) : [])][0] as CommandNode)).toBe('rm');
  });

  it('wraps sh -c payloads as the sh family but not other shell executables', () => {
    const [zsh] = cmds('zsh -c "echo hi"');
    expect(zsh?.wrapper).toBeUndefined();
    const [sh] = cmds('sh -c "echo hi"');
    expect(sh?.wrapper?.shell).toBe('sh');
  });

  it('wraps cmd /c payloads', () => {
    const [cmd] = cmds('cmd /c "set FOO=bar&& node app.js"');
    expect(cmd?.wrapper?.shell).toBe('cmd');
  });

  it('wraps powershell -Command payloads', () => {
    const [cmd] = cmds(`powershell -NoProfile -Command "$env:FOO='bar'; node app.js"`);
    expect(cmd?.wrapper?.shell).toBe('powershell');
  });

  it('wraps pwsh as powershell', () => {
    const [cmd] = cmds('pwsh -Command "echo hi"');
    expect(cmd?.wrapper?.shell).toBe('powershell');
  });

  it('does not wrap bash without -c', () => {
    const [cmd] = cmds('bash build.sh');
    expect(cmd?.wrapper).toBeUndefined();
  });

  it('walkCommands never descends into wrapper payloads', () => {
    const all = cmds('bash -c "rm -rf dist"');
    expect(all).toHaveLength(1);
    expect(commandName(all[0] as CommandNode)).toBe('bash');
  });

  it('parses set FOO=bar&& without eating the && (cmd pattern)', () => {
    expect(names('set FOO=bar&& node app.js')).toEqual(['set', 'node']);
    const root = parseScript('set FOO=bar&& node app.js').root as BooleanNode;
    expect(root.kind).toBe('boolean');
  });
});

describe('ir: raw text and spans', () => {
  it('command raw includes env assignments and argv', () => {
    const [cmd] = cmds('FOO=bar vite build');
    expect(cmd?.raw).toBe('FOO=bar vite build');
  });

  it('spans cover the whole command', () => {
    const src = 'echo one && echo two';
    const all = cmds(src);
    expect(src.slice(all[0]?.span[0], all[0]?.span[1])).toBe('echo one');
    expect(src.slice(all[1]?.span[0], all[1]?.span[1])).toBe('echo two');
  });
});
