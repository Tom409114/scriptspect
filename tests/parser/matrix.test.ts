import { describe, expect, it } from 'vitest';
import type { CommandNode, ShellTarget } from '../../src/parser/ir';
import { walkCommands } from '../../src/parser/ir';
import { parseForTarget, parseMatrix, requiredEvidenceTargets } from '../../src/parser/parse';

function commands(source: string, target: ShellTarget): CommandNode[] {
  return [...walkCommands(parseForTarget(source, target).root)];
}

function commandNames(source: string, target: ShellTarget): string[] {
  return commands(source, target)
    .map((command) => command.argv[0]?.value)
    .filter((name): name is string => name !== undefined);
}

describe('parser matrix evidence targets', () => {
  it('always includes POSIX and cmd evidence without marking them active', () => {
    const matrix = parseMatrix('echo ok', new Set<ShellTarget>(['cmd']), new Set());

    expect([...matrix.activeTargets]).toEqual(['cmd']);
    expect([...matrix.byTarget.keys()]).toEqual(['posix-sh', 'cmd']);
  });

  it('adds PowerShell for an active target or a PowerShell-origin rule', () => {
    expect([...requiredEvidenceTargets(new Set<ShellTarget>(['powershell']), new Set())]).toEqual([
      'posix-sh',
      'cmd',
      'powershell',
    ]);
    expect([...requiredEvidenceTargets(new Set<ShellTarget>(['cmd']), new Set(['PS003']))]).toEqual(
      ['posix-sh', 'cmd', 'powershell'],
    );
    expect([...requiredEvidenceTargets(new Set<ShellTarget>(['cmd']), new Set(['PS032']))]).toEqual(
      ['posix-sh', 'cmd', 'powershell'],
    );
  });
});

