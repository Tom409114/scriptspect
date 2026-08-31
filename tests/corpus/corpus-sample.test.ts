import { describe, expect, it } from 'vitest';
import { type SampleFinding, stratifiedSample } from '../../tools/corpus-lib';

function finding(
  findingId: string,
  ruleId: string,
  severity: SampleFinding['severity'] = 'warn',
  confidence: SampleFinding['confidence'] = 'high',
): SampleFinding {
  return { findingId, ruleId, severity, confidence };
}

describe('deterministic corpus adjudication sampling', () => {
  it('round-robins rule/severity/confidence strata so a frequent rule cannot dominate', () => {
    const findings = [
      ...Array.from({ length: 20 }, (_, index) => finding(`common-${index}`, 'PS001')),
      finding('rare-error', 'PS010', 'error'),
      finding('rare-medium', 'PS050', 'advisory', 'medium'),
    ];

    const sample = stratifiedSample(findings, 6, 'release-candidate');

    expect(sample).toHaveLength(6);
    expect(new Set(sample.map((entry) => entry.ruleId))).toEqual(
      new Set(['PS001', 'PS010', 'PS050']),
    );
    expect(sample.filter((entry) => entry.ruleId === 'PS001')).toHaveLength(4);
    expect(stratifiedSample(findings, 6, 'release-candidate')).toEqual(sample);
    expect(stratifiedSample(findings, 6, 'different-seed')).not.toEqual(sample);
  });

  it('rejects invalid sizes and duplicate finding identifiers', () => {
    expect(() => stratifiedSample([finding('one', 'PS001')], 0, 'seed')).toThrow(/size/);
    expect(() =>
      stratifiedSample([finding('same', 'PS001'), finding('same', 'PS010')], 2, 'seed'),
    ).toThrow(/duplicate findingId/);
  });
});
