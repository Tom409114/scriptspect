import { describe, expect, it } from 'vitest';
import { analyzeScript, RULES } from '../../src/rules/index';
import { makeCtx } from './helpers';

describe('rule engine', () => {
  it('every rule ships complete metadata', () => {
    for (const rule of RULES) {
      expect(rule.id, rule.id).toMatch(/^PS\d{3}$/);
      expect(rule.title, rule.id).toBeTruthy();
      expect(rule.summary, rule.id).toBeTruthy();
      expect(rule.badExamples.length, rule.id).toBeGreaterThanOrEqual(2);
      expect(rule.goodExamples.length, rule.id).toBeGreaterThanOrEqual(2);
      expect(rule.falsePositiveNotes, rule.id).toBeTruthy();
      expect(rule.provenance.length, rule.id).toBeGreaterThanOrEqual(1);
      expect(['error', 'warn', 'advisory'], rule.id).toContain(rule.severity);
      expect(['high', 'medium'], rule.id).toContain(rule.confidence);
      expect(['safe', 'conditional', 'manual'], rule.id).toContain(rule.fixSafety);
    }
  });

  it('severity overrides from config are applied', () => {
    const findings = analyzeScript('NODE_ENV=x vite build', makeCtx({ script: 'NODE_ENV=x vite build' }), {
      severityOverrides: new Map([['PS001', 'advisory']]),
    });
    expect(findings[0]?.severity).toBe('advisory');
  });

  it('onlyRules restricts execution', () => {
    const findings = analyzeScript(
      'NODE_ENV=x vite build && rm -rf dist && bash -c "echo hi"',
      makeCtx({ script: 'x' }),
      { onlyRules: new Set(['PS001']) },
    );
    expect(findings.map((f) => f.ruleId)).toEqual(['PS001']);
  });

  it('findings are sorted by span', () => {
    const findings = analyzeScript(
      'rm -rf dist && NODE_ENV=x vite build',
      makeCtx({ script: 'rm -rf dist && NODE_ENV=x vite build' }),
    );
    const spans = findings.map((f) => f.span[0]);
    expect([...spans].sort((a, b) => a - b)).toEqual(spans);
  });

  it('findings carry script and package identity', () => {
    const findings = analyzeScript(
      'NODE_ENV=x vite build',
      makeCtx({ script: 'NODE_ENV=x vite build', scriptName: 'build', packagePath: 'packages/web/package.json' }),
    );
    expect(findings[0]?.scriptName).toBe('build');
    expect(findings[0]?.packagePath).toBe('packages/web/package.json');
  });
});
