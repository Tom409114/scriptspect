import { writeFileSync } from 'node:fs';
import { dirname, join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { ALL_TARGETS } from '../src/core/targets';
import { JSON_SCHEMA_VERSION } from '../src/reporters/schema-version';
import { RULES } from '../src/rules';

type JsonSchema = Record<string, unknown>;

const ruleIds = RULES.map((rule) => rule.id);
const severities = ['error', 'warn', 'advisory'] as const;
const confidences = ['high', 'medium'] as const;
const fixSafeties = ['safe', 'conditional', 'manual'] as const;

export function buildConfigSchema(): JsonSchema {
  return {
    $schema: 'https://json-schema.org/draft/2020-12/schema',
    $id: 'https://unpkg.com/scriptspect/schema/config.schema.json',
    title: 'ScriptSpect configuration',
    type: 'object',
    additionalProperties: false,
    properties: {
      targets: {
        type: 'array',
        minItems: 1,
        uniqueItems: true,
        items: { enum: ALL_TARGETS },
      },
      severity: {
        type: 'object',
        propertyNames: { enum: ruleIds },
        additionalProperties: { enum: severities },
      },
      ignore: {
        type: 'array',
        items: {
          type: 'object',
          additionalProperties: false,
          required: ['rules'],
          properties: {
            packages: {
              type: 'array',
              minItems: 1,
              items: { type: 'string', minLength: 1 },
            },
            scripts: {
              type: 'array',
              minItems: 1,
              items: { type: 'string', minLength: 1 },
            },
            rules: {
              type: 'array',
              minItems: 1,
              uniqueItems: true,
              items: { enum: ruleIds },
            },
          },
        },
      },
    },
  };
}

export function buildOutputSchema(): JsonSchema {
  return {
    $schema: 'https://json-schema.org/draft/2020-12/schema',
    $id: 'https://unpkg.com/scriptspect/schema/output.schema.json',
    title: 'ScriptSpect JSON report',
    type: 'object',
    additionalProperties: false,
    required: ['schemaVersion', 'tool', 'root', 'targets', 'findings', 'summary'],
    properties: {
      schemaVersion: { const: JSON_SCHEMA_VERSION },
      tool: {
        type: 'object',
        additionalProperties: false,
        required: ['name', 'version'],
        properties: {
          name: { const: 'scriptspect' },
          version: { type: 'string' },
        },
      },
      root: { type: 'string' },
      targets: {
        type: 'array',
        items: { enum: ALL_TARGETS },
        uniqueItems: true,
      },
      findings: {
        type: 'array',
        items: {
          type: 'object',
          additionalProperties: false,
          required: [
            'ruleId',
            'scriptName',
            'packagePath',
            'span',
            'severity',
            'confidence',
            'affectedTargets',
            'message',
          ],
          properties: {
            ruleId: { enum: ruleIds },
            scriptName: { type: 'string' },
            packagePath: { type: 'string' },
            span: {
              type: 'object',
              additionalProperties: false,
              required: ['start', 'end'],
              properties: {
                start: { type: 'integer', minimum: 0 },
                end: { type: 'integer', minimum: 0 },
              },
            },
            severity: { enum: severities },
            confidence: { enum: confidences },
            affectedTargets: {
              type: 'array',
              items: { enum: ALL_TARGETS },
              uniqueItems: true,
            },
            message: { type: 'string' },
            fix: {
              type: 'object',
              additionalProperties: false,
              required: ['safety', 'description'],
              properties: {
                safety: { enum: fixSafeties },
                description: { type: 'string' },
                requiresDependency: { type: 'string' },
              },
            },
          },
        },
      },
      summary: {
        type: 'object',
        additionalProperties: false,
        required: ['scriptsScanned', 'packagesScanned', 'errors', 'warnings', 'advisories'],
        properties: {
          scriptsScanned: { type: 'integer', minimum: 0 },
          packagesScanned: { type: 'integer', minimum: 0 },
          errors: { type: 'integer', minimum: 0 },
          warnings: { type: 'integer', minimum: 0 },
          advisories: { type: 'integer', minimum: 0 },
        },
      },
    },
  };
}

export function renderSchema(schema: JsonSchema): string {
  return `${JSON.stringify(schema, null, 2)}\n`;
}

export function writeSchemas(root: string): void {
  writeFileSync(join(root, 'schema', 'config.schema.json'), renderSchema(buildConfigSchema()));
  writeFileSync(join(root, 'schema', 'output.schema.json'), renderSchema(buildOutputSchema()));
}

const invokedPath = process.argv[1] === undefined ? undefined : resolve(process.argv[1]);
if (invokedPath === fileURLToPath(import.meta.url)) {
  writeSchemas(join(dirname(fileURLToPath(import.meta.url)), '..'));
}
