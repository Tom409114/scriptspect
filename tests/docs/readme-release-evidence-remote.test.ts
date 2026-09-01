import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, describe, expect, it } from 'vitest';
import { canonicalJsonDigest } from '../../tools/release/release-state.mjs';
import { verifyReadmeReleaseEvidence } from '../../tools/verify-readme-release-evidence.js';

const sourceCommit = 'bf37b4132508c685a91cc16a9c0a3058c252502e';
const intentCheckRunId = 123456789;
const finalVerificationAssetId = 234567890;
const publishRunId = 345678901;
const npmSRI =
  'sha512-AQEBAQEBAQEBAQEBAQEBAQEBAQEBAQEBAQEBAQEBAQEBAQEBAQEBAQEBAQEBAQEBAQEBAQEBAQEBAQEBAQEBAQ==';

const finalVerification = {
  schemaVersion: 'scriptspect-final-verification/v1',
  intentId: 'release-intent-0.1.0',
  version: '0.1.0',
  tag: 'v0.1.0',
  commit: sourceCommit,
  releaseId: 123456,
  candidateManifestDigest: 'a'.repeat(64),
  releaseManifestDigest: 'b'.repeat(64),
  candidateNpmSRI: npmSRI,
  registryNpmSRI: npmSRI,
  provenanceDigest: 'c'.repeat(64),
  aliases: [
    { name: 'v0.1', target: sourceCommit },
    { name: 'v0', target: sourceCommit },
  ],
} as const;

const finalVerificationDigest = canonicalJsonDigest(finalVerification);

const immutableAssets = [
  { name: 'scriptspect-0.1.0.tgz', assetId: 234567881, sha256: 'd'.repeat(64) },
  { name: 'SHA256SUMS', assetId: 234567882, sha256: 'e'.repeat(64) },
  { name: 'candidate-manifest.json', assetId: 234567883, sha256: 'f'.repeat(64) },
  {
    name: 'release-manifest.json',
    assetId: 234567884,
    sha256: finalVerification.releaseManifestDigest,
  },
] as const;

const consumedState = {
  schemaVersion: 'scriptspect-release-state/v1',
  revision: 8,
  state: 'consumed',
  intent: {
    schemaVersion: 'scriptspect-release-intent/v1',
    intentId: finalVerification.intentId,
    prNumber: 62,
    mergeCommitSha: sourceCommit,
    version: finalVerification.version,
    tag: finalVerification.tag,
    packageManifestHash: '1'.repeat(64),
    changelogHash: '2'.repeat(64),
    releasePleaseManifestHash: '3'.repeat(64),
    releasePrActor: 'googleapis-release-please[bot]',
    releasePrHead: 'googleapis:release-please--branches--main',
    releasePrHeadRepo: 'Tom409114/scriptspect',
    releasePrHeadSha: '4'.repeat(40),
  },
  retainedCandidate: {
    runId: 345678890,
    artifactId: 234567800,
    artifactDigest: '5'.repeat(64),
    candidateManifestDigest: finalVerification.candidateManifestDigest,
    npmSRI,
  },
  stagedDraft: {
    releaseId: finalVerification.releaseId,
    assets: immutableAssets,
    releaseManifestDigest: finalVerification.releaseManifestDigest,
  },
  npmPublished: {
    publishedVersion: finalVerification.version,
    npmSRI,
    publishRunId,
  },
  npmVerified: {
    registryNpmSRI: npmSRI,
    registryManifestDigest: '6'.repeat(64),
    provenanceDigest: finalVerification.provenanceDigest,
  },
  aliasPlan: {
    version: finalVerification.version,
    commit: sourceCommit,
    aliases: [
      { name: 'v0.1', previousTarget: null, target: sourceCommit },
      { name: 'v0', previousTarget: null, target: sourceCommit },
    ],
  },
  aliasesVerified: {
    aliases: [
      { name: 'v0.1', previousTarget: null, target: sourceCommit },
      { name: 'v0', previousTarget: null, target: sourceCommit },
    ],
  },
  finalPlanned: { finalVerificationDigest },
  consumed: { finalVerificationDigest, finalVerificationAssetId },
} as const;

