export type RegistryFetch = typeof fetch;

export type RegistryProbeOptions = {
  packageName: string;
  version: string;
  registryUrl?: string;
  fetchImpl?: RegistryFetch;
  requestTimeoutMs?: number;
};

export type RegistryArtifactOptions = RegistryProbeOptions & {
  outputPath: string;
  attempts: number;
  baseDelayMs: number;
  maxDelayMs: number;
  sleep?: (milliseconds: number) => Promise<void>;
};

export function probeRegistryVersion(
  options: RegistryProbeOptions,
): Promise<{ status: 'found' | 'not-found'; package: string; version: string }>;

export function fetchRegistryArtifact(options: RegistryArtifactOptions): Promise<{
  package: string;
  version: string;
  registryNpmSRI: string;
  attempts: number;
  byteLength: number;
}>;
