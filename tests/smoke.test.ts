import { describe, expect, it } from 'vitest';
import { version } from '../src/core/version';

describe('bootstrap smoke', () => {
  it('exposes a semver version', () => {
    expect(version).toMatch(/^\d+\.\d+\.\d+/);
  });
});