const receipt = {
  schemaVersion: 'scriptspect-readme-release-receipt/v1',
  repository: 'https://github.com/Tom409114/scriptspect',
  intentCheckRunId,
  finalVerificationAssetId,
  finalVerificationDigest,
  publishRunId,
  finalVerification,
} as const;

type RemoteFixtureOverrides = {
  checkRun?: unknown;
  release?: unknown;
  finalAssetBytes?: string;
  npmMetadata?: unknown;
  refs?: Record<string, unknown>;
};

function checkRunFor(state: unknown = consumedState): unknown {
  return {
    id: intentCheckRunId,
    name: 'release-intent',
    status: 'completed',
    conclusion: 'success',
    head_sha: sourceCommit,
    external_id: finalVerification.intentId,
    app: { slug: 'github-actions' },
    output: {
      title: 'Consumed release intent',
      summary: 'Final verification is exact and idempotent',
      text: JSON.stringify(state),
    },
  };
}

function releaseFixture(): unknown {
  return {
    id: finalVerification.releaseId,
    tag_name: finalVerification.tag,
    target_commitish: sourceCommit,
    draft: false,
    prerelease: false,
    assets: [
      ...immutableAssets.map((asset) => ({
        id: asset.assetId,
        name: asset.name,
        digest: `sha256:${asset.sha256}`,
      })),
      {
        id: finalVerificationAssetId,
        name: 'final-verification.json',
        digest: `sha256:${finalVerificationDigest}`,
      },
    ],
  };
}

function refFixtures(): Record<string, unknown> {
  return Object.fromEntries(
    [finalVerification.tag, 'v0.1', 'v0'].map((tag) => [
      tag,
      { ref: `refs/tags/${tag}`, object: { type: 'commit', sha: sourceCommit } },
    ]),
  );
}

const temporaryRoots: string[] = [];

function canonicalJson(value: unknown): string {
  if (value === null || typeof value === 'string' || typeof value === 'boolean') {
    return JSON.stringify(value);
  }
  if (typeof value === 'number') return JSON.stringify(value);
  if (Array.isArray(value)) return `[${value.map((entry) => canonicalJson(entry)).join(',')}]`;
  const object = value as Record<string, unknown>;
  return `{${Object.keys(object)
    .sort()
    .map((key) => `${JSON.stringify(key)}:${canonicalJson(object[key])}`)
    .join(',')}}`;
}

afterEach(() => {
  for (const root of temporaryRoots.splice(0)) {
    rmSync(root, { recursive: true, force: true });
  }
});

function writeLocalEvidence(statusOverrides: Record<string, unknown> = {}): {
  repositoryRoot: string;
  statusPath: string;
} {
  const repositoryRoot = mkdtempSync(join(tmpdir(), 'scriptspect-readme-remote-'));
  temporaryRoots.push(repositoryRoot);
  const statusPath = join(repositoryRoot, 'docs', 'readme-status.json');
  const receiptDirectory = join(repositoryRoot, 'docs', 'validation', 'releases', 'v0.1.0');
  mkdirSync(receiptDirectory, { recursive: true });
  writeFileSync(
    join(receiptDirectory, 'readme-release-receipt.json'),
    `${JSON.stringify(receipt, null, 2)}\n`,
  );
  writeFileSync(
    statusPath,
    `${JSON.stringify(
      {
        schemaVersion: 1,
        releaseState: 'published',
        packageName: 'scriptspect',
        packageVersion: finalVerification.version,
        sourceCommit,
        nodeMajor: 22,
        repository: receipt.repository,
        releaseEvidence: {
          receiptPath: 'validation/releases/v0.1.0/readme-release-receipt.json',
          digest: canonicalJsonDigest(receipt),
        },
        ...statusOverrides,
      },
      null,
      2,
    )}\n`,
  );
  return { repositoryRoot, statusPath };
}

