import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import Ajv2020 from 'ajv/dist/2020.js';
import { describe, expect, it } from 'vitest';
import { parseConfig } from '../../src/config/load';
import { ALL_TARGETS } from '../../src/core/targets';
import { buildJsonReport, JSON_SCHEMA_VERSION } from '../../src/reporters/json';
import { RULES } from '../../src/rules';
import { buildConfigSchema, buildOutputSchema, renderSchema } from '../../tools/generate-schemas';

const root = join(import.meta.dirname, '..', '..');

function readSchema(name: string): Record<string, unknown> {
  return JSON.parse(readFileSync(join(root, 'schema', name), 'utf8')) as Record<string, unknown>;
}

const ajv = new Ajv2020({ allErrors: true, strict: true });
const validateConfig = ajv.compile(readSchema('config.schema.json'));
const validateOutput = ajv.compile(readSchema('output.schema.json'));

const validConfigs: unknown[] = [
  {},
  { targets: ['posix-sh', 'cmd'] },
  { severity: { PS001: 'warn' } },
  { ignore: [{ rules: ['PS001'] }] },
  { ignore: [{ packages: ['packages/*/package.json'], scripts: ['build'], rules: ['PS010'] }] },
];

const invalidConfigs: unknown[] = [
  { surprise: true },
  { targets: ['cmd', 'cmd'] },
  { targets: ['fish'] },
  { severity: { PS999: 'warn' } },
  { severity: { PS001: 'fatal' } },
  { ignore: [{}] },
  { ignore: [{ packages: ['**'] }] },
  { ignore: [{ packages: [''], rules: ['PS001'] }] },
  { ignore: [{ rules: ['PS999'] }] },
  { ignore: [{ rules: [] }] },
  { ignore: [{ rules: ['PS001', 'PS001'] }] },
  { ignore: [{ rules: ['PS001'], surprise: true }] },
];

describe('published schema contracts', () => {
  it('keeps the checked-in schemas byte-for-byte generated', () => {
    expect(readFileSync(join(root, 'schema', 'config.schema.json'), 'utf8')).toBe(
      renderSchema(buildConfigSchema()),
    );
    expect(readFileSync(join(root, 'schema', 'output.schema.json'), 'utf8')).toBe(
      renderSchema(buildOutputSchema()),
    );
  });

  it('accepts exactly the same valid config corpus as runtime validation', () => {
    for (const config of validConfigs) {
      expect(validateConfig(config), JSON.stringify(validateConfig.errors)).toBe(true);
      expect(() => parseConfig(config, '<schema-test>')).not.toThrow();
    }
  });

  it('rejects exactly the same invalid config corpus as runtime validation', () => {
    for (const config of invalidConfigs) {
      expect(
        validateConfig(config),
        JSON.stringify({ config, errors: validateConfig.errors }),
      ).toBe(false);
      expect(() => parseConfig(config, '<schema-test>')).toThrow();
    }
  });

  it('enumerates the runtime targets and rule registry instead of accepting invented ids', () => {
    const schema = readSchema('config.schema.json') as {
      properties: {
        targets: { items: { enum: string[] } };
        severity: { propertyNames: { enum: string[] } };
        ignore: { items: { properties: { rules: { items: { enum: string[] } } } } };
      };
    };
    const ruleIds = RULES.map((rule) => rule.id);

    expect(schema.properties.targets.items.enum).toEqual(ALL_TARGETS);
    expect(schema.properties.severity.propertyNames.enum).toEqual(ruleIds);
    expect(schema.properties.ignore.items.properties.rules.items.enum).toEqual(ruleIds);
  });

  it('validates an actual JSON reporter result', () => {
    const report = buildJsonReport(
      {
        root: '/fixture',
        packages: [],
        findings: [],
        summary: {
          scriptsScanned: 0,
          packagesScanned: 0,
          errors: 0,
          warnings: 0,
          advisories: 0,
        },
      },
      ['posix-sh', 'cmd'],
    );

    expect(report.schemaVersion).toBe(JSON_SCHEMA_VERSION);
    expect(validateOutput(report), JSON.stringify(validateOutput.errors)).toBe(true);
  });
});
