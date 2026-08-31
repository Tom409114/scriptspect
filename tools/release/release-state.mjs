import {
  deepEqual,
  emitJson,
  isMain,
  jsonDigest,
  parseOutputOption,
  ReleaseToolError,
  readJson,
  requireCommitSha,
  requireExactKeys,
  requireNpmSri,
  requireObject,
  requirePositiveInteger,
  requireSha256,
  requireString,
  runCli,
} from './shared.mjs';

const semverPattern =
  /^(0|[1-9]\d*)\.(0|[1-9]\d*)\.(0|[1-9]\d*)(?:-(?:(?:0|[1-9]\d*)|(?:\d*[A-Za-z-][0-9A-Za-z-]*))(?:\.(?:(?:0|[1-9]\d*)|(?:\d*[A-Za-z-][0-9A-Za-z-]*)))*)?(?:\+[0-9A-Za-z-]+(?:\.[0-9A-Za-z-]+)*)?$/u;

const stateOrder = [
  'intent-recorded',
  'retained-candidate',
  'staged-draft',
  'npm-published',
  'npm-verified',
  'aliases-verified',
  'consumed',
];

const stateField = {
  'retained-candidate': 'retainedCandidate',
  'staged-draft': 'stagedDraft',
  'npm-published': 'npmPublished',
  'npm-verified': 'npmVerified',
  'aliases-verified': 'aliasesVerified',
  consumed: 'consumed',
};

function requireArray(value, label) {
  if (!Array.isArray(value)) {
    throw new ReleaseToolError(`${label} must be an array`);
  }
  return value;
}

function requireNullableCommit(value, label) {
  if (value === null) return null;
  return requireCommitSha(value, label);
}

function requireSemver(value, label) {
  return requireString(value, label, semverPattern);
}

function requireStableSemver(value, label) {
  return requireString(value, label, /^(0|[1-9]\d*)\.(0|[1-9]\d*)\.(0|[1-9]\d*)$/u);
}

function requireRevision(value, label) {
  if (!Number.isSafeInteger(value) || value < 0) {
    throw new ReleaseToolError(`${label} must be a non-negative safe integer`);
  }
  return value;
}

function requireNodeVersion(value, label) {
  const text = requireString(value, label);
  requireSemver(text.startsWith('v') ? text.slice(1) : text, label);
  return text;
}

function requireHttpsUrl(value, label) {
  const text = requireString(value, label);
  let url;
  try {
    url = new URL(text);
  } catch {
    throw new ReleaseToolError(`${label} must be an HTTPS URL`);
  }
  if (url.protocol !== 'https:' || url.username || url.password) {
    throw new ReleaseToolError(`${label} must be an HTTPS URL without credentials`);
  }
  return text;
}

function assertEqual(actual, expected, label) {
  if (!deepEqual(actual, expected)) {
    throw new ReleaseToolError(`${label} conflict`);
  }
}

function assertAssetSetEqual(actual, expected, label) {
  const byName = (assets) =>
    [...assets].sort((left, right) =>
      left.name < right.name ? -1 : left.name > right.name ? 1 : 0,
    );
  assertEqual(byName(actual), byName(expected), label);
}

function validateAssets(value, label) {
  const assets = requireArray(value, label).map((input, index) => {
    const asset = requireExactKeys(input, `${label}[${index}]`, ['name', 'assetId', 'sha256']);
    const name = requireString(asset.name, `${label}[${index}].name`, /^[A-Za-z0-9._-]+$/u);
    return {
      name,
      assetId: requirePositiveInteger(asset.assetId, `${label}[${index}].assetId`),
      sha256: requireSha256(asset.sha256, `${label}[${index}].sha256`),
    };
  });
  if (new Set(assets.map((asset) => asset.name)).size !== assets.length) {
    throw new ReleaseToolError(`${label} contains duplicate asset names`);
  }
  if (new Set(assets.map((asset) => asset.assetId)).size !== assets.length) {
    throw new ReleaseToolError(`${label} contains duplicate asset IDs`);
  }
  return assets;
}

function validateRetainedCandidate(value) {
  const candidate = requireExactKeys(value, 'retained candidate', [
    'runId',
    'artifactId',
    'artifactDigest',
    'candidateManifestDigest',
    'npmSRI',
  ]);
  return {
    runId: requirePositiveInteger(candidate.runId, 'retained candidate runId'),
    artifactId: requirePositiveInteger(candidate.artifactId, 'retained candidate artifactId'),
    artifactDigest: requireSha256(candidate.artifactDigest, 'retained candidate artifactDigest'),
    candidateManifestDigest: requireSha256(
      candidate.candidateManifestDigest,
      'retained candidate candidateManifestDigest',
    ),
    npmSRI: requireNpmSri(candidate.npmSRI, 'retained candidate npmSRI'),
  };
}

function validateStagedDraft(value) {
  const draft = requireExactKeys(value, 'staged draft', [
    'releaseId',
    'assets',
    'releaseManifestDigest',
  ]);
  return {
    releaseId: requirePositiveInteger(draft.releaseId, 'staged draft releaseId'),
    assets: validateAssets(draft.assets, 'staged draft assets'),
    releaseManifestDigest: requireSha256(
      draft.releaseManifestDigest,
      'staged draft releaseManifestDigest',
    ),
  };
}

function validateNpmVerified(value) {
  const verified = requireExactKeys(value, 'npm verification', [
    'registryNpmSRI',
    'registryManifestDigest',
    'provenanceDigest',
  ]);
  return {
    registryNpmSRI: requireNpmSri(verified.registryNpmSRI, 'npm verification registryNpmSRI'),
    registryManifestDigest: requireSha256(
      verified.registryManifestDigest,
      'npm verification registryManifestDigest',
    ),
    provenanceDigest: requireSha256(verified.provenanceDigest, 'npm verification provenanceDigest'),
  };
}

