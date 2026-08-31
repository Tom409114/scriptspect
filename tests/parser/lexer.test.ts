import { describe, expect, it } from 'vitest';
import type { Token } from '../../src/parser/lexer';
import { tokenize } from '../../src/parser/lexer';

function words(src: string): string[] {
  return tokenize(src).map((t) => t.value);
}

function wordTokens(src: string): Token[] {
  return tokenize(src).filter((t) => t.kind === 'word');
}

function ops(src: string): string[] {
  return tokenize(src)
    .filter((t) => t.kind === 'operator')
    .map((t) => t.op ?? '');
}

describe('lexer: words and separators', () => {
  it('splits plain words', () => {
    expect(words('echo hello')).toEqual(['echo', 'hello']);
  });

  it('treats tabs and carriage returns as separators', () => {
    expect(words('a\tb\rc')).toEqual(['a', 'b', 'c']);
  });

  it('returns no tokens for empty and blank input', () => {
    expect(tokenize('')).toEqual([]);
    expect(tokenize('   \t ')).toEqual([]);
  });

  it('keeps flags and paths as single tokens', () => {
    expect(words('vite build --mode=production')).toEqual(['vite', 'build', '--mode=production']);
    expect(words('node ./src/cli.ts')).toEqual(['node', './src/cli.ts']);
  });

  it('keeps colon-separated paths together', () => {
    expect(words('NODE_PATH=./src:./lib node x')).toEqual(['NODE_PATH=./src:./lib', 'node', 'x']);
  });
});

describe('lexer: quotes', () => {
  it('keeps double-quoted content as one token without the quotes', () => {
    const toks = tokenize('echo "rm -rf dist"');
    expect(toks[1]?.value).toBe('rm -rf dist');
    expect(toks[1]?.quote).toBe('"');
    expect(toks[1]?.raw).toBe('"rm -rf dist"');
  });

  it('keeps single-quoted content as one token', () => {
    const toks = tokenize("echo 'a b c'");
    expect(toks[1]?.value).toBe('a b c');
    expect(toks[1]?.quote).toBe("'");
  });

  it('merges adjacent quoted and unquoted segments into one token', () => {
    const toks = tokenize('a"b c"d');
    expect(toks).toHaveLength(1);
    expect(toks[0]?.value).toBe('ab cd');
    expect(toks[0]?.quote).toBe('"');
  });

  it('does not treat single quotes as quoting inside double quotes', () => {
    const toks = tokenize('node -e "console.log(\'cp -r\')"');
    expect(toks).toHaveLength(3);
    expect(toks[2]?.quote).toBe('"');
    expect(toks[2]?.value).toBe("console.log('cp -r')");
  });

  it('resolves escaped double quotes inside double quotes', () => {
    const toks = tokenize('echo "a\\"b"');
    expect(toks[1]?.value).toBe('a"b');
  });

  it('keeps backslashes literal inside double quotes for non-special chars (Windows paths)', () => {
    const toks = tokenize('echo "C:\\Program Files\\node"');
    expect(toks[1]?.value).toBe('C:\\Program Files\\node');
  });

  it('consumes unterminated quotes to end of input without throwing', () => {
    const toks = tokenize('echo "abc');
    expect(toks[1]?.value).toBe('abc');
  });

  it('does not expand anything inside single quotes', () => {
    const toks = tokenize("echo '$USER' x");
    expect(toks[1]?.expansions).toEqual([]);
  });
});

describe('lexer: escapes', () => {
  it('resolves backslash escapes outside quotes', () => {
    expect(words('echo a\\ b')).toEqual(['echo', 'a b']);
  });

  it('escapes an unquoted ampersand so it stays part of a word', () => {
    expect(words('echo \\&')).toEqual(['echo', '&']);
    expect(ops('echo \\&')).toEqual([]);
  });

  it('treats cmd caret escapes for shell-special characters', () => {
    expect(words('echo ^&')).toEqual(['echo', '&']);
    expect(words('echo ^|')).toEqual(['echo', '|']);
  });

  it('keeps a caret literal before ordinary characters', () => {
    expect(words('echo a^b')).toEqual(['echo', 'a^b']);
  });

  it('keeps a trailing lone backslash as a literal character', () => {
    expect(words('echo x\\')).toEqual(['echo', 'x\\']);
  });
});

