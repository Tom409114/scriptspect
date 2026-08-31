export type ReleaseIntent = {
  schemaVersion: 'scriptspect-release-intent/v1';
  intentId: string;
  prNumber: number;
  mergeCommitSha: string;
  version: string;
  tag: string;
  packageManifestHash: string;
  changelogHash: string;
  releasePleaseManifestHash: string;
  releasePrActor?: string;
  releasePrHead?: string;
  releasePrHeadRepo?: string;
  releasePrHeadSha?: string;
};

export type ReleaseAsset = { name: string; assetId: number; sha256: string };
export type RetainedCandidate = {
  runId: number;
  artifactId: number;
  artifactDigest: string;
  candidateManifestDigest: string;
  npmSRI: string;
};
export type StagedDraft = {
  releaseId: number;
  assets: ReleaseAsset[];
  releaseManifestDigest: string;
};
export type NpmPublished = { publishedVersion: string; npmSRI: string; publishRunId: number };
export type NpmVerified = {
  registryNpmSRI: string;
  registryManifestDigest: string;
  provenanceDigest: string;
};
export type AliasPlan = {
  version: string;
  commit: string;
  aliases: Array<{ name: string; previousTarget: string | null; target: string }>;
};
export type AliasesVerified = {
  aliases: Array<{ name: string; previousTarget: string | null; target: string }>;
};
export type FinalPlanned = { finalVerificationDigest: string };
export type Consumed = { finalVerificationDigest: string; finalVerificationAssetId: number };

export type IntentRecordedState = {
  schemaVersion: 'scriptspect-release-state/v1';
  revision: number;
  state: 'intent-recorded';
  intent: ReleaseIntent;
};
export type RetainedCandidateState = Omit<IntentRecordedState, 'state'> & {
  state: 'retained-candidate';
  retainedCandidate: RetainedCandidate;
};
export type StagedDraftState = Omit<RetainedCandidateState, 'state'> & {
  state: 'staged-draft';
  stagedDraft: StagedDraft;
};
export type NpmPublishedState = Omit<StagedDraftState, 'state'> & {
  state: 'npm-published';
  npmPublished: NpmPublished;
};
export type NpmVerifiedState = Omit<NpmPublishedState, 'state'> & {
  state: 'npm-verified';
  npmVerified: NpmVerified;
};
export type AliasPlannedState = Omit<NpmVerifiedState, 'state'> & {
  state: 'alias-planned';
  aliasPlan: AliasPlan;
};
export type AliasesVerifiedState = Omit<AliasPlannedState, 'state'> & {
  state: 'aliases-verified';
  aliasesVerified: AliasesVerified;
};
export type FinalPlannedState = Omit<AliasesVerifiedState, 'state'> & {
  state: 'final-planned';
  finalPlanned: FinalPlanned;
};
export type ConsumedState = Omit<FinalPlannedState, 'state'> & {
  state: 'consumed';
  consumed: Consumed;
};

export type ReleaseState =
  | IntentRecordedState
  | RetainedCandidateState
  | StagedDraftState
  | NpmPublishedState
  | NpmVerifiedState
  | AliasPlannedState
  | AliasesVerifiedState
  | FinalPlannedState
  | ConsumedState;

export type CandidateManifest = {
  schemaVersion: 'scriptspect-candidate-manifest/v1';
  intent: ReleaseIntent;
  version: string;
  tag: string;
  commit: string;
  tarball: { name: string; sha256: string; npmSRI: string };
  build: { node: string; npm: string; pnpm: string };
  workflow: { runId: number; runAttempt: number; runUrl: string };
};

export type ReleaseManifest = {
  schemaVersion: 'scriptspect-release-manifest/v1';
  intentId: string;
  version: string;
  tag: string;
  commit: string;
  releaseId: number;
  candidateManifestDigest: string;
  assets: ReleaseAsset[];
};

export type FinalVerification = {
  schemaVersion: 'scriptspect-final-verification/v1';
  intentId: string;
  version: string;
  tag: string;
  commit: string;
  releaseId: number;
  candidateManifestDigest: string;
  releaseManifestDigest: string;
  candidateNpmSRI: string;
  registryNpmSRI: string;
  provenanceDigest: string;
  aliases: Array<{ name: string; target: string }>;
};

export function validateReleaseIntent(value: unknown): ReleaseIntent;
export function createReleaseState(value: unknown): IntentRecordedState;
export function validateReleaseState(value: unknown): ReleaseState;
export function transitionReleaseState(value: unknown, transition: unknown): ReleaseState;
export function compareAndUpdateReleaseState(current: unknown, proposed: unknown): ReleaseState;
export function planFloatingAliases(value: unknown): {
  version: string;
  commit: string;
  aliases: Array<{ name: string; previousTarget: string | null; target: string }>;
};
export function decideLatestPromotion(value: unknown): {
  action: 'promote' | 'retain';
  version: string;
};
export function decideAliasRollback(
  value: unknown,
): { action: 'restore'; target: string } | { action: 'delete'; target: null };
export function validateReleaseAnchors(value: unknown, expected: unknown): ReleaseState;
export function canonicalJsonDigest(value: unknown): string;
export function validateCandidateManifest(value: unknown): CandidateManifest;
export function validateReleaseManifest(value: unknown, candidate: unknown): ReleaseManifest;
export function decideReleaseRecovery(
  value: unknown,
):
  | { action: 'create-tag-and-draft' | 'create-draft' | 'resume'; reason: string }
  | { action: 'restore-assets'; reason: string; missingAssets: string[] }
  | { action: 'manual-recovery' | 'new-version-required'; reason: string };
export function verifyPublishAnchors(value: unknown): {
  releaseId: number;
  assetId: number;
  assetName: string;
  sha256: string;
  npmSRI: string;
};
export function verifyPublishedRelease(value: unknown): {
  releaseId: number;
  tag: string;
  commit: string;
  assets: ReleaseAsset[];
};
export function verifyReleaseSnapshot(value: unknown): {
  releaseId: number;
  tag: string;
  commit: string;
  draft: boolean;
  assets: ReleaseAsset[];
};
export function decideFinalEvidenceRollback(
  value: unknown,
):
  | { action: 'none' }
  | { action: 'delete'; assetId: number; sha256: string }
  | { action: 'retain'; assetId: number; sha256: string };
export function verifyFinalIdempotency(
  existing: unknown,
  proposed: unknown,
): { decision: 'write' | 'reuse'; verification: FinalVerification };
export function selectExactCiRun(
  runs: unknown,
  expected: unknown,
): { id: number; runNumber: number; runAttempt: number; url: string; sha: string };
