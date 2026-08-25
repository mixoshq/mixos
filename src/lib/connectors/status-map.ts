import type { ConnectorErrorCategory } from "./errors";

/**
 * HTTP status → connector error category.
 *
 * This is the single place the platform decides what a status *means*. Getting
 * it wrong in one connector is a bug; getting it wrong here is a bug everywhere,
 * so the table is exhaustive and commented rather than clever.
 *
 * Two rules are load-bearing and easy to miss:
 *
 *  1. **Rate limiting is signalled by headers, not by 429 alone.** Some APIs
 *     throttle with 403 and others with 503. A `Retry-After` (or an exhausted
 *     `X-RateLimit-Remaining`) outranks the status code — misreading a throttle
 *     as a permissions failure means never retrying a call that would succeed.
 *  2. **204/205/304 have no body.** Calling `res.json()` on them throws. This is
 *     the most common defect in hand-rolled API clients.
 */

export interface StatusClassification {
  category: ConnectorErrorCategory;
  retryable: boolean;
}

/** Statuses that carry no response body. Never parse these. */
const BODYLESS = new Set([204, 205, 304]);

export function isBodyless(status: number): boolean {
  return BODYLESS.has(status);
}

/** 2xx, plus 304 which is a cache hit rather than a failure. */
export function isSuccess(status: number): boolean {
  return (status >= 200 && status < 300) || status === 304;
}

export interface ClassifyOptions {
  /** A `Retry-After` header was present on the response. */
  hasRetryAfter?: boolean;
  /** Rate-limit headers indicate the budget is exhausted. */
  rateLimitExhausted?: boolean;
  /** Manifest opt-in: this API uses 403 to mean "slow down". */
  rateLimitOn403?: boolean;
}

/**
 * Classify a non-success status. Callers must check `isSuccess` first.
 */
export function classifyStatus(
  status: number,
  opts: ClassifyOptions = {},
): StatusClassification {
  const throttled = opts.hasRetryAfter === true || opts.rateLimitExhausted === true;

  // ── 3xx ──────────────────────────────────────────────────────────────────
  // `fetch` follows redirects by default, so a 3xx that reaches us means a
  // redirect loop or `redirect: "manual"`. Neither is fixed by retrying.
  if (status >= 300 && status < 400) {
    return { category: "upstream_error", retryable: false };
  }

  // ── 4xx ──────────────────────────────────────────────────────────────────
  if (status >= 400 && status < 500) {
    switch (status) {
      case 401:
        // Not retryable here. The auth layer replays a 401 exactly once, after
        // refreshing — a blind retry just spends rate limit on a bad token.
        return { category: "auth_failed", retryable: false };
      case 403:
        // A scope problem, unless this API throttles with 403.
        return throttled || opts.rateLimitOn403
          ? { category: "rate_limited", retryable: true }
          : { category: "forbidden", retryable: false };
      case 404:
      case 410:
        return { category: "not_found", retryable: false };
      case 408:
        return { category: "timeout", retryable: true };
      case 409:
      case 412:
      case 428:
        return { category: "conflict", retryable: false };
      case 413:
      case 414:
        return { category: "payload_too_large", retryable: false };
      case 425:
        // Too Early — the upstream declined to risk replay. Backing off is
        // exactly the right response.
        return { category: "timeout", retryable: true };
      case 429:
        return { category: "rate_limited", retryable: true };
      case 400:
      case 405:
      case 415:
      case 422:
      case 431:
        return { category: "invalid_request", retryable: false };
      default:
        // Conservative: an unknown 4xx is the caller's fault until proven
        // otherwise, and hammering it helps nobody.
        return { category: "invalid_request", retryable: false };
    }
  }

  // ── 5xx ──────────────────────────────────────────────────────────────────
  if (status >= 500) {
    switch (status) {
      case 501:
      case 505:
      case 506:
        // Not implemented / protocol-level. Retrying never changes the answer.
        return { category: "upstream_error", retryable: false };
      case 503:
        // A 503 *with* Retry-After is a throttle, not an outage.
        return throttled
          ? { category: "rate_limited", retryable: true }
          : { category: "upstream_error", retryable: true };
      case 504:
        return { category: "timeout", retryable: true };
      default:
        return { category: "upstream_error", retryable: true };
    }
  }

  // Below 300 and not a success — shouldn't happen; treat defensively.
  return { category: "unexpected_response", retryable: false };
}

/**
 * Parse `Retry-After`, which is either delta-seconds or an HTTP-date.
 * Returns milliseconds, or null if absent/unparseable. Never negative.
 */
export function parseRetryAfter(
  headerValue: string | null,
  now: number = Date.now(),
): number | null {
  if (!headerValue) return null;
  const trimmed = headerValue.trim();

  // delta-seconds
  if (/^\d+$/.test(trimmed)) {
    return Number(trimmed) * 1000;
  }

  // HTTP-date
  const when = Date.parse(trimmed);
  if (Number.isNaN(when)) return null;
  return Math.max(0, when - now);
}

/**
 * Common rate-limit headers, lowercased. Checked in order; the first one
 * present decides. `remaining: 0` means the budget is spent.
 */
const REMAINING_HEADERS = [
  "x-ratelimit-remaining",
  "ratelimit-remaining",
  "x-rate-limit-remaining",
];

export function isRateLimitExhausted(headers: Headers): boolean {
  for (const key of REMAINING_HEADERS) {
    const raw = headers.get(key);
    if (raw == null) continue;
    const remaining = Number(raw.trim());
    if (!Number.isNaN(remaining)) return remaining <= 0;
  }
  return false;
}

/**
 * An opaque upstream request id, when one is offered. Safe to surface — it
 * identifies the call, not the account — and it is the first thing a provider's
 * support team asks for.
 */
const REQUEST_ID_HEADERS = [
  "x-request-id",
  "x-correlation-id",
  "x-amzn-requestid",
  "cf-ray",
  "request-id",
];

export function extractRequestId(headers: Headers): string | null {
  for (const key of REQUEST_ID_HEADERS) {
    const value = headers.get(key);
    if (value) return value.slice(0, 200);
  }
  return null;
}