describe('target-local dialect parsing', () => {
  it('treats single quotes as grouping only in POSIX sh', () => {
    const source = "echo 'left & right'";

    expect(commandNames(source, 'posix-sh')).toEqual(['echo']);
    expect(commands(source, 'posix-sh')[0]?.argv.map((token) => token.value)).toEqual([
      'echo',
      'left & right',
    ]);
    expect(commandNames(source, 'cmd')).toEqual(['echo', "right'"]);
  });

  it('treats backslash ampersand as escaped only in POSIX sh', () => {
    const source = 'echo left \\& echo right';

    expect(commandNames(source, 'posix-sh')).toEqual(['echo']);
    expect(commandNames(source, 'cmd')).toEqual(['echo', 'echo']);
  });

  it('treats caret ampersand as escaped only in cmd', () => {
    const source = 'echo left ^& echo right';

    expect(commandNames(source, 'posix-sh')).toEqual(['echo', 'echo']);
    expect(commandNames(source, 'cmd')).toEqual(['echo']);
  });

  it('recognizes percent expansion inside single quotes only in cmd', () => {
    const source = "echo '%TEMP%'";

    expect(commands(source, 'posix-sh')[0]?.argv[1]?.expansions).toEqual([]);
    expect(commands(source, 'cmd')[0]?.argv[1]?.expansions).toEqual([
      { kind: 'cmdvar', raw: '%TEMP%', span: [6, 12] },
    ]);
  });

  it('treats backslash redirection as escaped only in POSIX sh', () => {
    const source = 'echo hi \\> out';

    expect(commands(source, 'posix-sh')[0]?.redirects).toEqual([]);
    expect(commands(source, 'posix-sh')[0]?.argv.map((token) => token.value)).toEqual([
      'echo',
      'hi',
      '>',
      'out',
    ]);
    expect(commands(source, 'cmd')[0]?.redirects.map((redirect) => redirect.op)).toEqual(['>']);
  });

  it('treats caret redirection as escaped only in cmd', () => {
    const source = 'echo hi ^> out';

    expect(commands(source, 'posix-sh')[0]?.redirects.map((redirect) => redirect.op)).toEqual([
      '>',
    ]);
    expect(commands(source, 'cmd')[0]?.redirects).toEqual([]);
    expect(commands(source, 'cmd')[0]?.argv.map((token) => token.value)).toEqual([
      'echo',
      'hi',
      '>',
      'out',
    ]);
  });

  it('reports an unterminated single quote only for POSIX sh', () => {
    const source = "echo 'oops";

    expect(parseForTarget(source, 'posix-sh').diagnostics).toEqual([
      {
        code: 'unterminated-quote',
        message: 'Unterminated single quote',
        span: [5, 10],
        severity: 'error',
      },
    ]);
    expect(parseForTarget(source, 'cmd').diagnostics).toEqual([]);
  });

  it('reports an unterminated double quote in each dialect that groups with it', () => {
    const source = 'echo "oops';

    for (const target of ['posix-sh', 'powershell'] as const) {
      expect(parseForTarget(source, target).diagnostics).toContainEqual({
        code: 'unterminated-quote',
        message: 'Unterminated double quote',
        span: [5, 10],
        severity: 'error',
      });
    }
    expect(parseForTarget(source, 'cmd').diagnostics).toEqual([]);
  });

  it('classifies leading NAME=value words only for POSIX sh', () => {
    const source = 'NODE_ENV=production vite build';

    expect(commands(source, 'posix-sh')[0]?.leadingEnv).toHaveLength(1);
    expect(commands(source, 'cmd')[0]?.leadingEnv).toEqual([]);
    expect(commands(source, 'cmd')[0]?.argv[0]?.value).toBe('NODE_ENV=production');
    expect(commands(source, 'powershell')[0]?.leadingEnv).toEqual([]);
  });

  it('diagnoses trailing boolean and pipeline operators at their exact spans', () => {
    expect(parseForTarget('echo ok &&', 'posix-sh').diagnostics).toContainEqual({
      code: 'missing-command',
      message: 'Missing command after `&&`',
      span: [8, 10],
      severity: 'error',
    });
    expect(parseForTarget('echo ok |', 'cmd').diagnostics).toContainEqual({
      code: 'missing-command',
      message: 'Missing command after `|`',
      span: [8, 9],
      severity: 'error',
    });
  });

  it.each([
    ['&& echo', [0, 2], '&&'],
    ['| echo', [0, 1], '|'],
    ['echo && || next', [8, 10], '||'],
    ['echo | | next', [7, 8], '|'],
  ] as const)('diagnoses a missing command before %s', (source, span, operator) => {
    expect(parseForTarget(source, 'posix-sh').diagnostics).toContainEqual({
      code: 'missing-command',
      message: `Missing command before \`${operator}\``,
      span: [...span],
      severity: 'error',
    });
  });

  it('diagnoses redirections without an operand', () => {
    expect(parseForTarget('echo ok >', 'posix-sh').diagnostics).toContainEqual({
      code: 'missing-redirection-target',
      message: 'Missing operand after redirection `>`',
      span: [8, 9],
      severity: 'error',
    });
  });

  it('diagnoses unterminated POSIX expansions', () => {
    expect(parseForTarget('echo $(date', 'posix-sh').diagnostics).toContainEqual({
      code: 'unterminated-expansion',
      message: 'Unterminated command substitution',
      span: [5, 11],
      severity: 'error',
    });
    expect(parseForTarget('echo ${HOME', 'posix-sh').diagnostics).toContainEqual({
      code: 'unterminated-expansion',
      message: 'Unterminated parameter expansion',
      span: [5, 11],
      severity: 'error',
    });
  });

  it('treats an unterminated PowerShell expansion as deterministic syntax failure', () => {
    expect(parseForTarget('echo $(date', 'powershell').diagnostics).toContainEqual({
      code: 'unterminated-expansion',
      message: 'Unterminated command substitution',
      span: [5, 11],
      severity: 'error',
    });
  });

  it('marks PowerShell constructs outside the supported lexical subset as advisory', () => {
    expect(parseForTarget('echo $HOME', 'powershell').diagnostics).toContainEqual({
      code: 'unsupported-subset',
      message: 'PowerShell variable syntax is outside the supported analyzer subset',
      span: [5, 10],
      severity: 'advisory',
    });
    expect(parseForTarget('echo ok && echo next', 'powershell').diagnostics).toContainEqual({
      code: 'unsupported-subset',
      message: 'PowerShell operator `&&` is outside the supported analyzer subset',
      span: [8, 10],
      severity: 'advisory',
    });
  });

  it.each([
    ['Write-Output (Get-Date)', [13, 23]],
    ['@(1,2)|Out-Null', [0, 6]],
    ['# comment; rm x', [0, 15]],
  ] as const)('advises on unsupported PowerShell syntax in %s', (source, span) => {
    expect(parseForTarget(source, 'powershell').diagnostics).toContainEqual({
      code: 'unsupported-subset',
      message: expect.stringContaining('PowerShell'),
      span: [...span],
      severity: 'advisory',
    });
  });

  it('does not turn a PowerShell comment body into generic commands', () => {
    expect(commandNames('# comment; rm x', 'powershell')).toEqual([]);
  });

  it('reports the smallest span for each unbalanced group delimiter', () => {
    expect(parseForTarget('(echo ok', 'posix-sh').diagnostics).toContainEqual({
      code: 'unbalanced-group',
      message: 'Unbalanced opening group delimiter',
      span: [0, 1],
      severity: 'error',
    });
    expect(parseForTarget('echo ok)', 'cmd').diagnostics).toContainEqual({
      code: 'unbalanced-group',
      message: 'Unbalanced closing group delimiter',
      span: [7, 8],
      severity: 'error',
    });
  });

  it('keeps diagnostics from evidence-only parses out of the active target set', () => {
    const matrix = parseMatrix("echo 'oops", new Set<ShellTarget>(['cmd']), new Set());

    expect(matrix.byTarget.get('posix-sh')?.diagnostics).toHaveLength(1);
    expect(matrix.byTarget.get('cmd')?.diagnostics).toEqual([]);
    expect([...matrix.activeTargets]).toEqual(['cmd']);
  });
});

