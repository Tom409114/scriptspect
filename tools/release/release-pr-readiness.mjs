import {
  emitJson,
  isMain,
  ReleaseToolError,
  readJson,
  requireObject,
  requireString,
  runCli,
} from './shared.mjs';
import { verifyIntegrityContract } from './verify-package-integrity.mjs';

const RELEASE_BRANCH_PREFIX = 'release-please--';
const RELEASE_TITLE = /^chore\(main\): release [0-9]+\.[0-9]+\.[0-9]+$/u;
const RELEASE_LABEL = 'autorelease: pending';
const ACTOR_LIST = /^[A-Za-z0-9_-]+(?:\[bot\])?(?:\s*,\s*[A-Za-z0-9_-]+(?:\[bot\])?)*$/u;

function objectField(value, field, label) {
  return requireObject(requireObject(value, label)[field], `${label}.${field}`);
}

function stringField(value, field, label) {
  return requireString(requireObject(value, label)[field], `${label}.${field}`);
}

function fail(message) {
  throw new ReleaseToolError(`release PR readiness failed: ${message}`);
}

function exactSwitch(value, expected, label) {
  if (value !== expected) fail(`${label} must be exactly ${expected}`);
}

function labelNames(pullRequest) {
  if (!Array.isArray(pullRequest.labels)) {
    throw new ReleaseToolError('pull_request.labels must be an array');
  }
  return pullRequest.labels.map((label, index) =>
    stringField(label, 'name', `pull_request.labels[${index}]`),
  );
}

export function verifyReleasePrReadiness(input) {
  const event = requireObject(input.event, 'event');
  const pullRequest = objectField(event, 'pull_request', 'event');
  const actor = stringField(objectField(pullRequest, 'user', 'pull_request'), 'login', 'user');
  const title = stringField(pullRequest, 'title', 'pull_request');
  const head = objectField(pullRequest, 'head', 'pull_request');
  const headRef = stringField(head, 'ref', 'pull_request.head');
  const labels = labelNames(pullRequest);
  const repository = requireString(
    input.repository,
    'repository',
    /^[A-Za-z0-9_.-]+\/[A-Za-z0-9_.-]+$/u,
  );
  const actorList = requireString(input.releasePrActors, 'release PR actor allowlist', ACTOR_LIST);
  const allowedActors = actorList.split(',').map((entry) => entry.trim());

  const signals = {
    allowedActor: allowedActors.includes(actor),
    releaseBranch: headRef.startsWith(RELEASE_BRANCH_PREFIX),
    releaseTitle: RELEASE_TITLE.test(title),
    releaseLabel: labels.includes(RELEASE_LABEL),
  };
  if (!Object.values(signals).some(Boolean)) {
    return {
      schemaVersion: 'scriptspect-release-pr-readiness/v1',
      applicable: false,
      ready: true,
    };
  }

  if (!signals.allowedActor) fail('actor is not in RELEASE_PR_ACTORS');
  if (!signals.releaseBranch) fail(`head branch must start with ${RELEASE_BRANCH_PREFIX}`);
  if (!signals.releaseTitle) fail('title is not the canonical release-please title');
  if (!signals.releaseLabel) fail(`label ${RELEASE_LABEL} is missing`);

  const base = objectField(pullRequest, 'base', 'pull_request');
  if (stringField(base, 'ref', 'pull_request.base') !== 'main') {
    fail('base ref must be main');
  }
  const baseRepository = stringField(
    objectField(base, 'repo', 'pull_request.base'),
    'full_name',
    'pull_request.base.repo',
  );
  if (baseRepository !== repository) fail('base repository does not match the workflow repository');

  const headRepositoryObject = objectField(head, 'repo', 'pull_request.head');
  const headRepository = stringField(headRepositoryObject, 'full_name', 'pull_request.head.repo');
  if (headRepository !== repository || headRepositoryObject.fork !== false) {
    fail('release PR head must be a non-fork branch in the workflow repository');
  }

  exactSwitch(input.npmBootstrapEnabled, 'false', 'NPM_BOOTSTRAP_ENABLED');
  exactSwitch(input.npmTrustedPublishingReady, 'true', 'NPM_TRUSTED_PUBLISHING_READY');
  exactSwitch(input.releaseTagPolicyReady, 'true', 'RELEASE_TAG_POLICY_READY');
  const contractValue =
    input.integrityContract ??
    readJson(
      requireString(input.integrityContractPath, 'npm integrity contract path'),
      'npm integrity contract',
    );
  const contract = verifyIntegrityContract(contractValue);

  return {
    schemaVersion: 'scriptspect-release-pr-readiness/v1',
    applicable: true,
    ready: true,
    releasePr: { actor, base: 'main', headRef, repository, title },
    integrityContract: {
      bootstrapVersion: contract.bootstrapVersion,
      comparatorAlgorithmDigest: contract.comparatorAlgorithmDigest,
      integrityMode: contract.integrityMode,
      sourceCommit: contract.sourceCommit,
      workflowRunUrl: contract.workflowRunUrl,
    },
  };
}

function parseFlags(arguments_) {
  const flags = {};
  for (let index = 0; index < arguments_.length; index += 2) {
    const key = arguments_[index];
    const value = arguments_[index + 1];
    if (!key?.startsWith('--') || value === undefined || value.startsWith('--')) {
      throw new ReleaseToolError('readiness flags must be --name value pairs');
    }
    const name = key.slice(2);
    if (Object.hasOwn(flags, name)) throw new ReleaseToolError(`duplicate --${name} flag`);
    flags[name] = value;
  }
  const required = [
    'event',
    'contract',
    'repository',
    'release-pr-actors',
    'npm-bootstrap-enabled',
    'npm-trusted-publishing-ready',
    'release-tag-policy-ready',
  ];
  for (const key of Object.keys(flags)) {
    if (!required.includes(key)) throw new ReleaseToolError(`unknown --${key} flag`);
  }
  for (const key of required) {
    if (!Object.hasOwn(flags, key)) throw new ReleaseToolError(`missing --${key} flag`);
  }
  return flags;
}

async function main() {
  const flags = parseFlags(process.argv.slice(2));
  const event = readJson(flags.event, 'pull_request_target event');
  emitJson(
    verifyReleasePrReadiness({
      event,
      integrityContractPath: flags.contract,
      repository: flags.repository,
      releasePrActors: flags['release-pr-actors'],
      npmBootstrapEnabled: flags['npm-bootstrap-enabled'],
      npmTrustedPublishingReady: flags['npm-trusted-publishing-ready'],
      releaseTagPolicyReady: flags['release-tag-policy-ready'],
    }),
  );
}

if (isMain(import.meta.url)) runCli(main);
