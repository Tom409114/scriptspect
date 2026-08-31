import { describe, expect, it } from 'vitest';
import { normalizeOptions } from '../../src/cli/options';

describe('CLI option normalization', () => {
  it('honors Cac normalized color=false for --no-color', () => {
    expect(normalizeOptions({ color: false }).color).toBe(false);
  });

  it('also accepts the direct noColor=true representation', () => {
    expect(normalizeOptions({ noColor: true }).color).toBe(false);
  });
});
