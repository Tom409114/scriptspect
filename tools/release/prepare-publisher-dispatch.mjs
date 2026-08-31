import { validateReleaseAnchors, validateReleaseState } from './release-state.mjs';
import {
  emitJson,
  isMain,
  parseOutputOption,
  ReleaseToolError,
  readJson,
  requireCommitSha,
  requireObject,
  requirePositiveInteger,
  requireString,
  runCli,
} from './shared.mjs';

const dispatchableStates = new Set([
  'staged-draft',
  'npm-published',
  'npm-verified',
  'alias-planned',
  'aliases-verified',
  'final-planned',
  'consumed',
]);

function assertEqual(actual, expected, label) {
  if (actual !== expected) {
    throw new ReleaseToolError(`${label} conflict`);
  }
}

function parsePositiveIntegerText(value, label) {
  const text = requireString(value, label, /^[1-9]\d*$/u);
  const number = Number(text);
  requirePositiveInteger(number, label);
  if (String(number) !== text) {
    throw new ReleaseToolError(`${label} must be a canonical positive integer`);
  }
  return number;
}

function validateExpectedAssets(state) {
  const expectedNames = new Set([
    `scriptspect-${state.intent.version}.tgz`,
    'SHA256SUMS',
    'candidate-manifest.json',
    'release-manifest.json',
  ]);
  const assets = state.stagedDraft.assets;
  if (
    assets.length !== expectedNames.size ||
    assets.some((asset) => !expectedNames.has(asset.name))
  ) {
    throw new ReleaseToolError('staged draft assets must be the exact publisher input set');
  }
}

function validateTagReference(value, tag, sha) {
  const tagReference = requireObject(value, 'tag ref');
  const object = requireObject(tagReference.object, 'tag ref object');
  const ref = requireString(tagReference.ref, 'tag ref ref');
  const type = requireString(object.type, 'tag ref object type');
  const target = requireCommitSha(object.sha, 'tag ref object sha');
  assertEqual(ref, `refs/tags/${tag}`, 'tag ref name');
  assertEqual(type, 'commit', 'tag ref object type');
  assertEqual(target, sha, 'tag ref object sha');
}

function parseJsonText(value, label) {
  const text = requireString(value, label);
  try {
    return JSON.parse(text);
  } catch {
    throw new ReleaseToolError(`${label} is not valid JSON`);
  }
}

function validateIntentCheck(value, checkRunId, sha) {
  const check = requireObject(value, 'intent check');
  const app = requireObject(check.app, 'intent check app');
  const output = requireObject(check.output, 'intent check output');
  assertEqual(requirePositiveInteger(check.id, 'intent check id'), checkRunId, 'intent check id');
  assertEqual(
    requireString(check.name, 'intent check name'),
    'release-intent',
    'intent check name',
  );
  assertEqual(
    requireString(check.status, 'intent check status'),
    'completed',
    'intent check status',
  );
  assertEqual(
    requireString(check.conclusion, 'intent check conclusion'),
    'success',
    'intent check conclusion',
  );
  assertEqual(
    requireCommitSha(check.head_sha, 'intent check head sha'),
    sha,
    'intent check head sha',
  );
  assertEqual(
    requireString(app.slug, 'intent check app slug'),
    'github-actions',
    'intent check app slug',
  );
  return {
    externalId: requireString(check.external_id, 'intent check externalId'),
    state: parseJsonText(output.text, 'intent check output text'),
  };
}

export function preparePublisherDispatch(intentCheckValue, tagRefValue, expectedValue) {
  const expected = requireObject(expectedValue, 'publisher dispatch expectation');
  const checkRunId = parsePositiveIntegerText(expected.intentId, 'publisher dispatch intentId');
  const sha = requireCommitSha(expected.sha, 'publisher dispatch sha');
  const tag = requireString(
    expected.tag,
    'publisher dispatch tag',
    /^v(?:0|[1-9]\d*)\.(?:0|[1-9]\d*)\.(?:0|[1-9]\d*)$/u,
  );
  const releaseId = requirePositiveInteger(expected.releaseId, 'publisher dispatch releaseId');

  const intentCheck = validateIntentCheck(intentCheckValue, checkRunId, sha);
  const state = validateReleaseState(intentCheck.state);
  if (!dispatchableStates.has(state.state)) {
    throw new ReleaseToolError('release state must be at staged-draft or later');
  }
  assertEqual(state.intent.intentId, intentCheck.externalId, 'intent check externalId');
  validateReleaseAnchors(state, {
    mergeCommitSha: sha,
    tag,
    releaseId,
  });
  validateExpectedAssets(state);
  validateTagReference(tagRefValue, tag, sha);

  return {
    ref: tag,
    inputs: {
      'intent-id': String(checkRunId),
      tag,
      sha,
    },
  };
}

function parseFlags(arguments_) {
  if (arguments_.length % 2 !== 0) {
    throw new ReleaseToolError('publisher dispatch flags must be --name value pairs');
  }
  const allowed = new Set(['intent-check', 'tag-ref', 'intent-id', 'sha', 'tag', 'release-id']);
  const flags = {};
  for (let index = 0; index < arguments_.length; index += 2) {
    const option = arguments_[index];
    const value = arguments_[index + 1];
    if (!option?.startsWith('--') || value === undefined || value.startsWith('--')) {
      throw new ReleaseToolError('publisher dispatch flags must be --name value pairs');
    }
    const name = option.slice(2);
    if (!allowed.has(name)) throw new ReleaseToolError(`unknown --${name} flag`);
    if (Object.hasOwn(flags, name)) throw new ReleaseToolError(`duplicate --${name} flag`);
    flags[name] = value;
  }
  for (const name of allowed) {
    if (!flags[name]) throw new ReleaseToolError(`missing --${name} flag`);
  }
  return flags;
}

async function main() {
  const { positional, outputPath } = parseOutputOption(process.argv.slice(2));
  const flags = parseFlags(positional);
  const payload = preparePublisherDispatch(
    readJson(flags['intent-check'], 'intent check'),
    readJson(flags['tag-ref'], 'tag ref'),
    {
      intentId: flags['intent-id'],
      sha: flags.sha,
      tag: flags.tag,
      releaseId: parsePositiveIntegerText(flags['release-id'], 'publisher dispatch releaseId'),
    },
  );
  emitJson(payload, outputPath);
}

if (isMain(import.meta.url)) runCli(main);
