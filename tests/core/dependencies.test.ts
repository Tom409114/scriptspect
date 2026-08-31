import { describe, expect, it } from 'vitest';
import { dependencyNames } from '../../src/core/analyze';

describe('executable dependency availability', () => {
  it('uses dependencies and devDependencies as locally provable bin preconditions', () => {
    expect(
      dependencyNames({
        dependencies: { runtime: '1.0.0' },
        devDependencies: { development: '1.0.0' },
        optionalDependencies: { optional: '1.0.0' },
        peerDependencies: { peer: '1.0.0' },
      }),
    ).toEqual(new Set(['runtime', 'development']));
  });
});