function validateNpmPublished(value, state) {
  const published = requireExactKeys(value, 'npm publication', [
    'publishedVersion',
    'npmSRI',
    'publishRunId',
  ]);
  const result = {
    publishedVersion: requireSemver(published.publishedVersion, 'npm publication publishedVersion'),
    npmSRI: requireNpmSri(published.npmSRI, 'npm publication npmSRI'),
    publishRunId: requirePositiveInteger(published.publishRunId, 'npm publication publishRunId'),
  };
  assertEqual(result.publishedVersion, state.intent.version, 'npm publication version');
  assertEqual(result.npmSRI, state.retainedCandidate.npmSRI, 'npm publication npmSRI');
  return result;
}

function aliasNamesForVersion(version) {
  const [major, minor] = requireStableSemver(version, 'alias version').split('.');
  return [`v${major}.${minor}`, `v${major}`];
}

function validateAliasesVerified(value, expectedCommit, version) {
  const expectedNames = aliasNamesForVersion(version);
  const verified = requireExactKeys(value, 'alias verification', ['aliases']);
  const aliases = requireArray(verified.aliases, 'alias verification aliases').map(
    (input, index) => {
      const alias = requireExactKeys(input, `alias verification aliases[${index}]`, [
        'name',
        'previousTarget',
        'target',
      ]);
      if (!expectedNames.includes(alias.name)) {
        throw new ReleaseToolError(`alias verification aliases[${index}].name is not allowed`);
      }
      const target = requireCommitSha(alias.target, `alias verification aliases[${index}].target`);
      assertEqual(target, expectedCommit, `alias verification ${alias.name} target`);
      return {
        name: alias.name,
        previousTarget: requireNullableCommit(
          alias.previousTarget,
          `alias verification aliases[${index}].previousTarget`,
        ),
        target,
      };
    },
  );
  if (
    aliases.length !== 2 ||
    !expectedNames.every((name) => aliases.some((alias) => alias.name === name))
  ) {
    throw new ReleaseToolError(`alias verification must contain ${expectedNames.join(' and ')}`);
  }
  return { aliases };
}

function validateConsumed(value) {
  const consumed = requireExactKeys(value, 'consumed transition', ['finalVerificationDigest']);
  return {
    finalVerificationDigest: requireSha256(
      consumed.finalVerificationDigest,
      'consumed finalVerificationDigest',
    ),
  };
}

export function validateReleaseIntent(value) {
  const input = requireExactKeys(
    value,
    'release intent',
    [
      'schemaVersion',
      'intentId',
      'prNumber',
      'mergeCommitSha',
      'version',
      'tag',
      'packageManifestHash',
      'changelogHash',
      'releasePleaseManifestHash',
    ],
    ['releasePrActor', 'releasePrHead', 'releasePrHeadRepo', 'releasePrHeadSha'],
  );
  if (input.schemaVersion !== 'scriptspect-release-intent/v1') {
    throw new ReleaseToolError('release intent schemaVersion is unsupported');
  }
  const version = requireSemver(input.version, 'release intent version');
  const tag = requireString(input.tag, 'release intent tag');
  if (tag !== `v${version}`) {
    throw new ReleaseToolError('release intent tag must equal v plus version');
  }
  const result = {
    schemaVersion: input.schemaVersion,
    intentId: requireString(input.intentId, 'release intent intentId', /^[A-Za-z0-9:._-]+$/u),
    prNumber: requirePositiveInteger(input.prNumber, 'release intent prNumber'),
    mergeCommitSha: requireCommitSha(input.mergeCommitSha, 'release intent mergeCommitSha'),
    version,
    tag,
    packageManifestHash: requireSha256(
      input.packageManifestHash,
      'release intent packageManifestHash',
    ),
    changelogHash: requireSha256(input.changelogHash, 'release intent changelogHash'),
    releasePleaseManifestHash: requireSha256(
      input.releasePleaseManifestHash,
      'release intent releasePleaseManifestHash',
    ),
  };
  if (input.releasePrActor !== undefined) {
    result.releasePrActor = requireString(
      input.releasePrActor,
      'release intent releasePrActor',
      /^[A-Za-z0-9](?:[A-Za-z0-9-]{0,37}[A-Za-z0-9])?(?:\[bot\])?$/u,
    );
  }
  if (input.releasePrHead !== undefined) {
    const head = requireString(
      input.releasePrHead,
      'release intent releasePrHead',
      /^[A-Za-z0-9._:/-]+$/u,
    );
    if (head.includes('..') || head.startsWith('/') || head.endsWith('/')) {
      throw new ReleaseToolError('release intent releasePrHead has an invalid format');
    }
    result.releasePrHead = head;
  }
  if (input.releasePrHeadRepo !== undefined) {
    const headRepo = requireString(
      input.releasePrHeadRepo,
      'release intent head repo',
      /^[A-Za-z0-9_.-]+\/[A-Za-z0-9_.-]+$/u,
    );
    if (headRepo !== 'Tom409114/scriptspect') {
      throw new ReleaseToolError('release intent head repo must be Tom409114/scriptspect');
    }
    result.releasePrHeadRepo = headRepo;
  }
  if (input.releasePrHeadSha !== undefined) {
    result.releasePrHeadSha = requireCommitSha(
      input.releasePrHeadSha,
      'release intent releasePrHeadSha',
    );
  }
  if (
    input.releasePrActor === undefined ||
    input.releasePrHead === undefined ||
    input.releasePrHeadRepo === undefined ||
    input.releasePrHeadSha === undefined
  ) {
    throw new ReleaseToolError(
      'release intent must persist exact release PR actor/head repo/head SHA',
    );
  }
  return result;
}

