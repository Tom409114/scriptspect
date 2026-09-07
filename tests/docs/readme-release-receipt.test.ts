import { describe, expect, it } from 'vitest';
import {
  validateReadmeReleaseReceipt,
  validateReceiptAgainstStatus,
} from '../../tools/readme-release-receipt.js';

const sourceCommit = 'bf37b4132508c685a91cc16a9c0a3058c252502e';
const npmSRI =
  'sha512-AQEBAQEBAQEBAQEBAQEBAQEBAQEBAQEBAQEBAQEBAQEBAQEBAQEBAQEBAQEBAQEBAQEBAQEBAQEBAQEBAQEBAQ==';

const finalVerification = {
  schemaVersion: 'scriptspect-final-verification/v1',
  intentId: `scriptspect-release-intent:66:${sourceCommit}`,
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

const validReceipt = {
  schemaVersion: 'scriptspect-readme-release-receipt/v1',
  repository: 'https://github.com/Tom409114/scriptspect',
  intentCheckRunId: 123456789,
  finalVerificationAssetId: 234567890,
  finalVerificationDigest: 'ad725d63c2f5b3b5776f91b3c15695417d1d35d78ccaaecc534e266354cf5fe6',
  publishRunId: 345678901,
  finalVerification,
} as const;

const normalizedReceipt = {
  schemaVersion: 'scriptspect-readme-release-receipt/v1',
  repository: 'https://github.com/Tom409114/scriptspect',
  intentCheckRunId: 123456789,
  finalVerificationAssetId: 234567890,
  finalVerificationDigest: 'ad725d63c2f5b3b5776f91b3c15695417d1d35d78ccaaecc534e266354cf5fe6',
  publishRunId: 345678901,
  finalVerification: {
    schemaVersion: 'scriptspect-final-verification/v1',
    intentId: `scriptspect-release-intent:66:${sourceCommit}`,
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
  },
} as const;

const publishedStatus = {
  schemaVersion: 1,
  releaseState: 'published',
  packageName: 'scriptspect',
  packageVersion: '0.1.0',
  sourceCommit,
  nodeMajor: 22,
  repository: 'https://github.com/Tom409114/scriptspect',
  releaseEvidence: {
    receiptPath: 'validation/releases/v0.1.0/readme-release-receipt.json',
    digest: '2a2a6a43426e639aa6ce022b6662db48e61f072481f3209feb04dc44db3a910f',
  },
} as const;

const manualFinalizationReceipt = {
  schemaVersion: 'scriptspect-readme-manual-finalization-receipt/v1',
  repository: 'https://github.com/Tom409114/scriptspect',
  packageName: 'scriptspect',
  version: '0.1.2',
  tag: 'v0.1.2',
  commit: '6f439bb974b297d5a334cebe989b4b50d7483677',
  releaseId: 384192380,
  publishRunId: 34139934545,
  finalizationRunId: 34140851653,
  finalizationWorkflowPath: '.github/workflows/finalize-published-0.1.2.yml',
  registryNpmSRI:
    'sha512-YY8+I8Xg0oZ9oFqV+UCkKmzShj3gW/xmrDMFuUpxXAgZs08c6XrKfg3RA+Oea3htSJ6CF1w/05dlyoK2AH5k+A==',
  assets: [
    {
      name: 'scriptspect-0.1.2.tgz',
      assetId: 549013932,
      sha256: '09a7a71fa966849903b30b1f8a67cbee8727cc2a8a34807f96c8868990c2e14b',
    },
    {
      name: 'SHA256SUMS',
      assetId: 549013970,
      sha256: 'be1f2a2c66a60296809753e7f2224992fee6773ea56ee8d2f419d6baf118de52',
    },
    {
      name: 'candidate-manifest.json',
      assetId: 549014023,
      sha256: 'aa6222faa7813de626d1cfa4273a98dc5cd5e4565e0ad685db4b8193688597df',
    },
    {
      name: 'release-manifest.json',
      assetId: 549014080,
      sha256: '6e97080bcc9a51c2495b52d1a32dae929870bca3995b44b16520106827c003ae',
    },
  ],
  aliases: [
    { name: 'v0.1', target: '6f439bb974b297d5a334cebe989b4b50d7483677' },
    { name: 'v0', target: '6f439bb974b297d5a334cebe989b4b50d7483677' },
  ],
} as const;

describe('README release receipt', () => {
  it('accepts a truthful manual-finalization receipt without terminal-state fields', () => {
    expect(validateReadmeReleaseReceipt(manualFinalizationReceipt)).toEqual(
      manualFinalizationReceipt,
    );
  });

  it('rejects manual-finalization evidence for any workflow except the protected recovery workflow', () => {
    expect(() =>
      validateReadmeReleaseReceipt({
        ...manualFinalizationReceipt,
        finalizationWorkflowPath: '.github/workflows/other.yml',
      }),
    ).toThrow(/finalizationWorkflowPath/u);
  });

  it('rejects manual-finalization evidence that names another historical run', () => {
    expect(() =>
      validateReadmeReleaseReceipt({
        ...manualFinalizationReceipt,
        publishRunId: manualFinalizationReceipt.publishRunId + 1,
      }),
    ).toThrow(/publishRunId/u);
    expect(() =>
      validateReadmeReleaseReceipt({
        ...manualFinalizationReceipt,
        finalizationRunId: manualFinalizationReceipt.finalizationRunId + 1,
      }),
    ).toThrow(/finalizationRunId/u);
  });

  it('binds manual-finalization evidence to published README status', () => {
    const status = {
      ...publishedStatus,
      packageVersion: manualFinalizationReceipt.version,
      sourceCommit: manualFinalizationReceipt.commit,
      releaseEvidence: {
        ...publishedStatus.releaseEvidence,
        digest: '91fc809d5144da268dec42218b4119ec762ace65500d68e27da99f3ee22fc0ce',
      },
    };
    expect(validateReceiptAgainstStatus(manualFinalizationReceipt, status)).toEqual(
      manualFinalizationReceipt,
    );
  });

  it('validates and normalizes an exact receipt', () => {
    expect(validateReadmeReleaseReceipt(validReceipt)).toEqual(normalizedReceipt);
  });

  it('rejects missing and unexpected receipt keys', () => {
    expect(() => validateReadmeReleaseReceipt({ ...validReceipt, unexpected: true })).toThrow(
      /exact keys/u,
    );

    const { publishRunId: _publishRunId, ...missingPublishRun } = validReceipt;
    expect(() => validateReadmeReleaseReceipt(missingPublishRun)).toThrow(/exact keys/u);
  });

  it('rejects the wrong schema, repository, or non-positive identifiers', () => {
    const cases: Array<[unknown, RegExp]> = [
      [
        { ...validReceipt, schemaVersion: 'scriptspect-readme-release-receipt/v2' },
        /schemaVersion/u,
      ],
      [{ ...validReceipt, repository: 'https://github.com/someone/else' }, /repository/u],
      [{ ...validReceipt, intentCheckRunId: 0 }, /intentCheckRunId/u],
      [{ ...validReceipt, intentCheckRunId: Number.MAX_SAFE_INTEGER + 1 }, /intentCheckRunId/u],
      [{ ...validReceipt, finalVerificationAssetId: -1 }, /finalVerificationAssetId/u],
      [{ ...validReceipt, publishRunId: 1.5 }, /publishRunId/u],
      [{ ...validReceipt, publishRunId: Number.MAX_SAFE_INTEGER + 1 }, /publishRunId/u],
    ];

    for (const [receipt, message] of cases) {
      expect(() => validateReadmeReleaseReceipt(receipt)).toThrow(message);
    }
  });

  it('requires the recorded SHA-256 to match the normalized final verification', () => {
    expect(() =>
      validateReadmeReleaseReceipt({ ...validReceipt, finalVerificationDigest: 'not-a-sha256' }),
    ).toThrow(/finalVerificationDigest/u);
    expect(() =>
      validateReadmeReleaseReceipt({ ...validReceipt, finalVerificationDigest: 'd'.repeat(64) }),
    ).toThrow(/does not match/u);
  });

  it('cross-checks a published status and returns the normalized receipt', () => {
    expect(validateReceiptAgainstStatus(validReceipt, publishedStatus)).toEqual(normalizedReceipt);
  });

  it('rejects a receipt while the homepage remains pre-release', () => {
    expect(() =>
      validateReceiptAgainstStatus(validReceipt, {
        ...publishedStatus,
        releaseState: 'pre-release',
      }),
    ).toThrow(/pre-release/u);
  });

  it('rejects published status fields that disagree with the receipt', () => {
    const cases: Array<[unknown, RegExp]> = [
      [{ ...publishedStatus, packageName: 'someone-else' }, /packageName/u],
      [{ ...publishedStatus, packageVersion: '0.2.0' }, /packageVersion/u],
      [{ ...publishedStatus, sourceCommit: 'd'.repeat(40) }, /sourceCommit/u],
      [{ ...publishedStatus, repository: 'https://github.com/someone/else' }, /repository/u],
      [{ ...publishedStatus, releaseEvidence: undefined }, /releaseEvidence/u],
      [
        {
          ...publishedStatus,
          releaseEvidence: { ...publishedStatus.releaseEvidence, unexpected: true },
        },
        /releaseEvidence/u,
      ],
      [
        {
          ...publishedStatus,
          releaseEvidence: { ...publishedStatus.releaseEvidence, receiptPath: '' },
        },
        /receiptPath/u,
      ],
      [
        {
          ...publishedStatus,
          releaseEvidence: {
            ...publishedStatus.releaseEvidence,
            receiptPath: '../outside.json',
          },
        },
        /receiptPath/u,
      ],
      [
        {
          ...publishedStatus,
          releaseEvidence: { ...publishedStatus.releaseEvidence, digest: 'e'.repeat(64) },
        },
        /digest/u,
      ],
    ];

    for (const [status, message] of cases) {
      expect(() => validateReceiptAgainstStatus(validReceipt, status)).toThrow(message);
    }
  });
});
