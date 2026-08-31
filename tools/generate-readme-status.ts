import { execFileSync } from 'node:child_process';
import { readFileSync, writeFileSync } from 'node:fs';
import { resolve } from 'node:path';
import { fileURLToPath } from 'node:url';

const root = resolve(fileURLToPath(new URL('..', import.meta.url)));
const pkg = JSON.parse(readFileSync(resolve(root, 'package.json'), 'utf8')) as {
  name: string;
  version: string;
};
const sourceCommit = execFileSync('git', ['rev-parse', 'HEAD'], {
  cwd: root,
  encoding: 'utf8',
}).trim();
const releaseState = pkg.version === '0.0.0' ? 'pre-release' : 'published';

const manifest = {
  schemaVersion: 1,
  releaseState,
  packageName: pkg.name,
  packageVersion: pkg.version,
  sourceCommit,
  nodeMajor: 22,
  repository: 'https://github.com/Tom409114/scriptspect',
};

writeFileSync(resolve(root, 'docs/readme-status.json'), `${JSON.stringify(manifest, null, 2)}\n`);
console.log(`README status generated (${releaseState})`);