export function createReleaseState(input) {
  return {
    schemaVersion: 'scriptspect-release-state/v1',
    revision: 0,
    state: 'intent-recorded',
    intent: validateReleaseIntent(input),
  };
}

export function validateReleaseState(value) {
  const raw = requireObject(value, 'release state');
  if (raw.schemaVersion !== 'scriptspect-release-state/v1') {
    throw new ReleaseToolError('release state schemaVersion is unsupported');
  }
  const state = requireString(raw.state, 'release state state');
  const rank = stateOrder.indexOf(state);
  if (rank < 0) throw new ReleaseToolError('release state state is unsupported');
  const required = ['schemaVersion', 'revision', 'state', 'intent'];
  for (let index = 1; index <= rank; index += 1) {
    required.push(stateField[stateOrder[index]]);
  }
  requireExactKeys(raw, 'release state', required);
  const intent = validateReleaseIntent(raw.intent);
  const result = {
    schemaVersion: raw.schemaVersion,
    revision: requireRevision(raw.revision, 'release state revision'),
    state,
    intent,
  };
  if (rank >= 1) result.retainedCandidate = validateRetainedCandidate(raw.retainedCandidate);
  if (rank >= 2) result.stagedDraft = validateStagedDraft(raw.stagedDraft);
  if (rank >= 3) result.npmPublished = validateNpmPublished(raw.npmPublished, result);
  if (rank >= 4) {
    result.npmVerified = validateNpmVerified(raw.npmVerified);
  }
  if (rank >= 5) {
    result.aliasesVerified = validateAliasesVerified(
      raw.aliasesVerified,
      intent.mergeCommitSha,
      intent.version,
    );
  }
  if (rank >= 6) result.consumed = validateConsumed(raw.consumed);
  return result;
}

function validateTransitionPayload(target, payload, state) {
  switch (target) {
    case 'retained-candidate':
      return validateRetainedCandidate(payload);
    case 'staged-draft':
      return validateStagedDraft(payload);
    case 'npm-published':
      return validateNpmPublished(payload, state);
    case 'npm-verified':
      return validateNpmVerified(payload);
    case 'aliases-verified':
      return validateAliasesVerified(payload, state.intent.mergeCommitSha, state.intent.version);
    case 'consumed':
      return validateConsumed(payload);
    default:
      throw new ReleaseToolError('transition target is unsupported');
  }
}

export function transitionReleaseState(value, transitionValue) {
  const current = validateReleaseState(value);
  const transition = requireExactKeys(transitionValue, 'release transition', ['to', 'payload']);
  const target = requireString(transition.to, 'release transition to');
  const targetRank = stateOrder.indexOf(target);
  if (targetRank <= 0) throw new ReleaseToolError('transition target is unsupported');
  const currentRank = stateOrder.indexOf(current.state);
  const payload = validateTransitionPayload(target, transition.payload, current);
  const field = stateField[target];
  if (targetRank <= currentRank) {
    if (!deepEqual(current[field], payload)) {
      throw new ReleaseToolError(`${target} idempotency conflict`);
    }
    return current;
  }
  if (targetRank !== currentRank + 1) {
    throw new ReleaseToolError(`invalid transition from ${current.state} to ${target}`);
  }
  return validateReleaseState({
    ...current,
    revision: current.revision + 1,
    state: target,
    [field]: payload,
  });
}

export function compareAndUpdateReleaseState(currentValue, proposedValue) {
  const current = validateReleaseState(currentValue);
  const proposedRaw = requireObject(proposedValue, 'proposed release state');
  const proposedRevision = requireRevision(proposedRaw.revision, 'proposed release state revision');
  if (proposedRevision < current.revision) {
    throw new ReleaseToolError(
      `stale state revision ${proposedRevision}; current revision is ${current.revision}`,
    );
  }
  const proposedRank = stateOrder.indexOf(proposedRaw.state);
  const currentRank = stateOrder.indexOf(current.state);
  if (proposedRank < currentRank) {
    throw new ReleaseToolError(
      `state regression from ${current.state} to ${String(proposedRaw.state)}`,
    );
  }
  const proposed = validateReleaseState(proposedRaw);
  assertEqual(proposed.intent, current.intent, 'release intent');
  if (proposedRevision === current.revision) {
    if (!deepEqual(current, proposed)) {
      throw new ReleaseToolError('stale writer conflicts at the current revision');
    }
    return current;
  }
  if (proposedRevision !== current.revision + 1 || proposedRank !== currentRank + 1) {
    throw new ReleaseToolError('proposed state must be the exact next revision and state');
  }
  for (let index = 1; index <= currentRank; index += 1) {
    const field = stateField[stateOrder[index]];
    assertEqual(proposed[field], current[field], `${field} durable anchor`);
  }
  return proposed;
}

function compareStableSemver(left, right) {
  const leftParts = requireStableSemver(left, 'current alias version').split('.').map(Number);
  const rightParts = requireStableSemver(right, 'candidate alias version').split('.').map(Number);
  for (let index = 0; index < 3; index += 1) {
    if (leftParts[index] !== rightParts[index]) return leftParts[index] - rightParts[index];
  }
  return 0;
}

