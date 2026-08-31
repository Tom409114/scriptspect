import { createHash } from 'node:crypto';
import { mkdtempSync, readFileSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, describe, expect, it } from 'vitest';

type RegistryModule = {
  probeRegistryVersion(options: {
    packageName: string;
    version: string;
    registryUrl?: string;
    fetchImpl?: typeof fetch;
  }): Promise<{ status: 'found' | 'not-found'; package: string; version: string }>;
  fetchRegistryArtifact(options: {
    packageName: string;
    version: string;
    outputPath: string;
    attempts: number;
    baseDelayMs: number;
    maxDelayMs: number;
    requestTimeoutMs?: number;
    registryUrl?: string;
    fetchImpl?: typeof fetch;
    sleep?: (milliseconds: number) => Promise<void>;
  }): Promise<{
    package: string;
    version: string;
    registryNpmSRI: string;
    attempts: number;
    byteLength: number;
  }>;
};

const temporaryDirectories: string[] = [];

async function loadRegistryModule(): Promise<RegistryModule> {
  return (await import('../../tools/release/fetch-npm-artifact.mjs')) as RegistryModule;
}

function temporaryDirectory(name: string): string {
  const directory = mkdtempSync(join(tmpdir(), `scriptspect-registry-${name}-`));
  temporaryDirectories.push(directory);
  return directory;
}

afterEach(() => {
  for (const directory of temporaryDirectories.splice(0)) {
    rmSync(directory, { recursive: true, force: true });
  }
});

function sri(bytes: Uint8Array): string {
  return `sha512-${createHash('sha512').update(bytes).digest('base64')}`;
}

function manifest(integrity: string) {
  return {
    name: 'scriptspect',
    version: '0.1.0',
    dist: {
      integrity,
      tarball: 'https://registry.example/scriptspect/-/scriptspect-0.1.0.tgz',
    },
  };
}