describe('lexer: operators', () => {
  it('recognizes && and ||', () => {
    expect(ops('a && b || c')).toEqual(['&&', '||']);
  });

  it('recognizes single &, ; and pipes', () => {
    expect(ops('a & b ; c | d')).toEqual(['&', ';', '|']);
  });

  it('recognizes newline as a sequence operator', () => {
    expect(ops('a\nb')).toEqual(['\n']);
  });

  it('recognizes parens as their own token kinds', () => {
    const toks = tokenize('(a) && (b)');
    expect(toks[0]?.kind).toBe('lparen');
    expect(toks[2]?.kind).toBe('rparen');
  });

  it('does not split quoted operators', () => {
    expect(tokenize('echo "a && b"')).toHaveLength(2);
    expect(ops('echo "a && b"')).toEqual([]);
  });

  it('recognizes redirections with targets', () => {
    const toks = tokenize('node x > out.txt');
    expect(toks[2]?.kind).toBe('operator');
    expect(toks[2]?.op).toBe('>');
    expect(toks[3]?.value).toBe('out.txt');
  });

  it('recognizes append redirection', () => {
    expect(ops('x >> log')).toEqual(['>>']);
  });

  it('recognizes stdin redirection', () => {
    expect(ops('x < in.txt')).toEqual(['<']);
  });

  it('folds a leading fd digit into the redirect operator (2>)', () => {
    const toks = tokenize('x 2> err.txt');
    expect(toks[1]?.op).toBe('2>');
    expect(toks[2]?.value).toBe('err.txt');
  });

  it('folds 2>&1 into a single operator', () => {
    const toks = tokenize('x 2>&1');
    expect(toks[1]?.op).toBe('2>&1');
    expect(toks).toHaveLength(2);
  });

  it('recognizes 2>> append-to-stderr', () => {
    expect(ops('x 2>> log')).toEqual(['2>>']);
  });
});

describe('lexer: expansions', () => {
  it('detects $VAR', () => {
    const toks = wordTokens('echo $HOME');
    expect(toks[1]?.expansions[0]).toMatchObject({ kind: 'var', raw: '$HOME' });
  });

  it('detects braced variables with defaults', () => {
    const expansion = '$' + '{HOME:-/tmp}';
    const toks = wordTokens(`echo ${expansion}`);
    expect(toks[1]?.expansions[0]).toMatchObject({ kind: 'braced', raw: expansion });
  });

  it('detects $(command) substitution', () => {
    const toks = wordTokens('echo $(pwd)');
    expect(toks[1]?.expansions[0]).toMatchObject({ kind: 'command', raw: '$(pwd)' });
  });

  it('handles nested command substitution as one expansion', () => {
    const toks = wordTokens('echo $(dirname $(pwd))');
    expect(toks[1]?.expansions).toHaveLength(1);
    expect(toks[1]?.expansions[0]?.raw).toBe('$(dirname $(pwd))');
  });

  it('detects special parameters like $?', () => {
    const toks = wordTokens('echo $?');
    expect(toks[1]?.expansions[0]?.kind).toBe('special');
  });

  it('keeps a lone $ literal', () => {
    const toks = wordTokens('echo $ x');
    expect(toks[1]?.value).toBe('$');
    expect(toks[1]?.expansions).toEqual([]);
  });

  it('expands inside double quotes', () => {
    const toks = wordTokens('echo "pre $USER post"');
    expect(toks[1]?.expansions[0]).toMatchObject({ kind: 'var', raw: '$USER' });
  });

  it('detects %VAR% outside quotes', () => {
    const toks = wordTokens('echo %PATH%');
    expect(toks[1]?.expansions[0]).toMatchObject({ kind: 'cmdvar', raw: '%PATH%' });
  });

  it('detects %VAR% inside double quotes', () => {
    const toks = wordTokens('echo "%APPDATA%\\x"');
    expect(toks[1]?.expansions[0]?.kind).toBe('cmdvar');
  });

  it('does not treat date format specifiers as %VAR% (no closing percent)', () => {
    const toks = wordTokens('date +%Y-%m-%d');
    expect(toks[1]?.expansions).toEqual([]);
  });

  it('does not treat printf format strings as %VAR%', () => {
    const toks = tokenize("printf '%s\\n' hello");
    expect(toks[1]?.expansions).toEqual([]);
  });
});

describe('lexer: spans', () => {
  it('spans point at the exact source slice', () => {
    const src = 'echo "rm -rf dist"';
    const toks = tokenize(src);
    expect(src.slice(toks[1]?.span[0] ?? -1, toks[1]?.span[1] ?? -1)).toBe('"rm -rf dist"');
  });

  it('spans skip leading whitespace', () => {
    const toks = tokenize('   node x');
    expect(toks[0]?.span).toEqual([3, 7]);
  });
});