export function planFloatingAliases(value) {
  const input = requireExactKeys(value, 'floating alias plan', ['version', 'commit', 'current']);
  const version = requireStableSemver(input.version, 'candidate alias version');
  const commit = requireCommitSha(input.commit, 'candidate alias commit');
  const [major, minor] = version.split('.');
  const names = [`v${major}.${minor}`, `v${major}`];
  const current = requireArray(input.current, 'current aliases');
  if (current.length !== 2) throw new ReleaseToolError('current aliases must contain two entries');
  const aliases = names.map((name) => {
    const matches = current.filter((entry) => requireObject(entry, 'current alias').name === name);
    if (matches.length !== 1)
      throw new ReleaseToolError(`current alias ${name} must appear exactly once`);
    const entry = requireExactKeys(matches[0], `current alias ${name}`, [
      'name',
      'target',
      'version',
      'ancestor',
    ]);
    const target = entry.target === null ? null : requireCommitSha(entry.target, `${name} target`);
    const currentVersion =
      entry.version === null ? null : requireStableSemver(entry.version, `${name} version`);
    if (target !== null && target !== commit) {
      if (currentVersion === null) {
        throw new ReleaseToolError(`${name} existing target has no semver anchor`);
      }
      if (compareStableSemver(currentVersion, version) > 0) {
        throw new ReleaseToolError(`${name} semver downgrade from ${currentVersion} to ${version}`);
      }
      if (entry.ancestor !== true) {
        throw new ReleaseToolError(`${name} ancestry guard rejected an unrelated target`);
      }
    }
    return { name, previousTarget: target, target: commit };
  });
  return { version, commit, aliases };
}

export function decideAliasRollback(value) {
  const input = requireExactKeys(value, 'alias rollback', ['current', 'candidate', 'previous']);
  const current = requireCommitSha(input.current, 'alias rollback current');
  const candidate = requireCommitSha(input.candidate, 'alias rollback candidate');
  const previous = requireNullableCommit(input.previous, 'alias rollback previous');
  if (current !== candidate) throw new ReleaseToolError('alias rollback CAS conflict');
  if (previous === null) return { action: 'retain', target: candidate };
  return { action: 'restore', target: previous };
}

export function validateReleaseAnchors(value, expectedValue) {
  const state = validateReleaseState(value);
  const expected = requireExactKeys(
    expectedValue,
    'expected release anchors',
    [],
    [
      'intentId',
      'mergeCommitSha',
      'version',
      'tag',
      'artifactDigest',
      'candidateManifestDigest',
      'releaseId',
      'releaseManifestDigest',
      'assets',
    ],
  );
  const actual = {
    intentId: state.intent.intentId,
    mergeCommitSha: state.intent.mergeCommitSha,
    version: state.intent.version,
    tag: state.intent.tag,
    artifactDigest: state.retainedCandidate?.artifactDigest,
    candidateManifestDigest: state.retainedCandidate?.candidateManifestDigest,
    releaseId: state.stagedDraft?.releaseId,
    releaseManifestDigest: state.stagedDraft?.releaseManifestDigest,
    assets: state.stagedDraft?.assets,
  };
  for (const [key, expectedValue_] of Object.entries(expected)) {
    if (actual[key] === undefined) {
      throw new ReleaseToolError(`${key} anchor is not present in release state`);
    }
    if (key === 'assets') {
      assertAssetSetEqual(
        actual[key],
        validateAssets(expectedValue_, 'expected anchor assets'),
        `${key} anchor`,
      );
    } else {
      assertEqual(actual[key], expectedValue_, `${key} anchor`);
    }
  }
  return state;
}

export function canonicalJsonDigest(value) {
  return jsonDigest(value);
}

export function validateCandidateManifest(value) {
  const input = requireExactKeys(value, 'candidate manifest', [
    'schemaVersion',
    'intent',
    'version',
    'tag',
    'commit',
    'tarball',
    'build',
    'workflow',
  ]);
  if (input.schemaVersion !== 'scriptspect-candidate-manifest/v1') {
    throw new ReleaseToolError('candidate manifest schemaVersion is unsupported');
  }
  const manifestIntent = validateReleaseIntent(input.intent);
  const version = requireSemver(input.version, 'candidate manifest version');
  const tag = requireString(input.tag, 'candidate manifest tag');
  const manifestCommit = requireCommitSha(input.commit, 'candidate manifest commit');
  assertEqual(version, manifestIntent.version, 'candidate manifest version');
  assertEqual(tag, manifestIntent.tag, 'candidate manifest tag');
  assertEqual(manifestCommit, manifestIntent.mergeCommitSha, 'candidate manifest commit');
  const tarball = requireExactKeys(input.tarball, 'candidate manifest tarball', [
    'name',
    'sha256',
    'npmSRI',
  ]);
  const tarballName = requireString(
    tarball.name,
    'candidate manifest tarball name',
    /^[A-Za-z0-9._-]+\.tgz$/u,
  );
  const build = requireExactKeys(input.build, 'candidate manifest build', ['node', 'npm', 'pnpm']);
  const workflow = requireExactKeys(input.workflow, 'candidate manifest workflow', [
    'runId',
    'runAttempt',
    'runUrl',
  ]);
  return {
    schemaVersion: input.schemaVersion,
    intent: manifestIntent,
    version,
    tag,
    commit: manifestCommit,
    tarball: {
      name: tarballName,
      sha256: requireSha256(tarball.sha256, 'candidate manifest tarball sha256'),
      npmSRI: requireNpmSri(tarball.npmSRI, 'candidate manifest tarball npmSRI'),
    },
    build: {
      node: requireNodeVersion(build.node, 'candidate manifest build node'),
      npm: requireSemver(build.npm, 'candidate manifest build npm'),
      pnpm: requireSemver(build.pnpm, 'candidate manifest build pnpm'),
    },
    workflow: {
      runId: requirePositiveInteger(workflow.runId, 'candidate manifest workflow runId'),
      runAttempt: requirePositiveInteger(
        workflow.runAttempt,
        'candidate manifest workflow runAttempt',
      ),
      runUrl: requireHttpsUrl(workflow.runUrl, 'candidate manifest workflow runUrl'),
    },
  };
}

