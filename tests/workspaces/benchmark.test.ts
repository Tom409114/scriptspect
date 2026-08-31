import { describe, expect, it } from 'vitest';
import { runWorkspaceBenchmark } from '../../tools/benchmark-workspace';

const SHA = '0123456789abcdef0123456789abcdef01234567';

describe('hosted workspace benchmark contract', () => {
  it('records a reproducible 100-package-compatible benchmark payload', () => {
    const result = runWorkspaceBenchmark({
      packageCount: 3,
      thresholdMs: 2_000,
      sourceCommit: SHA,
    });

    expect(result).toMatchObject({
      schemaVersion: 1,
      sourceCommit: SHA,
      packageCountRequested: 3,
      packagesScanned: 4,
      scriptsScanned: 7,
      thresholdMs: 2_000,
      passed: true,
    });
    expect(result.elapsedMs).toBeGreaterThanOrEqual(0);
    expect(result.environment.node).toBe(process.version);
  });

  it('rejects mutable source identifiers and invalid benchmark sizes', () => {
    expect(() =>
      runWorkspaceBenchmark({ packageCount: 100, thresholdMs: 2_000, sourceCommit: 'main' }),
    ).toThrow(/source commit/);
    expect(() =>
      runWorkspaceBenchmark({ packageCount: 0, thresholdMs: 2_000, sourceCommit: SHA }),
    ).toThrow(/package count/);
  });
});
