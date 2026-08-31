import { createHash, randomBytes } from 'node:crypto';
import {
  closeSync,
  fsyncSync,
  openSync,
  readFileSync,
  realpathSync,
  renameSync,
  unlinkSync,
  writeFileSync,
} from 'node:fs';
import { dirname, resolve } from 'node:path';
import { fileURLToPath, pathToFileURL } from 'node:url';

export class ReleaseToolError extends Error {
  constructor(message) {
    super(message);
    this.name = 'ReleaseToolError';
  }
}

export function isPlainObject(value) {
  return value !== null && typeof value === 'object' && !Array.isArray(value);
}

export function requireObject(value, label) {
  if (!isPlainObject(value)) {
    throw new ReleaseToolError(`${label} must be an object`);
  }
  return value;
}

export function requireExactKeys(value, label, required, optional = []) {
  const object = requireObject(value, label);
  const allowed = new Set([...required, ...optional]);
  for (const key of Object.keys(object)) {
    if (!allowed.has(key)) {
      throw new ReleaseToolError(`${label} has unknown field ${key}`);
    }
  }
  for (const key of required) {
    if (!Object.hasOwn(object, key)) {
      throw new ReleaseToolError(`${label} is missing field ${key}`);
    }
  }
  return object;
}

export function requireString(value, label, pattern) {
  if (typeof value !== 'string' || value.length === 0) {
    throw new ReleaseToolError(`${label} must be a non-empty string`);
  }
  if (pattern && !pattern.test(value)) {
    throw new ReleaseToolError(`${label} has an invalid format`);
  }
  return value;
}

export function requirePositiveInteger(value, label) {
  if (!Number.isSafeInteger(value) || value <= 0) {
    throw new ReleaseToolError(`${label} must be a positive integer`);
  }
  return value;
}

export function requireSha256(value, label) {
  return requireString(value, label, /^[0-9a-f]{64}$/u);
}

export function requireCommitSha(value, label) {
  return requireString(value, label, /^[0-9a-f]{40}$/u);
}

export function requireNpmSri(value, label) {
  const sri = requireString(value, label, /^sha512-[A-Za-z0-9+/]+={0,2}$/u);
  const encoded = sri.slice('sha512-'.length);
  const bytes = Buffer.from(encoded, 'base64');
  if (bytes.length !== 64 || bytes.toString('base64') !== encoded) {
    throw new ReleaseToolError(`${label} must contain one canonical SHA-512 digest`);
  }
  return sri;
}

export function stableJson(value) {
  if (value === null || typeof value === 'string' || typeof value === 'boolean') {
    return JSON.stringify(value);
  }
  if (typeof value === 'number') {
    if (!Number.isFinite(value)) {
      throw new ReleaseToolError('JSON numbers must be finite');
    }
    return JSON.stringify(value);
  }
  if (Array.isArray(value)) {
    return `[${value.map((entry) => stableJson(entry)).join(',')}]`;
  }
  if (isPlainObject(value)) {
    return `{${Object.keys(value)
      .sort()
      .map((key) => `${JSON.stringify(key)}:${stableJson(value[key])}`)
      .join(',')}}`;
  }
  throw new ReleaseToolError('value is not canonical JSON data');
}

export function jsonDigest(value) {
  return createHash('sha256')
    .update(`${stableJson(value)}\n`, 'utf8')
    .digest('hex');
}

export function deepEqual(left, right) {
  return stableJson(left) === stableJson(right);
}

export function readJson(path, label = 'JSON file') {
  let text;
  try {
    text = readFileSync(path, 'utf8');
  } catch {
    throw new ReleaseToolError(`${label} could not be read`);
  }
  try {
    return JSON.parse(text);
  } catch {
    throw new ReleaseToolError(`${label} is not valid JSON`);
  }
}

export function writeJsonAtomic(path, value) {
  const target = resolve(path);
  const parent = dirname(target);
  const temporary = `${target}.tmp-${process.pid}-${randomBytes(8).toString('hex')}`;
  let descriptor;
  try {
    descriptor = openSync(temporary, 'wx', 0o600);
    writeFileSync(descriptor, `${stableJson(value)}\n`, 'utf8');
    fsyncSync(descriptor);
    closeSync(descriptor);
    descriptor = undefined;
    renameSync(temporary, target);
    try {
      const directoryDescriptor = openSync(parent, 'r');
      try {
        fsyncSync(directoryDescriptor);
      } finally {
        closeSync(directoryDescriptor);
      }
    } catch {
      // Windows does not permit fsync on a directory. The file itself is already durable.
    }
  } catch (error) {
    if (descriptor !== undefined) {
      closeSync(descriptor);
    }
    try {
      unlinkSync(temporary);
    } catch {
      // Nothing remains to clean up.
    }
    throw new ReleaseToolError(`output JSON could not be written: ${String(error)}`);
  }
}

export function emitJson(value, outputPath) {
  if (outputPath) {
    writeJsonAtomic(outputPath, value);
  }
  process.stdout.write(`${stableJson(value)}\n`);
}

export function parseOutputOption(arguments_) {
  const outIndex = arguments_.indexOf('--out');
  if (outIndex === -1) {
    return { positional: [...arguments_], outputPath: undefined };
  }
  if (outIndex !== arguments_.length - 2 || !arguments_[outIndex + 1]) {
    throw new ReleaseToolError('--out must be followed by exactly one final path');
  }
  return {
    positional: arguments_.slice(0, outIndex),
    outputPath: arguments_[outIndex + 1],
  };
}

export function isMain(importMetaUrl) {
  if (!process.argv[1]) return false;
  try {
    return realpathSync(resolve(process.argv[1])) === realpathSync(fileURLToPath(importMetaUrl));
  } catch {
    return pathToFileURL(resolve(process.argv[1])).href === importMetaUrl;
  }
}

export function runCli(main) {
  Promise.resolve()
    .then(main)
    .catch((error) => {
      const message =
        error instanceof ReleaseToolError ? error.message : 'unexpected release tool failure';
      process.stderr.write(`${stableJson({ error: message })}\n`);
      process.exitCode = 1;
    });
}
