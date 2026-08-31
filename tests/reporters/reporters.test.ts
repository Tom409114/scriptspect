import { describe, expect, it } from 'vitest';
import type { AnalysisResult, PackageUnit } from '../../src/core/analyze';
import { DEFAULT_TARGETS } from '../../src/core/targets';
import { renderAnnotations, renderSummary } from '../../src/reporters/github';
import { buildJsonReport, JSON_SCHEMA_VERSION, renderJson } from '../../src/reporters/json';
import { caretLine, renderStylish } from '../../src/reporters/stylish';
import { analyzeScript } from '../../src/rules';
import type { Finding } from '../../src/rules/types';

function resultFor(scripts: Record<string, string>): AnalysisResult {
  const findings: Finding[] = [];
  const dependencies = new Set(['vite']);
  for (const [scriptName, script] of Object.entries(scripts)) {
    findings.push(
      ...analyzeScript(script, {
        script,
        scriptName,
        packagePath: 'package.json',
        targets: DEFAULT_TARGETS,
        dependencies,
        workspaceBins: new Set(),
      }),
    );
  }
  const manifest = { name: 'fixture', scripts };
  const packages: PackageUnit[] = [{ relPath: 'package.json', absDir: '/fixture', manifest }];
  return {
    root: '/fixture',
    packages,
    findings,
    summary: {
      scriptsScanned: Object.keys(scripts).length,
      packagesScanned: 1,
      errors: findings.filter((f) => f.severity === 'error').length,
      warnings: findings.filter((f) => f.severity === 'warn').length,
      advisories: findings.filter((f) => f.severity === 'advisory').length,
    },
  };
}

describe('stylish reporter', () => {
  it('renders carets under the exact span', () => {
    expect(caretLine('NODE_ENV=production vite build', [0, 19])).toBe('^^^^^^^^^^^^^^^^^^^');
    expect(caretLine('rm -rf dist', [0, 2])).toBe('^^');
  });

  it('renders the spec §4.2 layout for a finding', () => {
    const out = renderStylish(resultFor({ build: 'NODE_ENV=production vite build' }), {
      color: false,
      quiet: false,
    });
    expect(out).toContain('package.json  ›  scripts.build');
    expect(out).toContain('PS001  error  HIGH  POSIX inline env assignment');
    expect(out).toContain('NODE_ENV=production vite build');
    expect(out).toContain('^^^^^^^^^^^^^^^^^^^');
    expect(out).toContain('Affected: cmd');
    expect(out).toMatch(/Fix: .*cross-env/);
    expect(out).toContain(
      'Learn more: https://github.com/Tom409114/scriptspect/blob/main/docs/rules/PS001.md',
    );
    expect(out).toContain('Scanned 1 script across 1 package · 1 error · 0 warnings');
  });

  it('renders plural forms in the summary', () => {
    const out = renderStylish(
      resultFor({ a: 'NODE_ENV=x vite build', b: 'NODE_ENV=y vite build', c: 'chmod +x f' }),
      { color: false, quiet: false },
    );
    expect(out).toContain('Scanned 3 scripts across 1 package · 2 errors · 1 warning');
  });

  it('quiet mode prints one line per finding plus the summary', () => {
    const out = renderStylish(resultFor({ build: 'rm -rf dist' }), { color: false, quiet: true });
    const lines = out.trim().split('\n');
    expect(lines[0]).toContain('PS010');
    expect(lines[0]).toContain('package.json build');
    expect(lines[lines.length - 1]).toContain('Scanned 1 script');
  });

  it('clean projects print just the summary', () => {
    const out = renderStylish(resultFor({ build: 'vite build' }), { color: false, quiet: false });
    expect(out.trim()).toBe('Scanned 1 script across 1 package · 0 errors · 0 warnings');
  });
});

describe('json reporter', () => {
  it('emits a versioned, machine-readable report', () => {
    const result = resultFor({ build: 'rm -rf dist' });
    const parsed = JSON.parse(renderJson(result, DEFAULT_TARGETS));
    expect(parsed.schemaVersion).toBe(JSON_SCHEMA_VERSION);
    expect(parsed.tool.name).toBe('scriptspect');
    expect(parsed.findings[0]).toMatchObject({
      ruleId: 'PS010',
      scriptName: 'build',
      packagePath: 'package.json',
      severity: 'error',
      confidence: 'high',
      affectedTargets: ['cmd'],
    });
    expect(parsed.findings[0].span).toEqual({ start: 0, end: 2 });
    expect(parsed.summary.errors).toBe(1);
  });

  it('keeps the schema version stable at 1', () => {
    expect(JSON_SCHEMA_VERSION).toBe(1);
    expect(buildJsonReport(resultFor({}), []).schemaVersion).toBe(1);
  });
});

describe('github reporter', () => {
  it('emits annotation commands with file and title', () => {
    const out = renderAnnotations(resultFor({ build: 'rm -rf dist' }));
    expect(out).toMatch(/^::error file=package\.json,title=PS010%3A scripts\.build::/);
    expect(out).toContain('affected%3A cmd');
  });

  it('uses warning level for warn findings', () => {
    const out = renderAnnotations(resultFor({ x: 'chmod +x f' }));
    expect(out).toMatch(/^::warning file=/);
  });

  it('renders a markdown job summary with counts and top rules', () => {
    const md = renderSummary(resultFor({ a: 'rm -rf dist', b: 'NODE_ENV=x v' }));
    expect(md).toContain('## scriptspect');
    expect(md).toContain('**1 scripts**');
    expect(md).toContain('| PS010 | 1 |');
    expect(md).toContain('| errors | 1 |');
  });

  it('summary omits the top-rules table when clean', () => {
    const md = renderSummary(resultFor({ a: 'vite build' }));
    expect(md).not.toContain('Top rules');
  });
});
