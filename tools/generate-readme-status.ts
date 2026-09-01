import { execFileSync } from 'node:child_process';
import { readFileSync, writeFileSync } from 'node:fs';
import { relative, resolve, sep } from 'node:path';
import { fileURLToPath } from 'node:url';
import {
  validateReadmeReleaseReceipt,
  validateReceiptAgainstStatus,
} from './readme-release-receipt.js';
import { canonicalJsonDigest } from './release/release-state.mjs';

const root = resolve(fileURLToPath(new URL('..', import.meta.url)));
const pkg = JSON.parse(readFileSync(resolve(root, 'package.json'), 'utf8')) as {
  name: string;
  version: string;
};
const arguments_ = process.argv.slice(2);
const requestedCommit = arguments_[0] ?? process.env.SCRIPTSPECT_SOURCE_COMMIT;
if (requestedCommit === undefined || requestedCommit.trim() === '') {
  throw new Error('pass an explicit reviewed source commit');
}
let published = false;
let receiptPath: string | undefined;
for (let index = 1; index < arguments_.length; index += 1) {
  const argument = arguments_[index];
  if (argument === '--published') {
    if (published) throw new Error('pass --published at most once');
    published = true;
    continue;
  }
  if (argument === '--receipt') {
    if (receiptPath !== undefined) throw new Error('pass --receipt at most once');
    receiptPath = arguments_[index + 1];
    if (receiptPath === undefined || receiptPath.trim() === '') {
      throw new Error('--receipt needs a path');
    }
    index += 1;
    continue;
  }
  throw new Error(`unknown README state option ${argument ?? ''}`);
}
const sourceCommit = execFileSync('git', ['rev-parse', `${requestedCommit}^{commit}`], {
  cwd: root,
  encoding: 'utf8',
}).trim();
execFileSync('git', ['merge-base', '--is-ancestor', sourceCommit, 'HEAD'], { cwd: root });
try {
  execFileSync(
    'git',
    [
      'diff',
      '--quiet',
      sourceCommit,
      'HEAD',
      '--',
      'src',
      'dist',
      'schema',
      'package.json',
      'pnpm-lock.yaml',
      'pnpm-workspace.yaml',
      'action.yml',
      'tsconfig.json',
      'tsup.config.ts',
    ],
    { cwd: root },
  );
} catch {
  throw new Error('source commit must match HEAD for runtime, package, and Action files');
}
const releaseState = published ? 'published' : 'pre-release';
const manifest: {
  schemaVersion: number;
  releaseState: 'pre-release' | 'published';
  packageName: string;
  packageVersion: string;
  sourceCommit: string;
  nodeMajor: number;
  repository: string;
  releaseEvidence?: { receiptPath: string; digest: string };
} = {
  schemaVersion: 1,
  releaseState,
  packageName: pkg.name,
  packageVersion: pkg.version,
  sourceCommit,
  nodeMajor: 22,
  repository: 'https://github.com/Tom409114/scriptspect',
};
if (releaseState === 'published') {
  if (pkg.version === '0.0.0') {
    throw new Error('published README state requires a nonzero released version');
  }
  if (receiptPath === undefined) {
    throw new Error('published README state requires --receipt terminal evidence');
  }
  const tagCommit = execFileSync('git', ['rev-parse', `v${pkg.version}^{commit}`], {
    cwd: root,
    encoding: 'utf8',
  }).trim();
  if (tagCommit !== sourceCommit) {
    throw new Error('published README state must use the exact immutable release tag commit');
  }
  const absoluteReceiptPath = resolve(root, receiptPath);
  const statusDirectory = resolve(root, 'docs');
  const expectedDirectory = resolve(statusDirectory, 'validation', 'releases', `v${pkg.version}`);
  if (
    absoluteReceiptPath !== resolve(expectedDirectory, 'readme-release-receipt.json') ||
    !absoluteReceiptPath.startsWith(`${expectedDirectory}${sep}`)
  ) {
    throw new Error(
      `published receipt must be docs/validation/releases/v${pkg.version}/readme-release-receipt.json`,
    );
  }
  const receipt = validateReadmeReleaseReceipt(
    JSON.parse(readFileSync(absoluteReceiptPath, 'utf8')),
  );
  manifest.releaseEvidence = {
    receiptPath: relative(statusDirectory, absoluteReceiptPath).replaceAll('\\', '/'),
    digest: canonicalJsonDigest(receipt),
  };
  validateReceiptAgainstStatus(receipt, manifest);
} else if (receiptPath !== undefined) {
  throw new Error('--receipt is only valid together with --published');
}

writeFileSync(resolve(root, 'docs/readme-status.json'), `${JSON.stringify(manifest, null, 2)}\n`);
console.log(`README status generated (${releaseState})`);
