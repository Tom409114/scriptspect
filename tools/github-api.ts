/** Shared GitHub HTTP failure evidence. Tokens stay in request headers only. */

export type GitHubFailureKind =
  | 'primary-rate-limit-exhausted'
  | 'secondary-rate-limit'
  | 'authentication-failed'
  | 'permission-denied'
  | 'not-found'
  | 'http-error'
  | 'response-invalid';

export interface GitHubFailureEvidence {
  kind: GitHubFailureKind;
  status: number | null;
  url: string;
  rateLimit: {
    limit: string | null;
    remaining: string | null;
    reset: string | null;
    used: string | null;
    resource: string | null;
  };
  retryAfter: string | null;
  requestId: string | null;
}

export class GitHubRequestError extends Error {
  readonly evidence: GitHubFailureEvidence;

  constructor(message: string, evidence: GitHubFailureEvidence) {
    super(message);
    this.name = 'GitHubRequestError';
    this.evidence = evidence;
  }
}

function responseHeaders(response: Response): Omit<GitHubFailureEvidence, 'kind' | 'url'> {
  return {
    status: response.status,
    rateLimit: {
      limit: response.headers.get('x-ratelimit-limit'),
      remaining: response.headers.get('x-ratelimit-remaining'),
      reset: response.headers.get('x-ratelimit-reset'),
      used: response.headers.get('x-ratelimit-used'),
      resource: response.headers.get('x-ratelimit-resource'),
    },
    retryAfter: response.headers.get('retry-after'),
    requestId: response.headers.get('x-github-request-id'),
  };
}

function failureKind(response: Response, responseText: string): GitHubFailureKind {
  const metadata = responseHeaders(response);
  const lower = responseText.toLowerCase();
  if (metadata.rateLimit.remaining === '0') return 'primary-rate-limit-exhausted';
  if (
    response.status === 429 ||
    metadata.retryAfter !== null ||
    lower.includes('secondary rate limit') ||
    lower.includes('abuse detection')
  ) {
    return 'secondary-rate-limit';
  }
  if (response.status === 401) return 'authentication-failed';
  if (response.status === 403) return 'permission-denied';
  if (response.status === 404) return 'not-found';
  return 'http-error';
}

export function githubErrorFromResponse(
  response: Response,
  url: string,
  label: string,
  responseText: string,
  message = `${label} ${response.status} for ${url}`,
): GitHubRequestError {
  return new GitHubRequestError(message, {
    kind: failureKind(response, responseText),
    url,
    ...responseHeaders(response),
  });
}

export function invalidGitHubResponse(
  url: string,
  message: string,
  response?: Response,
): GitHubRequestError {
  return new GitHubRequestError(message, {
    kind: 'response-invalid',
    url,
    ...(response === undefined
      ? {
          status: null,
          rateLimit: { limit: null, remaining: null, reset: null, used: null, resource: null },
          retryAfter: null,
          requestId: null,
        }
      : responseHeaders(response)),
  });
}

/** Persist a semantic GitHub failure even when GraphQL returns HTTP 200. */
export function classifiedGitHubError(
  kind: GitHubFailureKind,
  url: string,
  message: string,
  response?: Response,
): GitHubRequestError {
  return new GitHubRequestError(message, {
    kind,
    url,
    ...(response === undefined
      ? {
          status: null,
          rateLimit: { limit: null, remaining: null, reset: null, used: null, resource: null },
          retryAfter: null,
          requestId: null,
        }
      : responseHeaders(response)),
  });
}

export function githubFailureEvidence(error: unknown): GitHubFailureEvidence | undefined {
  return error instanceof GitHubRequestError ? error.evidence : undefined;
}

export function githubApiHeaders(token: string, userAgent: string): Record<string, string> {
  return {
    Accept: 'application/vnd.github+json',
    Authorization: `Bearer ${token}`,
    'Content-Type': 'application/json',
    'X-GitHub-Api-Version': '2022-11-28',
    'User-Agent': userAgent,
  };
}

export async function checkedResponse(
  fetchImpl: typeof fetch,
  url: string,
  init: RequestInit,
  label: string,
): Promise<Response> {
  const response = await fetchImpl(url, init);
  if (response.ok) return response;
  const responseText = await response.text();
  throw githubErrorFromResponse(response, url, label, responseText);
}

export async function githubApiResponse(
  fetchImpl: typeof fetch,
  url: string,
  token: string,
  userAgent: string,
  init: RequestInit = {},
): Promise<Response> {
  return checkedResponse(
    fetchImpl,
    url,
    {
      ...init,
      headers: { ...githubApiHeaders(token, userAgent), ...(init.headers ?? {}) },
    },
    'GitHub API',
  );
}
