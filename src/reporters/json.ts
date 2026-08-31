/**
 * Machine-readable JSON reporter with a versioned schema (spec §3.2, M3-02):
 * schema version is API; changes require a schema/version evaluation.
 */

import type { AnalysisResult } from '../core/analyze';
import { version } from '../core/version';
import type { ShellTarget } from '../parser/ir';
import type { Finding, FixSafety } from '../rules/types';
import { JSON_SCHEMA_VERSION } from './schema-version';

export { JSON_SCHEMA_VERSION } from './schema-version';

export interface JsonSpan {
  start: number;
  end: number;
}

export interface JsonFix {
  safety: FixSafety;
  description: string;
  requiresDependency?: string;
}

export interface JsonFinding {
  ruleId: string;
  scriptName: string;
  packagePath: string;
  span: JsonSpan;
  severity: Finding['severity'];
  confidence: Finding['confidence'];
  affectedTargets: ShellTarget[];
  message: string;
  fix?: JsonFix;
}

export interface JsonReport {
  schemaVersion: number;
  tool: { name: string; version: string };
  root: string;
  targets: ShellTarget[];
  findings: JsonFinding[];
  summary: {
    scriptsScanned: number;
    packagesScanned: number;
    errors: number;
    warnings: number;
    advisories: number;
  };
}

export function buildJsonReport(
  result: AnalysisResult,
  targets: readonly ShellTarget[],
): JsonReport {
  return {
    schemaVersion: JSON_SCHEMA_VERSION,
    tool: { name: 'scriptspect', version },
    root: result.root,
    targets: [...targets],
    findings: result.findings.map(toJsonFinding),
    summary: result.summary,
  };
}

export function toJsonFinding(f: Finding): JsonFinding {
  const out: JsonFinding = {
    ruleId: f.ruleId,
    scriptName: f.scriptName,
    packagePath: f.packagePath,
    span: { start: f.span[0], end: f.span[1] },
    severity: f.severity,
    confidence: f.confidence,
    affectedTargets: [...f.affectedTargets],
    message: f.message,
  };
  if (f.fix !== undefined) {
    const fix: JsonFix = { safety: f.fix.safety, description: f.fix.description };
    if (f.fix.requiresDependency !== undefined) fix.requiresDependency = f.fix.requiresDependency;
    out.fix = fix;
  }
  return out;
}

export function renderJson(result: AnalysisResult, targets: readonly ShellTarget[]): string {
  return `${JSON.stringify(buildJsonReport(result, targets), null, 2)}\n`;
}