export function validateReleaseManifest(value, candidateValue) {
  const candidate = validateCandidateManifest(candidateValue);
  const input = requireExactKeys(value, 'release manifest', [
    'schemaVersion',
    'intentId',
    'version',
    'tag',
    'commit',
    'releaseId',
    'candidateManifestDigest',
    'assets',
  ]);
  if (input.schemaVersion !== 'scriptspect-release-manifest/v1') {
    throw new ReleaseToolError('release manifest schemaVersion is unsupported');
  }
  const result = {
    schemaVersion: input.schemaVersion,
    intentId: requireString(input.intentId, 'release manifest intentId'),
    version: requireSemver(input.version, 'release manifest version'),
    tag: requireString(input.tag, 'release manifest tag'),
    commit: requireCommitSha(input.commit, 'release manifest commit'),
    releaseId: requirePositiveInteger(input.releaseId, 'release manifest releaseId'),
    candidateManifestDigest: requireSha256(
      input.candidateManifestDigest,
      'release manifest candidateManifestDigest',
    ),
    assets: validateAssets(input.assets, 'release manifest assets'),
  };
  assertEqual(result.intentId, candidate.intent.intentId, 'release manifest intentId');
  assertEqual(result.version, candidate.version, 'release manifest version');
  assertEqual(result.tag, candidate.tag, 'release manifest tag');
  assertEqual(result.commit, candidate.commit, 'release manifest commit');
  assertEqual(
    result.candidateManifestDigest,
    canonicalJsonDigest(candidate),
    'release manifest candidateManifestDigest',
  );
  const tarball = result.assets.find((asset) => asset.name === candidate.tarball.name);
  if (!tarball) throw new ReleaseToolError('release manifest is missing the tarball asset');
  assertEqual(tarball.sha256, candidate.tarball.sha256, 'release manifest tarball digest');
  const candidateAsset = result.assets.find((asset) => asset.name === 'candidate-manifest.json');
  if (!candidateAsset) {
    throw new ReleaseToolError('release manifest is missing candidate-manifest.json');
  }
  assertEqual(
    candidateAsset.sha256,
    result.candidateManifestDigest,
    'release manifest candidate asset digest',
  );
  if (!result.assets.some((asset) => asset.name === 'SHA256SUMS')) {
    throw new ReleaseToolError('release manifest is missing SHA256SUMS');
  }
  return result;
}

function validateRecoveryExpected(value) {
  const expected = requireExactKeys(value, 'recovery expected anchors', [
    'tag',
    'commit',
    'retainedArtifactDigest',
    'candidateManifestDigest',
    'assets',
  ]);
  return {
    tag: requireString(expected.tag, 'recovery expected tag'),
    commit: requireCommitSha(expected.commit, 'recovery expected commit'),
    retainedArtifactDigest: requireSha256(
      expected.retainedArtifactDigest,
      'recovery expected retainedArtifactDigest',
    ),
    candidateManifestDigest: requireSha256(
      expected.candidateManifestDigest,
      'recovery expected candidateManifestDigest',
    ),
    assets: validateRecoveryExpectedAssets(expected.assets),
  };
}

function validateRecoveryExpectedAssets(value) {
  const assets = requireArray(value, 'recovery expected assets').map((input, index) => {
    const label = `recovery expected assets[${index}]`;
    const asset = requireExactKeys(input, label, ['name', 'sha256'], ['assetId']);
    const result = {
      name: requireString(asset.name, `${label}.name`, /^[A-Za-z0-9._-]+$/u),
      sha256: requireSha256(asset.sha256, `${label}.sha256`),
    };
    if (asset.assetId !== undefined) {
      result.assetId = requirePositiveInteger(asset.assetId, `${label}.assetId`);
    }
    return result;
  });
  if (new Set(assets.map((asset) => asset.name)).size !== assets.length) {
    throw new ReleaseToolError('recovery expected assets contains duplicate asset names');
  }
  const assetIds = assets.map((asset) => asset.assetId).filter((assetId) => assetId !== undefined);
  if (new Set(assetIds).size !== assetIds.length) {
    throw new ReleaseToolError('recovery expected assets contains duplicate asset IDs');
  }
  return assets;
}

function validateObservedTag(value) {
  if (value === null) return null;
  const tag = requireExactKeys(value, 'observed tag', ['commit']);
  return { commit: requireCommitSha(tag.commit, 'observed tag commit') };
}

function validateObservedDraft(value) {
  if (value === null) return null;
  const draft = requireExactKeys(value, 'observed draft', ['releaseId', 'tag', 'commit', 'assets']);
  return {
    releaseId: requirePositiveInteger(draft.releaseId, 'observed draft releaseId'),
    tag: requireString(draft.tag, 'observed draft tag'),
    commit: requireCommitSha(draft.commit, 'observed draft commit'),
    assets: validateAssets(draft.assets, 'observed draft assets'),
  };
}

function validateObservedRetained(value) {
  if (value === null) return null;
  const retained = requireExactKeys(value, 'observed retained candidate', [
    'artifactDigest',
    'candidateManifestDigest',
  ]);
  return {
    artifactDigest: requireSha256(
      retained.artifactDigest,
      'observed retained candidate artifactDigest',
    ),
    candidateManifestDigest: requireSha256(
      retained.candidateManifestDigest,
      'observed retained candidate candidateManifestDigest',
    ),
  };
}

