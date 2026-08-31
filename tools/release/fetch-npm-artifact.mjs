import { createHash, randomBytes } from 'node:crypto';
import { closeSync, fsyncSync, openSync, renameSync, unlinkSync, writeFileSync } from 'node:fs';
import { dirname, resolve } from 'node:path';
import {
  emitJson,
  isMain,
  ReleaseToolError,
  requireNpmSri,
  requireString,
  runCli,
} from './shared.mjs';

const defaultRegistryUrl = 'https://registry.npmjs.org';
const defaultRequestTimeoutMs = 30_000;

class RegistryPropagationError extends ReleaseToolError {
  constructor(message, reason) {
    super(message);
    this.reason = reason;
  }
}

function requirePackageName(value) {
  return requireString(
    value,
    'npm package name',
    /^(?:@[a-z0-9][a-z0-9._-]*\/)?[a-z0-9][a-z0-9._-]*$/u,
  );
}

function requireVersion(value) {
  return requireString(value, 'npm package version', /^(0|[1-9]\d*)\.(0|[1-9]\d*)\.(0|[1-9]\d*)$/u);
}

function requireInteger(value, label, minimum, maximum) {
  if (!Number.isSafeInteger(value) || value < minimum || value > maximum) {
    throw new ReleaseToolError(`${label} must be an integer from ${minimum} through ${maximum}`);
  }
  return value;
}

function registryOrigin(value) {
  let url;
  try {
    url = new URL(value);
  } catch {
    throw new ReleaseToolError('npm registry URL must be a valid HTTPS URL');
  }
  if (
    url.protocol !== 'https:' ||
    url.username ||
    url.password ||
    url.search ||
    url.hash ||
    (url.pathname !== '/' && url.pathname !== '')
  ) {
    throw new ReleaseToolError('npm registry URL must be an HTTPS origin without credentials');
  }
  return url.origin;
}

function metadataUrl(registryUrl, packageName, version) {
  return `${registryUrl}/${encodeURIComponent(packageName)}/${encodeURIComponent(version)}`;
}

async function request(url, fetchImpl, label, requestTimeoutMs) {
  let response;
  try {
    response = await fetchImpl(url, {
      headers: { accept: 'application/json' },
      redirect: 'error',
      signal: AbortSignal.timeout(requestTimeoutMs),
    });
  } catch (error) {
    throw new RegistryPropagationError(
      `${label} transient transport failure: ${String(error)}`,
      'transport',
    );
  }
  if (response.status === 401 || response.status === 403) {
    throw new ReleaseToolError(`${label} authentication failed with HTTP ${response.status}`);
  }
  if (response.status === 404) return null;
  if (response.status === 429 || response.status >= 500) {
    throw new RegistryPropagationError(
      `${label} transient HTTP ${response.status}`,
      'transient-http',
    );
  }
  if (!response.ok) {
    throw new ReleaseToolError(`${label} protocol failed with HTTP ${response.status}`);
  }
  return response;
}

async function readMetadata(response, packageName, version) {
  let manifest;
  try {
    manifest = await response.json();
  } catch {
    throw new ReleaseToolError('npm registry metadata was not valid JSON');
  }
  if (
    manifest === null ||
    typeof manifest !== 'object' ||
    manifest.name !== packageName ||
    manifest.version !== version
  ) {
    throw new ReleaseToolError('npm registry metadata did not match the exact package version');
  }
  return manifest;
}

export async function probeRegistryVersion(options) {
  const packageName = requirePackageName(options.packageName);
  const version = requireVersion(options.version);
  const registryUrl = registryOrigin(options.registryUrl ?? defaultRegistryUrl);
  const fetchImpl = options.fetchImpl ?? globalThis.fetch;
  if (typeof fetchImpl !== 'function') throw new ReleaseToolError('fetch is unavailable');
  const requestTimeoutMs = requireInteger(
    options.requestTimeoutMs ?? defaultRequestTimeoutMs,
    'registry request timeout',
    1,
    300_000,
  );
  const response = await request(
    metadataUrl(registryUrl, packageName, version),
    fetchImpl,
    'npm registry metadata',
    requestTimeoutMs,
  );
  if (response === null) return { status: 'not-found', package: packageName, version };
  await readMetadata(response, packageName, version);
  return { status: 'found', package: packageName, version };
}

