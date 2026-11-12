// Codes must match `methods.execute.errors` in stripe-app.yaml; the manifest
// decides whether Stripe retries each one.
export type ActionErrorCode =
  | 'invalid_input'
  | 'metronome_auth_failed'
  | 'metronome_request_rejected'
  | 'metronome_rate_limited'
  | 'metronome_unavailable';

export function isRetryableCode(code: ActionErrorCode): boolean {
  return code === 'metronome_rate_limited' || code === 'metronome_unavailable';
}

export class ActionError extends Error {
  readonly code: ActionErrorCode;
  readonly retryable: boolean;

  constructor(code: ActionErrorCode, message: string) {
    // Don't set `this.name`: the Script runtime freezes Error.prototype, so
    // assigning the inherited read-only `name` throws a TypeError.
    super(message);
    this.code = code;
    this.retryable = isRetryableCode(code);
  }
}

export type MetronomeErrorClassification =
  | { kind: 'already_exists' }
  | {
      kind: 'retryable';
      code: 'metronome_rate_limited' | 'metronome_unavailable';
      detail: string;
    }
  | {
      kind: 'permanent';
      code: 'metronome_auth_failed' | 'metronome_request_rejected';
      detail: string;
    };

/** Shape of `EndpointFetchError` (and the test helper's `MockEndpointFetchError`). */
interface FetchErrorLike {
  code?: unknown;
  status?: unknown;
  body?: unknown;
}

const MAX_DETAIL_LENGTH = 300;

export function classifyMetronomeError(error: unknown): MetronomeErrorClassification {
  const { code, status, body } = readFetchError(error);
  const upstream = safeUpstreamMessage(body);
  const describe = (label: string): string =>
    [label, status === undefined ? undefined : `HTTP ${String(status)}`, upstream]
      .filter((part) => part !== undefined)
      .join(': ');

  if (status === 409) {
    return { kind: 'already_exists' };
  }
  if (
    status === 401 ||
    status === 403 ||
    code === 'EXT_UNAUTHORIZED' ||
    code === 'EXT_NOT_ALLOWED'
  ) {
    return {
      kind: 'permanent',
      code: 'metronome_auth_failed',
      detail: describe('Metronome authentication failed'),
    };
  }
  if (code === 'ERR_CONFIG') {
    return {
      kind: 'permanent',
      code: 'metronome_auth_failed',
      detail: describe('Metronome endpoint or secret is misconfigured'),
    };
  }
  if (status === 429 || code === 'EXT_RATE_LIMIT') {
    return {
      kind: 'retryable',
      code: 'metronome_rate_limited',
      detail: describe('Metronome rate limited the request'),
    };
  }
  if (
    (status !== undefined && (status >= 500 || status === 408)) ||
    code === 'EXT_TIMEOUT' ||
    code === 'EXT_RESOURCE_UNAVAILABLE' ||
    code === 'ERR_NETWORK' ||
    code === 'ERR_INTERNAL'
  ) {
    return {
      kind: 'retryable',
      code: 'metronome_unavailable',
      detail: describe('Metronome is unavailable'),
    };
  }
  if (status !== undefined && status >= 400) {
    return {
      kind: 'permanent',
      code: 'metronome_request_rejected',
      detail: describe('Metronome rejected the request'),
    };
  }
  // No HTTP status and no recognised code: treat like a network failure.
  return {
    kind: 'retryable',
    code: 'metronome_unavailable',
    detail: describe('Metronome request failed'),
  };
}

function readFetchError(error: unknown): {
  code?: string;
  status?: number;
  body?: string;
} {
  if (typeof error !== 'object' || error === null) {
    return {};
  }
  const { code, status, body } = error as FetchErrorLike;
  return {
    code: typeof code === 'string' ? code : undefined,
    status: typeof status === 'number' ? status : undefined,
    body: typeof body === 'string' ? body : undefined,
  };
}

/**
 * Metronome error bodies look like `{"message": "..."}`. Only that field is
 * surfaced, truncated, so raw upstream payloads never reach Workflow run logs.
 */
function safeUpstreamMessage(body: string | undefined): string | undefined {
  if (body === undefined || body === '') {
    return undefined;
  }
  let message: unknown;
  try {
    message = (JSON.parse(body) as { message?: unknown }).message;
  } catch {
    return undefined;
  }
  if (typeof message !== 'string' || message === '') {
    return undefined;
  }
  const redacted = message.replace(/bearer\s+\S+/gi, 'Bearer [redacted]');
  return redacted.length > MAX_DETAIL_LENGTH
    ? `${redacted.slice(0, MAX_DETAIL_LENGTH)}…`
    : redacted;
}