describe('bounded npm registry propagation', () => {
  it('retries exact-version metadata and tarball 404s with bounded exponential backoff', async () => {
    const registry = await loadRegistryModule();
    const bytes = Buffer.from('registry tarball bytes');
    const delays: number[] = [];
    let metadataRequests = 0;
    let tarballRequests = 0;
    const fetchImpl = (async (input: string | URL | Request) => {
      const url = String(input);
      if (url.endsWith('/scriptspect/0.1.0')) {
        metadataRequests += 1;
        if (metadataRequests === 1) return new Response('not found', { status: 404 });
        return Response.json(manifest(sri(bytes)));
      }
      tarballRequests += 1;
      if (tarballRequests === 1) return new Response('not found', { status: 404 });
      return new Response(bytes);
    }) as typeof fetch;
    const outputPath = join(temporaryDirectory('propagation'), 'registry.tgz');

    const result = await registry.fetchRegistryArtifact({
      packageName: 'scriptspect',
      version: '0.1.0',
      outputPath,
      attempts: 4,
      baseDelayMs: 5,
      maxDelayMs: 8,
      registryUrl: 'https://registry.example',
      fetchImpl,
      sleep: async (milliseconds) => {
        delays.push(milliseconds);
      },
    });

    expect(result).toEqual({
      package: 'scriptspect',
      version: '0.1.0',
      registryNpmSRI: sri(bytes),
      attempts: 3,
      byteLength: bytes.length,
    });
    expect(readFileSync(outputPath)).toEqual(bytes);
    expect(delays).toEqual([5, 8]);
  });

  it('retries an SRI propagation mismatch but never accepts mismatched bytes', async () => {
    const registry = await loadRegistryModule();
    const expected = Buffer.from('settled bytes');
    const stale = Buffer.from('stale bytes');
    let tarballRequests = 0;
    const fetchImpl = (async (input: string | URL | Request) => {
      if (String(input).endsWith('/scriptspect/0.1.0')) {
        return Response.json(manifest(sri(expected)));
      }
      tarballRequests += 1;
      return new Response(tarballRequests === 1 ? stale : expected);
    }) as typeof fetch;
    const outputPath = join(temporaryDirectory('sri'), 'registry.tgz');

    const result = await registry.fetchRegistryArtifact({
      packageName: 'scriptspect',
      version: '0.1.0',
      outputPath,
      attempts: 2,
      baseDelayMs: 0,
      maxDelayMs: 0,
      registryUrl: 'https://registry.example',
      fetchImpl,
      sleep: async () => {},
    });

    expect(result.attempts).toBe(2);
    expect(readFileSync(outputPath)).toEqual(expected);
  });

  it('fails authentication immediately but retries transient transport errors', async () => {
    const registry = await loadRegistryModule();
    let authenticationRequests = 0;
    const authenticationFetch = (async () => {
      authenticationRequests += 1;
      return new Response('denied', { status: 401 });
    }) as typeof fetch;
    await expect(
      registry.probeRegistryVersion({
        packageName: 'scriptspect',
        version: '0.1.0',
        registryUrl: 'https://registry.example',
        fetchImpl: authenticationFetch,
      }),
    ).rejects.toThrow(/authentication.*401/i);
    expect(authenticationRequests).toBe(1);

    let transportRequests = 0;
    const bytes = Buffer.from('recovered transport');
    const transportFetch = (async (input: string | URL | Request, init?: RequestInit) => {
      transportRequests += 1;
      expect(init?.signal).toBeInstanceOf(AbortSignal);
      if (transportRequests === 1) throw new TypeError('socket reset');
      if (String(input).endsWith('/scriptspect/0.1.0')) {
        return Response.json(manifest(sri(bytes)));
      }
      return new Response(bytes);
    }) as typeof fetch;
    const outputPath = join(temporaryDirectory('transport'), 'registry.tgz');
    const result = await registry.fetchRegistryArtifact({
      packageName: 'scriptspect',
      version: '0.1.0',
      outputPath,
      attempts: 4,
      baseDelayMs: 0,
      maxDelayMs: 0,
      requestTimeoutMs: 25,
      registryUrl: 'https://registry.example',
      fetchImpl: transportFetch,
      sleep: async () => {},
    });
    expect(result.attempts).toBe(2);
    expect(transportRequests).toBe(3);
    expect(readFileSync(outputPath)).toEqual(bytes);
  });

  it('retries HTTP 429 and 5xx responses but keeps other protocol errors terminal', async () => {
    const registry = await loadRegistryModule();
    const bytes = Buffer.from('rate-limit recovery');
    let requests = 0;
    const transientFetch = (async (input: string | URL | Request) => {
      requests += 1;
      if (requests === 1) return new Response('slow down', { status: 429 });
      if (requests === 2) return new Response('unavailable', { status: 503 });
      if (String(input).endsWith('/scriptspect/0.1.0')) {
        return Response.json(manifest(sri(bytes)));
      }
      return new Response(bytes);
    }) as typeof fetch;
    const result = await registry.fetchRegistryArtifact({
      packageName: 'scriptspect',
      version: '0.1.0',
      outputPath: join(temporaryDirectory('transient-http'), 'registry.tgz'),
      attempts: 4,
      baseDelayMs: 0,
      maxDelayMs: 0,
      requestTimeoutMs: 25,
      registryUrl: 'https://registry.example',
      fetchImpl: transientFetch,
      sleep: async () => {},
    });
    expect(result.attempts).toBe(3);

    let protocolRequests = 0;
    const protocolFetch = (async () => {
      protocolRequests += 1;
      return new Response('bad request', { status: 400 });
    }) as typeof fetch;
    await expect(
      registry.fetchRegistryArtifact({
        packageName: 'scriptspect',
        version: '0.1.0',
        outputPath: join(temporaryDirectory('protocol'), 'registry.tgz'),
        attempts: 4,
        baseDelayMs: 0,
        maxDelayMs: 0,
        requestTimeoutMs: 25,
        registryUrl: 'https://registry.example',
        fetchImpl: protocolFetch,
        sleep: async () => {},
      }),
    ).rejects.toThrow(/protocol.*400|transport.*400/i);
    expect(protocolRequests).toBe(1);
  });

  it('reports a bounded not-found timeout and probes 404 as the only absent state', async () => {
    const registry = await loadRegistryModule();
    const notFoundFetch = (async () => new Response('missing', { status: 404 })) as typeof fetch;
    expect(
      await registry.probeRegistryVersion({
        packageName: 'scriptspect',
        version: '0.1.0',
        registryUrl: 'https://registry.example',
        fetchImpl: notFoundFetch,
      }),
    ).toEqual({ status: 'not-found', package: 'scriptspect', version: '0.1.0' });

    const delays: number[] = [];
    await expect(
      registry.fetchRegistryArtifact({
        packageName: 'scriptspect',
        version: '0.1.0',
        outputPath: join(temporaryDirectory('not-found'), 'registry.tgz'),
        attempts: 3,
        baseDelayMs: 2,
        maxDelayMs: 3,
        registryUrl: 'https://registry.example',
        fetchImpl: notFoundFetch,
        sleep: async (milliseconds) => {
          delays.push(milliseconds);
        },
      }),
    ).rejects.toThrow(/not found after 3 attempts/i);
    expect(delays).toEqual([2, 3]);
  });
});