function validateTarballUrl(value, registryUrl) {
  let url;
  try {
    url = new URL(value);
  } catch {
    throw new ReleaseToolError('npm registry tarball URL was invalid');
  }
  if (url.protocol !== 'https:' || url.username || url.password || url.origin !== registryUrl) {
    throw new ReleaseToolError('npm registry tarball URL must stay on the registry HTTPS origin');
  }
  return url.href;
}

async function fetchAttempt({ packageName, version, registryUrl, fetchImpl, requestTimeoutMs }) {
  const response = await request(
    metadataUrl(registryUrl, packageName, version),
    fetchImpl,
    'npm registry metadata',
    requestTimeoutMs,
  );
  if (response === null) {
    throw new RegistryPropagationError('exact-version metadata was not found', 'not-found');
  }
  const manifest = await readMetadata(response, packageName, version);
  let registryNpmSRI;
  try {
    registryNpmSRI = requireNpmSri(manifest.dist?.integrity, 'npm registry dist.integrity');
  } catch {
    throw new RegistryPropagationError('npm registry dist.integrity is not ready', 'not-ready');
  }
  if (typeof manifest.dist?.tarball !== 'string') {
    throw new RegistryPropagationError('npm registry dist.tarball is not ready', 'not-ready');
  }
  const tarballUrl = validateTarballUrl(manifest.dist.tarball, registryUrl);
  const tarballResponse = await request(
    tarballUrl,
    fetchImpl,
    'npm registry tarball',
    requestTimeoutMs,
  );
  if (tarballResponse === null) {
    throw new RegistryPropagationError('exact-version tarball was not found', 'not-found');
  }
  let bytes;
  try {
    bytes = Buffer.from(await tarballResponse.arrayBuffer());
  } catch (error) {
    throw new RegistryPropagationError(
      `npm registry tarball transient transport failure: ${String(error)}`,
      'transport',
    );
  }
  const calculatedSRI = `sha512-${createHash('sha512').update(bytes).digest('base64')}`;
  if (calculatedSRI !== registryNpmSRI) {
    throw new RegistryPropagationError(
      'npm registry tarball bytes did not match dist.integrity',
      'sri-mismatch',
    );
  }
  return { bytes, registryNpmSRI, tarballUrl };
}

function writeBytesAtomic(path, bytes) {
  const target = resolve(path);
  const temporary = `${target}.tmp-${process.pid}-${randomBytes(8).toString('hex')}`;
  let descriptor;
  try {
    descriptor = openSync(temporary, 'wx', 0o600);
    writeFileSync(descriptor, bytes);
    fsyncSync(descriptor);
    closeSync(descriptor);
    descriptor = undefined;
    renameSync(temporary, target);
    try {
      const directoryDescriptor = openSync(dirname(target), 'r');
      try {
        fsyncSync(directoryDescriptor);
      } finally {
        closeSync(directoryDescriptor);
      }
    } catch {
      // Windows does not permit fsync on a directory. The file is already durable.
    }
  } catch (error) {
    if (descriptor !== undefined) closeSync(descriptor);
    try {
      unlinkSync(temporary);
    } catch {
      // No temporary file remains.
    }
    throw new ReleaseToolError(`registry tarball could not be written: ${String(error)}`);
  }
}