export function decideReleaseRecovery(value) {
  const input = requireExactKeys(value, 'release recovery input', ['expected', 'observed']);
  const expected = validateRecoveryExpected(input.expected);
  const observedInput = requireExactKeys(input.observed, 'release recovery observed', [
    'tag',
    'draft',
    'retainedCandidate',
  ]);
  const observed = {
    tag: validateObservedTag(observedInput.tag),
    draft: validateObservedDraft(observedInput.draft),
    retainedCandidate: validateObservedRetained(observedInput.retainedCandidate),
  };
  if (observed.tag && observed.tag.commit !== expected.commit) {
    return { action: 'manual-recovery', reason: 'tag-commit-conflict' };
  }
  if (!observed.tag && observed.draft) {
    return { action: 'manual-recovery', reason: 'draft-without-tag' };
  }
  if (
    observed.retainedCandidate &&
    (observed.retainedCandidate.artifactDigest !== expected.retainedArtifactDigest ||
      observed.retainedCandidate.candidateManifestDigest !== expected.candidateManifestDigest)
  ) {
    return { action: 'manual-recovery', reason: 'retained-candidate-conflict' };
  }
  if (!observed.tag && !observed.draft) {
    if (!observed.retainedCandidate) {
      return { action: 'new-version-required', reason: 'authoritative-artifact-lost' };
    }
    return { action: 'create-tag-and-draft', reason: 'verified-retained-candidate' };
  }
  if (!observed.draft) {
    if (!observed.retainedCandidate) {
      return { action: 'new-version-required', reason: 'authoritative-artifact-lost' };
    }
    return { action: 'create-draft', reason: 'exact-tag-without-draft' };
  }
  if (observed.draft.tag !== expected.tag || observed.draft.commit !== expected.commit) {
    return { action: 'manual-recovery', reason: 'draft-anchor-conflict' };
  }
  const expectedAssets = new Map(expected.assets.map((asset) => [asset.name, asset]));
  for (const asset of observed.draft.assets) {
    const wanted = expectedAssets.get(asset.name);
    if (
      !wanted ||
      wanted.sha256 !== asset.sha256 ||
      (wanted.assetId !== undefined && wanted.assetId !== asset.assetId)
    ) {
      return { action: 'manual-recovery', reason: 'draft-asset-conflict' };
    }
  }
  const observedNames = new Set(observed.draft.assets.map((asset) => asset.name));
  const missingAssets = expected.assets
    .filter((asset) => !observedNames.has(asset.name))
    .map((asset) => asset.name);
  if (missingAssets.length > 0) {
    if (!observed.retainedCandidate) {
      return { action: 'new-version-required', reason: 'authoritative-artifact-lost' };
    }
    return {
      action: 'restore-assets',
      reason: 'verified-retained-candidate',
      missingAssets,
    };
  }
  return { action: 'resume', reason: 'draft-assets-exact' };
}

export function verifyPublishAnchors(value) {
  const input = requireExactKeys(value, 'publish anchor input', [
    'state',
    'candidate',
    'release',
    'observed',
  ]);
  const state = validateReleaseState(input.state);
  if (stateOrder.indexOf(state.state) < stateOrder.indexOf('staged-draft')) {
    throw new ReleaseToolError('publish requires staged-draft state');
  }
  const candidate = validateCandidateManifest(input.candidate);
  const release = validateReleaseManifest(input.release, candidate);
  assertEqual(state.intent, candidate.intent, 'publish intent');
  assertEqual(
    state.retainedCandidate.candidateManifestDigest,
    canonicalJsonDigest(candidate),
    'publish candidateManifestDigest',
  );
  assertEqual(state.retainedCandidate.npmSRI, candidate.tarball.npmSRI, 'publish npmSRI');
  assertEqual(state.stagedDraft.releaseId, release.releaseId, 'publish releaseId');
  assertAssetSetEqual(state.stagedDraft.assets, release.assets, 'publish release assets');
  assertEqual(
    state.stagedDraft.releaseManifestDigest,
    canonicalJsonDigest(release),
    'publish releaseManifestDigest',
  );
  const observed = requireExactKeys(input.observed, 'observed publish anchors', [
    'tag',
    'release',
    'assets',
  ]);
  const observedTag = requireExactKeys(observed.tag, 'observed publish tag', ['name', 'commit']);
  if (observedTag.name !== candidate.tag || observedTag.commit !== candidate.commit) {
    throw new ReleaseToolError('publish tag anchor conflict');
  }
  const observedRelease = requireExactKeys(observed.release, 'observed publish release', [
    'releaseId',
    'tag',
    'commit',
    'draft',
  ]);
  const releaseMayBePublished =
    stateOrder.indexOf(state.state) >= stateOrder.indexOf('npm-verified');
  const draftStateIsValid = releaseMayBePublished
    ? typeof observedRelease.draft === 'boolean'
    : observedRelease.draft === true;
  if (
    observedRelease.releaseId !== release.releaseId ||
    observedRelease.tag !== release.tag ||
    observedRelease.commit !== release.commit ||
    !draftStateIsValid
  ) {
    throw new ReleaseToolError('publish release anchor conflict');
  }
  const observedAssets = validateAssets(observed.assets, 'observed publish assets');
  assertAssetSetEqual(observedAssets, release.assets, 'publish asset anchors');
  const tarball = release.assets.find((asset) => asset.name === candidate.tarball.name);
  return {
    releaseId: release.releaseId,
    assetId: tarball.assetId,
    assetName: tarball.name,
    sha256: tarball.sha256,
    npmSRI: candidate.tarball.npmSRI,
  };
}

