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

describe('README release receipt', () => {
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