export async function fetchRegistryArtifact(options) {
  const packageName = requirePackageName(options.packageName);
  const version = requireVersion(options.version);
  const outputPath = requireString(options.outputPath, 'registry tarball output path');
  const attempts = requireInteger(options.attempts, 'registry attempts', 1, 60);
  const baseDelayMs = requireInteger(options.baseDelayMs, 'registry base delay', 0, 300_000);
  const maxDelayMs = requireInteger(options.maxDelayMs, 'registry maximum delay', 0, 300_000);
  const requestTimeoutMs = requireInteger(
    options.requestTimeoutMs ?? defaultRequestTimeoutMs,
    'registry request timeout',
    1,
    300_000,
  );
  if (maxDelayMs < baseDelayMs) {
    throw new ReleaseToolError('registry maximum delay must be at least the base delay');
  }
  const registryUrl = registryOrigin(options.registryUrl ?? defaultRegistryUrl);
  const fetchImpl = options.fetchImpl ?? globalThis.fetch;
  if (typeof fetchImpl !== 'function') throw new ReleaseToolError('fetch is unavailable');
  const sleep =
    options.sleep ??
    ((milliseconds) => new Promise((resolve_) => setTimeout(resolve_, milliseconds)));
  let lastPropagationError;
  for (let attempt = 1; attempt <= attempts; attempt += 1) {
    try {
      const artifact = await fetchAttempt({
        packageName,
        version,
        registryUrl,
        fetchImpl,
        requestTimeoutMs,
      });
      writeBytesAtomic(outputPath, artifact.bytes);
      return {
        package: packageName,
        version,
        registryNpmSRI: artifact.registryNpmSRI,
        attempts: attempt,
        byteLength: artifact.bytes.length,
      };
    } catch (error) {
      if (!(error instanceof RegistryPropagationError)) {
        const message = error instanceof Error ? error.message : String(error);
        throw new ReleaseToolError(
          `npm registry transport/protocol failure at attempt ${attempt}: ${message}`,
        );
      }
      lastPropagationError = error;
      if (attempt < attempts) {
        const delay = Math.min(maxDelayMs, baseDelayMs * 2 ** (attempt - 1));
        await sleep(delay);
      }
    }
  }
  if (lastPropagationError?.reason === 'not-found') {
    throw new ReleaseToolError(
      `npm registry exact version ${packageName}@${version} was not found after ${attempts} attempts`,
    );
  }
  throw new ReleaseToolError(
    `npm registry propagation did not settle after ${attempts} attempts: ${lastPropagationError?.message ?? 'unknown propagation state'}`,
  );
}

function parseFlags(arguments_) {
  if (arguments_.length % 2 !== 0) {
    throw new ReleaseToolError('registry command flags must be --name value pairs');
  }
  const result = {};
  for (let index = 0; index < arguments_.length; index += 2) {
    const flag = arguments_[index];
    const value = arguments_[index + 1];
    if (!flag.startsWith('--') || !value || value.startsWith('--')) {
      throw new ReleaseToolError('registry command flags must be --name value pairs');
    }
    const name = flag.slice(2);
    if (Object.hasOwn(result, name)) throw new ReleaseToolError(`duplicate --${name} flag`);
    result[name] = value;
  }
  return result;
}

function requireFlag(flags, name) {
  return requireString(flags[name], `--${name}`);
}

async function main() {
  const [command, ...arguments_] = process.argv.slice(2);
  const flags = parseFlags(arguments_);
  let result;
  if (command === 'probe') {
    const allowed = new Set(['package', 'version']);
    for (const name of Object.keys(flags)) {
      if (!allowed.has(name)) throw new ReleaseToolError(`unknown --${name} flag`);
    }
    result = await probeRegistryVersion({
      packageName: requireFlag(flags, 'package'),
      version: requireFlag(flags, 'version'),
    });
  } else if (command === 'fetch') {
    const allowed = new Set([
      'package',
      'version',
      'output',
      'attempts',
      'base-delay-ms',
      'max-delay-ms',
      'request-timeout-ms',
    ]);
    for (const name of Object.keys(flags)) {
      if (!allowed.has(name)) throw new ReleaseToolError(`unknown --${name} flag`);
    }
    result = await fetchRegistryArtifact({
      packageName: requireFlag(flags, 'package'),
      version: requireFlag(flags, 'version'),
      outputPath: requireFlag(flags, 'output'),
      attempts: Number(flags.attempts ?? '12'),
      baseDelayMs: Number(flags['base-delay-ms'] ?? '5000'),
      maxDelayMs: Number(flags['max-delay-ms'] ?? '30000'),
      requestTimeoutMs: Number(flags['request-timeout-ms'] ?? String(defaultRequestTimeoutMs)),
    });
  } else {
    throw new ReleaseToolError(
      'usage: fetch-npm-artifact.mjs probe|fetch --package name --version x.y.z',
    );
  }
  emitJson(result);
}

if (isMain(import.meta.url)) runCli(main);
