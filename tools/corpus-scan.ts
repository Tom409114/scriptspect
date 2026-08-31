/**
 * Public-corpus scanner (spec §16 Day 8-9, M8-01): read-only.
 *
 * Reads a list of `owner/repo` lines, fetches each repo's package.json via
 * the GitHub API, runs the full rule engine over its scripts, and writes:
 *  - findings.jsonl  (one line per finding: repo, script, rule, message)
 *  - summary.md      (per-rule counts + coverage stats — a DATA DRAFT for
 *                     human precision sampling, never auto-committed as
 *                     evidence per docs/evidence policy)
 *
 * The scanner never writes to third-party repositories (spec §0 COMMUNITY-02)
 * and never executes analyzed scripts (QUALITY-02).
 */
import { createWriteStream, readFileSync, writeFileSync } from 'node:fs';
import { DEFAULT_TARGETS } from '../src/core/targets';
import { analyzeScript } from '../src/rules';
import type { Finding } from '../src/rules/types';

interface RepoManifest {
  name?: string;
  scripts?: Record<string, string>;
  dependencies?: Record<string, string>;
  devDependencies?: Record<string, string>;
  optionalDependencies?: Record<string, string>;
  peerDependencies?: Record<string, string>;
  bin?: string | Record<string, string>;
}

const GITHUB_API = 'https://api.github.com';

async function fetchManifest(repo: string, token: string): Promise<RepoManifest | null> {
  const res = await fetch(`${GITHUB_API}/repos/${repo}/contents/package.json`, {
    headers: {
      Accept: 'application/vnd.github.raw+json',
      Authorization: `Bearer ${token}`,
      'User-Agent': 'scriptspect-corpus-scan',
    },
  });
  if (!res.ok) return null;
  try {
    return (await res.json()) as RepoManifest;
  } catch {
    return null;
  }
}

function dependencyNames(manifest: RepoManifest): Set<string> {
  const names = new Set<string>();
  for (const block of [
    manifest.dependencies,
    manifest.devDependencies,
    manifest.optionalDependencies,
    manifest.peerDependencies,
  ]) {
    if (block === undefined) continue;
    for (const name of Object.keys(block)) names.add(name);
  }
  return names;
}

function ownBins(manifest: RepoManifest): Set<string> {
  const names = new Set<string>();
  if (manifest.name !== undefined) names.add(manifest.name);
  if (typeof manifest.bin === 'object' && manifest.bin !== null) {
    for (const bin of Object.keys(manifest.bin)) names.add(bin);
  }
  return names;
}

async function main(): Promise<void> {
  const token = process.env.GITHUB_TOKEN ?? '';
  if (token === '') {
    console.error('GITHUB_TOKEN is required (read-only public access)');
    process.exit(2);
  }
  const listFile = process.argv[2];
  if (listFile === undefined) {
    console.error('usage: tsx tools/corpus-scan.ts repos.txt');
    process.exit(2);
  }
  const repos = readFileSync(listFile, 'utf8')
    .split(String.fromCharCode(10))
    .map((l) => l.trim());
  const findingsOut = createWriteStream('findings.jsonl', 'utf8');
  const reposWithScripts: string[] = [];
  const scriptsScannedTotal: number[] = [];
  const byRule = new Map<string, number>();
  const byRepo = new Map<string, number>();
  let findingCount = 0;

  for (const repo of repos) {
    if (repo === '' || repo.startsWith('#')) continue;
    const manifest = await fetchManifest(repo, token);
    if (manifest === null || manifest.scripts === undefined) continue;
    const scripts = Object.entries(manifest.scripts).filter(([, v]) => typeof v === 'string');
    if (scripts.length === 0) continue;
    reposWithScripts.push(repo);
    const dependencies = dependencyNames(manifest);
    const workspaceBins = ownBins(manifest);
    scriptsScannedTotal.push(scripts.length);

    for (const [scriptName, script] of scripts as Array<[string, string]>) {
      const findings: Finding[] = analyzeScript(script, {
        script,
        scriptName,
        packagePath: 'package.json',
        targets: DEFAULT_TARGETS,
        dependencies,
        workspaceBins,
      });
      for (const f of findings) {
        findingCount += 1;
        byRule.set(f.ruleId, (byRule.get(f.ruleId) ?? 0) + 1);
        byRepo.set(repo, (byRepo.get(repo) ?? 0) + 1);
        findingsOut.write(
          JSON.stringify({
            repo,
            script: scriptName,
            ruleId: f.ruleId,
            severity: f.severity,
            confidence: f.confidence,
            affectedTargets: f.affectedTargets,
            message: f.message,
            source: script,
          }) + '\n',
        );
      }
    }
    await new Promise((r) => setTimeout(r, 250)); // stay well inside rate limits
  }

  findingsOut.end();
  const scriptsScanned = scriptsScannedTotal.reduce((a, b) => a + b, 0);
  const lines = [
    '# Corpus scan draft (unverified — for human precision sampling only)',
    '',
    `- Repos scanned with scripts: ${reposWithScripts.length}`,
    `- Scripts analyzed: ${scriptsScanned}`,
    `- Findings: ${findingCount}`,
    `- Distinct rules triggered: ${byRule.size}`,
    '',
    '## Findings by rule',
    '',
    '| Rule | Findings |',
    '| --- | --- |',
    ...[...byRule.entries()].sort((a, b) => b[1] - a[1]).map(([r, c]) => `| ${r} | ${c} |`),
    '',
    '## Top repos by finding count',
    '',
    '| Repo | Findings |',
    '| --- | --- |',
    ...[...byRepo.entries()]
      .sort((a, b) => b[1] - a[1])
      .slice(0, 20)
      .map(([r, c]) => `| ${r} | ${c} |`),
  ];
  writeFileSync('summary.md', lines.join('\n'), 'utf8');
  console.log(
    `scanned ${reposWithScripts.length} repos, ${scriptsScanned} scripts, ${findingCount} findings`,
  );
}

await main();
