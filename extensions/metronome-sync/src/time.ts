// 9999-12-31T23:59:59Z, the largest instant RFC 3339 can represent.
const MAX_UNIX_SECONDS = 253402300799;

export type TimestampResult =
  { ok: true; value: string; epochMs: number } | { ok: false; reason: string };

/**
 * Accepts Unix seconds (as a number or digit string, which is what Stripe
 * emits) or an RFC 3339 string, and normalises to UTC RFC 3339 with
 * millisecond precision, e.g. `2024-01-01T00:00:00.000Z`.
 */
export function toRfc3339(value: unknown): TimestampResult {
  if (typeof value === 'number') {
    return fromUnixSeconds(value);
  }
  if (typeof value !== 'string') {
    return { ok: false, reason: 'must be Unix seconds or an RFC 3339 timestamp' };
  }
  const trimmed = value.trim();
  if (/^\d+$/.test(trimmed)) {
    return fromUnixSeconds(Number(trimmed));
  }
  if (!isRfc3339Shape(trimmed)) {
    return { ok: false, reason: 'must be Unix seconds or an RFC 3339 timestamp' };
  }
  const epochMs = Date.parse(trimmed);
  if (Number.isNaN(epochMs)) {
    return { ok: false, reason: 'is not a valid RFC 3339 timestamp' };
  }
  return { ok: true, value: new Date(epochMs).toISOString(), epochMs };
}

/**
 * Metronome requires credit schedule dates on an hour boundary. Flooring both
 * ends keeps consecutive Stripe periods contiguous and is stable across retries.
 */
export function floorToUtcHour(epochMs: number): { value: string; epochMs: number } {
  const floored = epochMs - (epochMs % 3_600_000);
  return { value: new Date(floored).toISOString(), epochMs: floored };
}

/** Date, time, and an explicit offset are required; Date.parse validates the rest. */
function isRfc3339Shape(value: string): boolean {
  return (
    /^\d\d\d\d-\d\d-\d\dT\d\d:\d\d:\d\d/i.test(value) &&
    /(?:Z|[+-]\d\d:\d\d)$/i.test(value)
  );
}

function fromUnixSeconds(seconds: number): TimestampResult {
  if (!Number.isSafeInteger(seconds) || seconds < 0 || seconds > MAX_UNIX_SECONDS) {
    return { ok: false, reason: 'must be a non-negative integer number of Unix seconds' };
  }
  const epochMs = seconds * 1000;
  return { ok: true, value: new Date(epochMs).toISOString(), epochMs };
}
