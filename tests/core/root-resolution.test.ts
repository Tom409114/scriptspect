import { mkdirSync, mkdtempSync, realpathSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, describe, expect, it, vi } from 'vitest';

const observed = vi.hoisted(() => ({ packageJsonProbes: [] as string[] }));

vi.mock('node:fs', async (importOriginal) => {
  const actual = await importOriginal<typeof import('node:fs')>();
  return {
    ...actual,
    existsSync(path: Parameters<typeof actual.existsSync>[0]) {
      const normalized = String(path).replace(/\\/g, '/');
      if (normalized.endsWith('/package.json')) observed.packageJsonProbes.push(normalized);
      return actual.existsSync(path);
    },
  };
});

import { resolveRoot } from '../../src/core/analyze';

const roots: string[] = [];

afterEach(() => {
  observed.packageJsonProbes.length = 0;
  for (const root of roots.splice(0)) rmSync(root, { recursive: true, force: true });
});

function projectAboveWorkspace(): { parent: string; workspace: string; nested: string } {
  const parent = realpathSync(mkdtempSync(join(tmpdir(), 'scriptspect-root-boundary-')));
  roots.push(parent);
  const workspace = join(parent, 'workspace');
  const nested = join(workspace, 'nested');
  mkdirSync(nested, { recursive: true });
  writeFileSync(join(parent, 'package.json'), '{"name":"outside-workspace"}\n');
  return { parent, workspace, nested };
}

describe('project root resolution boundaries', () => {
  it('stops before probing package.json above an explicit workspace boundary', () => {
    const { parent, workspace, nested } = projectAboveWorkspace();
    const boundedResolveRoot: (startDir: string, stopDir: string) => string = resolveRoot;

    expect(() => boundedResolveRoot(nested, workspace)).toThrow(/no package\.json/i);
    expect(observed.packageJsonProbes).not.toContain(
      join(parent, 'package.json').replace(/\\/g, '/'),
    );
  });

  it('keeps the CLI-compatible unbounded upward lookup when no boundary is supplied', () => {
    const { parent, nested } = projectAboveWorkspace();

    expect(resolveRoot(nested)).toBe(parent);
    expect(observed.packageJsonProbes).toContain(join(parent, 'package.json').replace(/\\/g, '/'));
  });
});