function jsonResponse(value: unknown): Response {
  return new Response(JSON.stringify(value), {
    status: 200,
    headers: { 'content-type': 'application/json' },
  });
}

function remoteFetch(overrides: RemoteFixtureOverrides = {}): typeof fetch {
  const apiRoot = 'https://api.github.com/repos/Tom409114/scriptspect';
  const checkRun = overrides.checkRun ?? checkRunFor();
  const release = overrides.release ?? releaseFixture();
  const refs = overrides.refs ?? refFixtures();
  const npmMetadata =
    overrides.npmMetadata ??
    ({
      name: 'scriptspect',
      version: finalVerification.version,
      dist: {
        integrity: npmSRI,
        tarball: 'https://registry.npmjs.org/scriptspect/-/scriptspect-0.1.0.tgz',
      },
    } as const);
  const finalAssetBytes = overrides.finalAssetBytes ?? `${canonicalJson(finalVerification)}\n`;

  return async (input, init) => {
    const url = input instanceof URL ? input.href : typeof input === 'string' ? input : input.url;
    if (url.startsWith(apiRoot)) {
      const headers = new Headers(init?.headers);
      if (headers.get('authorization') !== 'Bearer test-token') {
        return new Response('missing test token', { status: 401 });
      }
      if (url === `${apiRoot}/check-runs/${intentCheckRunId}`) return jsonResponse(checkRun);
      if (url === `${apiRoot}/releases/tags/${finalVerification.tag}`) {
        return jsonResponse(release);
      }
      if (url === `${apiRoot}/releases/assets/${finalVerificationAssetId}`) {
        if (headers.get('accept') !== 'application/octet-stream') {
          return new Response('wrong media type', { status: 406 });
        }
        return new Response(finalAssetBytes, { status: 200 });
      }
      const tagPrefix = `${apiRoot}/git/ref/tags/`;
      if (url.startsWith(tagPrefix)) {
        const tag = decodeURIComponent(url.slice(tagPrefix.length));
        const ref = refs[tag];
        return ref === undefined ? new Response('missing ref', { status: 404 }) : jsonResponse(ref);
      }
    }
    if (url === 'https://registry.npmjs.org/scriptspect/0.1.0') {
      return jsonResponse(npmMetadata);
    }
    return new Response(`unexpected request: ${url}`, { status: 404 });
  };
}