function validateFinalVerification(value) {
  const input = requireExactKeys(value, 'final verification', [
    'schemaVersion',
    'intentId',
    'version',
    'tag',
    'commit',
    'releaseId',
    'candidateManifestDigest',
    'releaseManifestDigest',
    'candidateNpmSRI',
    'registryNpmSRI',
    'provenanceDigest',
    'aliases',
  ]);
  if (input.schemaVersion !== 'scriptspect-final-verification/v1') {
    throw new ReleaseToolError('final verification schemaVersion is unsupported');
  }
  const version = requireSemver(input.version, 'final verification version');
  const tag = requireString(input.tag, 'final verification tag');
  if (tag !== `v${version}`) {
    throw new ReleaseToolError('final verification tag must equal v plus version');
  }
  const finalCommit = requireCommitSha(input.commit, 'final verification commit');
  const expectedAliasNames = aliasNamesForVersion(version);
  const aliases = requireArray(input.aliases, 'final verification aliases').map((entry, index) => {
    const alias = requireExactKeys(entry, `final verification aliases[${index}]`, [
      'name',
      'target',
    ]);
    if (!expectedAliasNames.includes(alias.name)) {
      throw new ReleaseToolError(`final verification aliases[${index}].name is not allowed`);
    }
    const target = requireCommitSha(alias.target, `final verification aliases[${index}].target`);
    assertEqual(target, finalCommit, `final verification ${alias.name} target`);
    return { name: alias.name, target };
  });
  if (
    aliases.length !== 2 ||
    !expectedAliasNames.every((name) => aliases.some((alias) => alias.name === name))
  ) {
    throw new ReleaseToolError(
      `final verification must contain ${expectedAliasNames.join(' and ')}`,
    );
  }
  return {
    schemaVersion: input.schemaVersion,
    intentId: requireString(input.intentId, 'final verification intentId'),
    version,
    tag,
    commit: finalCommit,
    releaseId: requirePositiveInteger(input.releaseId, 'final verification releaseId'),
    candidateManifestDigest: requireSha256(
      input.candidateManifestDigest,
      'final verification candidateManifestDigest',
    ),
    releaseManifestDigest: requireSha256(
      input.releaseManifestDigest,
      'final verification releaseManifestDigest',
    ),
    candidateNpmSRI: requireNpmSri(input.candidateNpmSRI, 'final verification candidateNpmSRI'),
    registryNpmSRI: requireNpmSri(input.registryNpmSRI, 'final verification registryNpmSRI'),
    provenanceDigest: requireSha256(input.provenanceDigest, 'final verification provenanceDigest'),
    aliases,
  };
}

export function verifyFinalIdempotency(existingValue, proposedValue) {
  const proposed = validateFinalVerification(proposedValue);
  if (existingValue === null) return { decision: 'write', verification: proposed };
  const existing = validateFinalVerification(existingValue);
  if (!deepEqual(existing, proposed)) {
    throw new ReleaseToolError('final verification conflict');
  }
  return { decision: 'reuse', verification: existing };
}

function validateCiExpected(value) {
  const expected = requireExactKeys(value, 'expected CI run', [
    'sha',
    'workflowName',
    'workflowPath',
    'event',
    'branch',
    'repository',
    'selection',
  ]);
  if (expected.selection !== 'unique' && expected.selection !== 'newest') {
    throw new ReleaseToolError('expected CI run selection must be unique or newest');
  }
  return {
    sha: requireCommitSha(expected.sha, 'expected CI run sha'),
    workflowName: requireString(expected.workflowName, 'expected CI run workflowName'),
    workflowPath: requireString(
      expected.workflowPath,
      'expected CI run workflowPath',
      /^\.github\/workflows\/[A-Za-z0-9._-]+\.ya?ml$/u,
    ),
    event: requireString(expected.event, 'expected CI run event'),
    branch: requireString(expected.branch, 'expected CI run branch'),
    repository: requireString(
      expected.repository,
      'expected CI run repository',
      /^[A-Za-z0-9_.-]+\/[A-Za-z0-9_.-]+$/u,
    ),
    selection: expected.selection,
  };
}

export function selectExactCiRun(value, expectedValue) {
  const input = requireObject(value, 'Actions runs response');
  const runs = requireArray(input.workflow_runs, 'Actions runs response workflow_runs');
  const expected = validateCiExpected(expectedValue);
  const matches = runs.filter(
    (run) =>
      requireObject(run, 'Actions workflow run').name === expected.workflowName &&
      run.path === expected.workflowPath &&
      run.head_sha === expected.sha &&
      run.event === expected.event &&
      run.head_branch === expected.branch &&
      run.head_repository?.full_name === expected.repository &&
      run.status === 'completed' &&
      run.conclusion === 'success',
  );
  if (matches.length === 0) {
    throw new ReleaseToolError('no exact successful CI run found');
  }
  let selected;
  if (expected.selection === 'unique') {
    if (matches.length !== 1) {
      throw new ReleaseToolError(`ambiguous exact successful CI runs: ${matches.length}`);
    }
    [selected] = matches;
  } else {
    matches.sort((left, right) => right.run_number - left.run_number);
    if (matches.length > 1 && matches[0].run_number === matches[1].run_number) {
      throw new ReleaseToolError('ambiguous newest exact successful CI run');
    }
    [selected] = matches;
  }
  return {
    id: requirePositiveInteger(selected.id, 'selected CI run id'),
    runNumber: requirePositiveInteger(selected.run_number, 'selected CI run run_number'),
    runAttempt: requirePositiveInteger(selected.run_attempt, 'selected CI run run_attempt'),
    url: requireHttpsUrl(selected.html_url, 'selected CI run html_url'),
    sha: expected.sha,
  };
}

function parseNamedFlags(arguments_, allowed, required) {
  const result = {};
  for (let index = 0; index < arguments_.length; index += 2) {
    const key = arguments_[index];
    const value = arguments_[index + 1];
    if (!key?.startsWith('--') || value === undefined || value.startsWith('--')) {
      throw new ReleaseToolError('command flags must be --name value pairs');
    }
    const name = key.slice(2);
    if (!allowed.includes(name)) throw new ReleaseToolError(`unknown --${name} flag`);
    if (Object.hasOwn(result, name)) throw new ReleaseToolError(`duplicate --${name} flag`);
    result[name] = value;
  }
  for (const name of required) {
    if (!result[name]) throw new ReleaseToolError(`missing --${name} flag`);
  }
  return result;
}

function commandArguments(arguments_, count, usage) {
  if (arguments_.length !== count) throw new ReleaseToolError(`usage: ${usage}`);
  return arguments_;
}

