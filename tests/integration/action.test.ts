/**
 * action.yml contract tests (spec §12): the Action is a thin wrapper over
 * the same CLI core; inputs map 1:1 to flags; it never commits fixes.
 */

import { readFileSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { describe, expect, it } from 'vitest';

const root = join(dirname(fileURLToPath(import.meta.url)), '..', '..');
const action = readFileSync(join(root, 'action.yml'), 'utf8');

describe('GitHub Action contract (spec §12.1)', () => {
  it('is a composite action using the CLI (same core, no forked logic)', () => {
    expect(action).toContain("using: 'composite'");
    expect(action).toContain('npx --yes "scriptspect@');
    expect(action).toContain('--format github');
  });

  it('exposes the spec input set: target and severity', () => {
    expect(action).toContain('target:');
    expect(action).toContain('severity:');
  });

  it('omits --target/--severity when unset so config-file settings are honored', () => {
    // With empty defaults, the CLI falls back to scriptspect.config.json
    // (then its own defaults). Flags are appended only when set explicitly.
    expect(action).toContain("default: ''");
    expect(action).toContain('if [ -n "${{ inputs.target }}" ]; then');
    expect(action).toContain('if [ -n "${{ inputs.severity }}" ]; then');
  });

  it('still supports explicit target/severity overrides', () => {
    expect(action).toContain('--target "${{ inputs.target }}"');
    expect(action).toContain('--severity "${{ inputs.severity }}"');
  });

  it('supports explicit paths and warning budgets', () => {
    expect(action).toContain('path:');
    expect(action).toContain('max-warnings:');
  });

  it('never modifies the repository (no fix mode in CI)', () => {
    expect(action).not.toContain('--fix');
    expect(action).not.toContain('git ');
  });
});