describe('remote README release evidence', () => {
  it('accepts only a terminal receipt whose exact GitHub and npm evidence is still public', async () => {
    const local = writeLocalEvidence();

    await expect(
      verifyReadmeReleaseEvidence({
        ...local,
        githubToken: 'test-token',
        fetchImpl: remoteFetch(),
      }),
    ).resolves.toEqual({
      releaseState: 'published',
      remoteVerification: 'verified',
      repository: receipt.repository,
      packageName: 'scriptspect',
      version: '0.1.0',
      tag: 'v0.1.0',
      commit: sourceCommit,
      releaseId: 123456,
      intentCheckRunId,
      publishRunId,
      finalVerificationAssetId,
      finalVerificationDigest,
    });
  });

  it('rejects a published status bound to another source commit before making requests', async () => {
    const local = writeLocalEvidence({ sourceCommit: '0'.repeat(40) });
    const remote = remoteFetch();
    let requestCount = 0;
    const fetchImpl: typeof fetch = (input, init) => {
      requestCount += 1;
      return remote(input, init);
    };

    await expect(
      verifyReadmeReleaseEvidence({
        ...local,
        githubToken: 'test-token',
        fetchImpl,
      }),
    ).rejects.toThrow(/sourceCommit/i);
    expect(requestCount).toBe(0);
  });

  it('validates pre-release status locally without a token or any network request', async () => {
    const repositoryRoot = mkdtempSync(join(tmpdir(), 'scriptspect-readme-pre-release-'));
    temporaryRoots.push(repositoryRoot);
    const statusPath = join(repositoryRoot, 'docs', 'readme-status.json');
    mkdirSync(join(repositoryRoot, 'docs'), { recursive: true });
    writeFileSync(
      statusPath,
      `${JSON.stringify(
        {
          schemaVersion: 1,
          releaseState: 'pre-release',
          packageName: 'scriptspect',
          packageVersion: '0.0.0',
          sourceCommit,
          nodeMajor: 22,
          repository: receipt.repository,
        },
        null,
        2,
      )}\n`,
    );
    let requestCount = 0;
    const fetchImpl: typeof fetch = async () => {
      requestCount += 1;
      return new Response('network must not be used', { status: 500 });
    };

    await expect(
      verifyReadmeReleaseEvidence({ repositoryRoot, statusPath, fetchImpl }),
    ).resolves.toEqual({
      releaseState: 'pre-release',
      remoteVerification: 'not-required',
      repository: receipt.repository,
      packageName: 'scriptspect',
      packageVersion: '0.0.0',
      sourceCommit,
    });
    expect(requestCount).toBe(0);
  });

  it('requires a token for published evidence before making a GitHub request', async () => {
    const local = writeLocalEvidence();
    const remote = remoteFetch();
    let requestCount = 0;
    const fetchImpl: typeof fetch = (input, init) => {
      requestCount += 1;
      return remote(input, init);
    };

    await expect(
      verifyReadmeReleaseEvidence({
        ...local,
        githubToken: '',
        fetchImpl,
      }),
    ).rejects.toThrow(/GITHUB_TOKEN/u);
    expect(requestCount).toBe(0);
  });

  it('rejects a receipt path that resolves outside docs/validation/releases without networking', async () => {
    const local = writeLocalEvidence({
      releaseEvidence: {
        receiptPath: 'readme-release-receipt.json',
        digest: canonicalJsonDigest(receipt),
      },
    });
    writeFileSync(
      join(local.repositoryRoot, 'docs', 'readme-release-receipt.json'),
      `${JSON.stringify(receipt)}\n`,
    );
    let requestCount = 0;
    const fetchImpl: typeof fetch = async () => {
      requestCount += 1;
      return new Response('network must not be used', { status: 500 });
    };

    await expect(
      verifyReadmeReleaseEvidence({ ...local, githubToken: 'test-token', fetchImpl }),
    ).rejects.toThrow(/docs\/validation\/releases/u);
    expect(requestCount).toBe(0);
  });

  it('rejects an otherwise valid intent check that is not owned by github-actions', async () => {
    const local = writeLocalEvidence();
    const checkRun = checkRunFor() as Record<string, unknown>;

    await expect(
      verifyReadmeReleaseEvidence({
        ...local,
        githubToken: 'test-token',
        fetchImpl: remoteFetch({ checkRun: { ...checkRun, app: { slug: 'other-app' } } }),
      }),
    ).rejects.toThrow(/app slug/u);
  });

  it.each([
    ['status', 'in_progress'],
    ['conclusion', 'failure'],
  ])('rejects an intent check with non-terminal %s=%s', async (field, value) => {
    const local = writeLocalEvidence();
    const checkRun = checkRunFor() as Record<string, unknown>;

    await expect(
      verifyReadmeReleaseEvidence({
        ...local,
        githubToken: 'test-token',
        fetchImpl: remoteFetch({ checkRun: { ...checkRun, [field]: value } }),
      }),
    ).rejects.toThrow(new RegExp(`intent check run ${field}`, 'u'));
  });

  it('rejects a successful intent check whose state has not reached consumed', async () => {
    const local = writeLocalEvidence();
    const { consumed: _consumed, ...finalPlanned } = consumedState;

    await expect(
      verifyReadmeReleaseEvidence({
        ...local,
        githubToken: 'test-token',
        fetchImpl: remoteFetch({
          checkRun: checkRunFor({ ...finalPlanned, state: 'final-planned' }),
        }),
      }),
    ).rejects.toThrow(/must be consumed/u);
  });

  it('rejects a receipt publish run that is not the one persisted in terminal state', async () => {
    const local = writeLocalEvidence();
    const state = {
      ...consumedState,
      npmPublished: { ...consumedState.npmPublished, publishRunId: publishRunId + 1 },
    };

    await expect(
      verifyReadmeReleaseEvidence({
        ...local,
        githubToken: 'test-token',
        fetchImpl: remoteFetch({ checkRun: checkRunFor(state) }),
      }),
    ).rejects.toThrow(/publishRunId/u);
  });

  it('rejects a GitHub Release whose final asset digest differs from consumed state', async () => {
    const local = writeLocalEvidence();
    const release = releaseFixture() as {
      assets: Array<{ id: number; name: string; digest: string }>;
    };
    const assets = release.assets.map((asset) =>
      asset.id === finalVerificationAssetId
        ? { ...asset, digest: `sha256:${'9'.repeat(64)}` }
        : asset,
    );

    await expect(
      verifyReadmeReleaseEvidence({
        ...local,
        githubToken: 'test-token',
        fetchImpl: remoteFetch({ release: { ...release, assets } }),
      }),
    ).rejects.toThrow(/final verification digest/u);
  });

  it('rejects a GitHub Release that is still marked as a prerelease', async () => {
    const local = writeLocalEvidence();
    const release = releaseFixture() as Record<string, unknown>;

    await expect(
      verifyReadmeReleaseEvidence({
        ...local,
        githubToken: 'test-token',
        fetchImpl: remoteFetch({ release: { ...release, prerelease: true } }),
      }),
    ).rejects.toThrow(/prerelease must be false/u);
  });

  it('rejects an immutable version tag that no longer targets the release commit', async () => {
    const local = writeLocalEvidence();
    const refs = refFixtures();
    refs[finalVerification.tag] = {
      ref: `refs/tags/${finalVerification.tag}`,
      object: { type: 'commit', sha: '0'.repeat(40) },
    };

    await expect(
      verifyReadmeReleaseEvidence({
        ...local,
        githubToken: 'test-token',
        fetchImpl: remoteFetch({ refs }),
      }),
    ).rejects.toThrow(/v0\.1\.0 tag ref target/u);
  });

  it('rejects downloaded final-verification bytes with the wrong raw SHA-256', async () => {
    const local = writeLocalEvidence();

    await expect(
      verifyReadmeReleaseEvidence({
        ...local,
        githubToken: 'test-token',
        fetchImpl: remoteFetch({ finalAssetBytes: `${JSON.stringify(finalVerification)}\n` }),
      }),
    ).rejects.toThrow(/downloaded final verification SHA-256/u);
  });

  it('rejects npm exact-version metadata with a different dist.integrity', async () => {
    const local = writeLocalEvidence();
    const otherSRI = `sha512-${Buffer.alloc(64, 2).toString('base64')}`;

    await expect(
      verifyReadmeReleaseEvidence({
        ...local,
        githubToken: 'test-token',
        fetchImpl: remoteFetch({
          npmMetadata: {
            name: 'scriptspect',
            version: finalVerification.version,
            dist: {
              integrity: otherSRI,
              tarball: 'https://registry.npmjs.org/scriptspect/-/scriptspect-0.1.0.tgz',
            },
          },
        }),
      }),
    ).rejects.toThrow(/dist\.integrity/u);
  });

  it.each(['v0.1', 'v0'])(
    'rejects floating alias %s when it no longer targets the release commit',
    async (alias) => {
      const local = writeLocalEvidence();
      const refs = refFixtures();
      refs[alias] = {
        ref: `refs/tags/${alias}`,
        object: { type: 'commit', sha: '0'.repeat(40) },
      };

      await expect(
        verifyReadmeReleaseEvidence({
          ...local,
          githubToken: 'test-token',
          fetchImpl: remoteFetch({ refs }),
        }),
      ).rejects.toThrow(new RegExp(`${alias.replaceAll('.', '\\.')} tag ref target`, 'u'));
    },
  );
});