async function main() {
  const { positional, outputPath } = parseOutputOption(process.argv.slice(2));
  const [command, ...arguments_] = positional;
  let result;
  switch (command) {
    case 'validate-intent': {
      const [path] = commandArguments(arguments_, 1, 'release-state.mjs validate-intent <intent>');
      result = validateReleaseIntent(readJson(path, 'release intent'));
      break;
    }
    case 'create-state': {
      const [path] = commandArguments(arguments_, 1, 'release-state.mjs create-state <intent>');
      result = createReleaseState(readJson(path, 'release intent'));
      break;
    }
    case 'transition': {
      const [statePath, transitionPath] = commandArguments(
        arguments_,
        2,
        'release-state.mjs transition <state> <transition>',
      );
      result = transitionReleaseState(
        readJson(statePath, 'release state'),
        readJson(transitionPath, 'release transition'),
      );
      break;
    }
    case 'compare-and-update': {
      const [currentPath, proposedPath] = commandArguments(
        arguments_,
        2,
        'release-state.mjs compare-and-update <current> <proposed>',
      );
      result = compareAndUpdateReleaseState(
        readJson(currentPath, 'current release state'),
        readJson(proposedPath, 'proposed release state'),
      );
      break;
    }
    case 'semver-monotonic': {
      const [path] = commandArguments(
        arguments_,
        1,
        'release-state.mjs semver-monotonic <alias-plan>',
      );
      result = planFloatingAliases(readJson(path, 'floating alias plan'));
      break;
    }
    case 'alias-rollback': {
      const [path] = commandArguments(
        arguments_,
        1,
        'release-state.mjs alias-rollback <rollback-input>',
      );
      result = decideAliasRollback(readJson(path, 'alias rollback input'));
      break;
    }
    case 'validate-anchors': {
      const [statePath, expectedPath] = commandArguments(
        arguments_,
        2,
        'release-state.mjs validate-anchors <state> <expected>',
      );
      result = validateReleaseAnchors(
        readJson(statePath, 'release state'),
        readJson(expectedPath, 'expected release anchors'),
      );
      break;
    }
    case 'validate-candidate': {
      const [path] = commandArguments(
        arguments_,
        1,
        'release-state.mjs validate-candidate <manifest>',
      );
      result = validateCandidateManifest(readJson(path, 'candidate manifest'));
      break;
    }
    case 'validate-release': {
      const [releasePath, candidatePath] = commandArguments(
        arguments_,
        2,
        'release-state.mjs validate-release <release> <candidate>',
      );
      result = validateReleaseManifest(
        readJson(releasePath, 'release manifest'),
        readJson(candidatePath, 'candidate manifest'),
      );
      break;
    }
    case 'recovery-decision': {
      const [path] = commandArguments(arguments_, 1, 'release-state.mjs recovery-decision <input>');
      result = decideReleaseRecovery(readJson(path, 'release recovery input'));
      break;
    }
    case 'verify-publish-anchors': {
      const [path] = commandArguments(
        arguments_,
        1,
        'release-state.mjs verify-publish-anchors <input>',
      );
      result = verifyPublishAnchors(readJson(path, 'publish anchor input'));
      break;
    }
    case 'final-idempotency': {
      if (arguments_.length === 1) {
        const input = requireExactKeys(
          readJson(arguments_[0], 'final idempotency input'),
          'final idempotency input',
          ['existing', 'proposed'],
        );
        result = verifyFinalIdempotency(input.existing, input.proposed);
      } else {
        const [existingPath, proposedPath] = commandArguments(
          arguments_,
          2,
          'release-state.mjs final-idempotency <input> | <existing-or-dash> <proposed>',
        );
        result = verifyFinalIdempotency(
          existingPath === '-' ? null : readJson(existingPath, 'existing final verification'),
          readJson(proposedPath, 'proposed final verification'),
        );
      }
      break;
    }
    case 'json-digest': {
      const [path] = commandArguments(arguments_, 1, 'release-state.mjs json-digest <file>');
      result = { digest: canonicalJsonDigest(readJson(path, 'canonical JSON input')) };
      break;
    }
    case 'canonicalize-json': {
      const [path] = commandArguments(
        arguments_,
        1,
        'release-state.mjs canonicalize-json <file> --out <file>',
      );
      if (!outputPath) {
        throw new ReleaseToolError('canonicalize-json requires --out');
      }
      result = readJson(path, 'canonical JSON input');
      break;
    }
    case 'select-ci-run': {
      const [runsPath, expectedPath] = commandArguments(
        arguments_,
        2,
        'release-state.mjs select-ci-run <runs> <expected>',
      );
      result = selectExactCiRun(
        readJson(runsPath, 'Actions runs response'),
        readJson(expectedPath, 'expected CI run'),
      );
      break;
    }
    case 'verify-ci': {
      const flags = parseNamedFlags(
        arguments_,
        ['runs', 'sha', 'repository', 'workflow', 'workflow-path', 'event', 'branch', 'selection'],
        ['runs', 'sha', 'repository', 'workflow', 'event', 'branch'],
      );
      const slug = flags.workflow
        .trim()
        .toLowerCase()
        .replace(/[^a-z0-9._-]+/gu, '-');
      result = selectExactCiRun(readJson(flags.runs, 'Actions runs response'), {
        sha: flags.sha,
        workflowName: flags.workflow,
        workflowPath: flags['workflow-path'] ?? `.github/workflows/${slug}.yml`,
        event: flags.event,
        branch: flags.branch,
        repository: flags.repository,
        selection: flags.selection ?? 'unique',
      });
      break;
    }
    default:
      throw new ReleaseToolError('unknown release-state command');
  }
  emitJson(result, outputPath);
}

if (isMain(import.meta.url)) runCli(main);
