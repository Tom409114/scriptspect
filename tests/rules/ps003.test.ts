import { describe, expect, it } from 'vitest';
import { only, run } from './helpers';

describe('PS003 POWERSHELL_ENV', () => {
  it('positive: bare $env: assignment in npm scripts', () => {
    expect(only(run("$env:NODE_ENV='production'; node app.js"), 'PS003')).toHaveLength(1);
  });

  it('positive: $env:PATH mutation', () => {
    expect(only(run("$env:PATH='whatever'; npm test"), 'PS003')).toHaveLength(1);
  });

  it('positive: $env: inside a chained command', () => {
    expect(only(run("node a.js && $env:X='1'; node b.js"), 'PS003')).toHaveLength(1);
  });

  it('negative: inside an explicit powershell wrapper (PS032 owns it)', () => {
    const findings = only(run('powershell -Command "$env:FOO=\'bar\'; node app.js"'), 'PS003');
    expect(findings).toEqual([]);
  });

  it('negative: ordinary node env usage', () => {
    expect(only(run('node -e "console.log(process.env.HOME)"'), 'PS003')).toEqual([]);
  });

  it('negative: plain $VAR is PS023 territory, not PS003', () => {
    expect(only(run('echo $HOME'), 'PS003')).toEqual([]);
  });
});