describe('wrapper payload source mapping', () => {
  it.each([
    ['bash script.sh -c "echo no"', 'posix-sh'],
    ['cmd script.cmd /c echo no', 'cmd'],
    ['pwsh script.ps1 -Command "echo no"', 'powershell'],
  ] as const)('does not recognize a misplaced execution flag in %s', (source, target) => {
    const [command] = commands(source, target);

    expect(command?.wrapper).toBeUndefined();
  });

  it('allows literal wrapper options before a correctly positioned execution flag', () => {
    const [bash] = commands('bash --noprofile -c "echo yes"', 'posix-sh');
    const [powershell] = commands('pwsh -NoProfile -Command "echo yes"', 'powershell');

    expect(bash?.wrapper?.payloadRaw).toBe('echo yes');
    expect(powershell?.wrapper?.payloadRaw).toBe('echo yes');
  });

  it('maps a supported sh -c payload to an exact top-level source slice', () => {
    const source = 'bash -c "echo one && echo two" positional';
    const [command] = commands(source, 'posix-sh');
    const wrapper = command?.wrapper;

    expect(wrapper).toMatchObject({
      shell: 'bash',
      payloadTarget: 'posix-sh',
      payloadSupport: 'supported',
    });
    expect(wrapper?.payloadSourceSpan).toEqual([9, 29]);
    expect(wrapper?.payloadRaw).toBe(source.slice(9, 29));
    const inner = wrapper?.inner;
    expect(
      inner === null || inner === undefined
        ? []
        : [...walkCommands(inner.root)].map((innerCommand) => ({
            name: innerCommand.argv[0]?.value,
            raw: source.slice(innerCommand.span[0], innerCommand.span[1]),
          })),
    ).toEqual([
      { name: 'echo', raw: 'echo one' },
      { name: 'echo', raw: 'echo two' },
    ]);
  });

  it('limits a cmd /c payload to the same outer command node', () => {
    const source = 'cmd /c echo one & echo outer';
    const [command] = commands(source, 'cmd');

    expect(command?.wrapper).toMatchObject({
      shell: 'cmd',
      payloadTarget: 'cmd',
      payloadSupport: 'supported',
      payloadSourceSpan: [7, 15],
      payloadRaw: 'echo one',
    });
  });

  it('uses only the immediate argument as an unquoted sh -c payload', () => {
    const source = 'sh -c echo positional arguments';
    const [command] = commands(source, 'posix-sh');

    expect(command?.wrapper).toMatchObject({
      shell: 'sh',
      payloadTarget: 'posix-sh',
      payloadSupport: 'supported',
      payloadSourceSpan: [6, 10],
      payloadRaw: 'echo',
    });
  });

  it('accepts case-insensitive cmd /C and excludes outer redirections', () => {
    const source = 'cmd /C echo one > outer.log';
    const [command] = commands(source, 'cmd');

    expect(command?.redirects[0]).toMatchObject({ op: '>', target: { value: 'outer.log' } });
    expect(command?.wrapper).toMatchObject({
      shell: 'cmd',
      payloadTarget: 'cmd',
      payloadSupport: 'supported',
      payloadSourceSpan: [7, 15],
      payloadRaw: 'echo one',
    });
  });

  it('maps a PowerShell -Command payload and adds its origin evidence parse', () => {
    const source = 'pwsh -Command "echo one; echo two"';
    const matrix = parseMatrix(source, new Set<ShellTarget>(['cmd']), new Set());
    const [command] = [
      ...walkCommands(matrix.byTarget.get('cmd')?.root ?? parseForTarget('', 'cmd').root),
    ];

    expect([...matrix.byTarget.keys()]).toEqual(['posix-sh', 'cmd', 'powershell']);
    expect(command?.wrapper).toMatchObject({
      shell: 'powershell',
      payloadTarget: 'powershell',
      payloadSupport: 'supported',
      payloadSourceSpan: [15, 33],
      payloadRaw: 'echo one; echo two',
    });
  });

  it('rejects escaped cmd operators because delivered bytes are transformed', () => {
    const parsed = parseForTarget('cmd /c echo one ^& echo two', 'cmd');
    const [command] = [...walkCommands(parsed.root)];

    expect(command?.wrapper?.payloadSupport).toBe('unsupported-wrapper-boundary');
    expect(parsed.diagnostics.map((diagnostic) => diagnostic.code)).toContain(
      'unsupported-wrapper-boundary',
    );
  });

  it('rejects concatenated quoted and unquoted sh payload segments', () => {
    const parsed = parseForTarget('bash -c pre"echo hi"', 'posix-sh');
    const [command] = [...walkCommands(parsed.root)];

    expect(command?.wrapper?.payloadSupport).toBe('unsupported-wrapper-boundary');
    expect(command?.wrapper?.inner).toBeNull();
  });

  it.each([
    ['cmd.exe /c echo   one', 'cmd', 'cmd', 'echo   one'],
    ['powershell --command "echo hi"', 'cmd', 'powershell', 'echo hi'],
    ['powershell.exe -Command "echo hi"', 'cmd', 'powershell', 'echo hi'],
    ['pwsh -c "echo hi"', 'cmd', 'powershell', 'echo hi'],
  ] as const)(
    'recognizes literal wrapper and flag variants in %s',
    (source, outerTarget, payloadTarget, payloadRaw) => {
      const [command] = commands(source, outerTarget);

      expect(command?.wrapper).toMatchObject({
        payloadTarget,
        payloadSupport: 'supported',
        payloadRaw,
      });
      const payloadSpan = command?.wrapper?.payloadSourceSpan;
      expect(
        payloadSpan === null || payloadSpan === undefined ? null : source.slice(...payloadSpan),
      ).toBe(payloadRaw);
    },
  );

  it('keeps an outer redirection out of a quoted bash payload', () => {
    const source = 'bash -c "echo hi" > outer.log';
    const [command] = commands(source, 'posix-sh');

    expect(command?.wrapper).toMatchObject({
      payloadRaw: 'echo hi',
      payloadSourceSpan: [9, 16],
      payloadSupport: 'supported',
    });
    expect(command?.redirects[0]?.target?.value).toBe('outer.log');
  });

  it.each([
    ['bash -c', 'posix-sh', [5, 7]],
    ['cmd /c', 'cmd', [4, 6]],
    ['pwsh -Command', 'cmd', [5, 13]],
  ] as const)('diagnoses a missing wrapper payload in %s', (source, target, span) => {
    expect(parseForTarget(source, target).diagnostics).toContainEqual({
      code: 'missing-wrapper-payload',
      message: 'Wrapper execution flag requires a payload',
      span: [...span],
      severity: 'error',
    });
  });

  it('gates a payload whose outer quoting transforms delivered bytes', () => {
    const source = 'bash -c "echo \\$HOME"';
    const parsed = parseForTarget(source, 'posix-sh');
    const [command] = [...walkCommands(parsed.root)];

    expect(command?.wrapper).toMatchObject({
      shell: 'bash',
      payloadTarget: 'posix-sh',
      payloadSupport: 'unsupported-wrapper-boundary',
      payloadSourceSpan: null,
      payloadRaw: null,
      inner: null,
    });
    expect(parsed.diagnostics).toContainEqual({
      code: 'unsupported-wrapper-boundary',
      message: 'Wrapper payload cannot be mapped to an exact source slice',
      span: [8, 21],
      severity: 'advisory',
    });
  });
});
