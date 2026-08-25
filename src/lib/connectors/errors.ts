/**
 * The connector failure taxonomy.
 *
 * Every failure below `HttpConnector.request()` is normalised into a
 * `ConnectorError` carrying one of these categories. App code branches on the
 * category, never on a raw status number — and the platform turns the category
 * into something a human can act on.
 *
 * **The upstream response body is never read into an error.** Per invariant 16
 * in connectors/AGENTS.md, those bodies routinely carry account and tenant
 * detail. We keep the status, our own classification, and (when the upstream
 * offers one) an opaque request id for support. Nothing else.
 */

export type ConnectorErrorCategory =
  /** No credentials configured — `configured` is false. An admin must act. */
  | "unconfigured"
  /** 401, or an OAuth refresh that failed. The credential itself is bad. */
  | "auth_failed"
  /** Credential is valid but lacks the scope/permission for this call. */
  | "forbidden"
  /** 429, or a 403/503 carrying rate-limit signals. Back off and retry. */
  | "rate_limited"
  /** 404 / 410 — the resource is not there. */
  | "not_found"
  /** 400 / 405 / 415 / 422 — the call itself is wrong. Never retryable. */
  | "invalid_request"
  /** 409 / 412 / 428 — state conflict the caller has to resolve. */
  | "conflict"
  /** 413 / 414 — request too big. Chunk it. */
  | "payload_too_large"
  /** Client abort, 408, or 504. */
  | "timeout"
  /** 5xx. The upstream is unwell. */
  | "upstream_error"
  /** DNS / TCP / TLS — `fetch` itself threw, no response existed. */
  | "network_error"
  /** 2xx whose body was not what the connector declared it would be. */
  | "unexpected_response";

/**
 * Categories worth retrying. `auth_failed` is deliberately absent: a 401 is
 * retried at most once, and only by the auth layer after refreshing a token —
 * blind retries of a bad credential just burn the rate limit.
 */
export const RETRYABLE_CATEGORIES: ReadonlySet<ConnectorErrorCategory> = new Set([
  "rate_limited",
  "timeout",
  "upstream_error",
  "network_error",
]);

/**
 * Default user-facing copy per category. Written for someone who does not know
 * what an API is: no status codes, no jargon, and always a hint about who can
 * fix it. `{subject}` is replaced with the connector's display name.
 *
 * A connector author never writes these. That is the point — left to their own
 * devices they write "Error: 500", which tells a user nothing.
 */
const USER_MESSAGES: Record<ConnectorErrorCategory, string> = {
  unconfigured:
    "{subject} isn't set up yet — an administrator needs to finish connecting it.",
  auth_failed:
    "{subject} rejected our credentials — an administrator needs to reconnect it.",
  forbidden:
    "{subject} won't allow this — an administrator may need to grant additional permissions.",
  rate_limited:
    "{subject} is temporarily busy. Please try again in a moment.",
  not_found: "That item could not be found in {subject}.",
  invalid_request: "{subject} couldn't process that request.",
  conflict:
    "That change conflicts with something already in {subject}. Refresh and try again.",
  payload_too_large: "That request was too large for {subject} to accept.",
  timeout: "{subject} took too long to respond. Please try again.",
  upstream_error:
    "{subject} is having trouble right now. Please try again shortly.",
  network_error: "We couldn't reach {subject}. Please try again shortly.",
  unexpected_response:
    "{subject} returned something we didn't expect. An administrator has been able to see the details.",
};

/**
 * What an admin should actually do. Surfaced only to admins (see the Phase 3
 * response layer) because it names internals a regular user shouldn't see.
 */
const ADMIN_HINTS: Record<ConnectorErrorCategory, string> = {
  unconfigured:
    "Open Administration → Connector Registry and enter this connector's credentials.",
  auth_failed:
    "The stored credential is invalid, expired, or revoked. Re-enter it (or reconnect) in the Connector Registry, then use Test Connection.",
  forbidden:
    "The credential authenticated but lacks the required scope. Re-provision it upstream with the scopes listed in the connector's description.",
  rate_limited:
    "The upstream rate limit was hit. If this is frequent, reduce call volume or request a higher quota.",
  not_found:
    "Either the record genuinely doesn't exist, or the configured base URL points at the wrong environment. Check the base URL in the Connector Registry.",
  invalid_request:
    "The connector sent something the upstream rejected. This is a bug in the connector or the calling app, not a configuration problem.",
  conflict:
    "The upstream refused the change because its state moved underneath us. Retrying identically will fail the same way.",
  payload_too_large:
    "Reduce the request size — page the input or send it in chunks.",
  timeout:
    "The upstream didn't respond in time. If it persists, check the provider's status page.",
  upstream_error:
    "The upstream returned a server error. Check the provider's status page; the request id below helps their support team.",
  network_error:
    "The upstream host was unreachable — DNS, TLS, or connectivity. Verify the base URL is correct and resolvable.",
  unexpected_response:
    "The response didn't match what the connector expects, which usually means the upstream API changed. The connector needs updating.",
};

export interface ConnectorErrorInit {
  category: ConnectorErrorCategory;
  /** Connector slug (folder name). */
  connectorName: string;
  /** Display name used in user-facing copy. Falls back to the slug. */
  subject?: string;
  status?: number | null;
  retryAfterMs?: number | null;
  attempts?: number;
  upstreamRequestId?: string | null;
  /** Server-side only. Never serialised. */
  cause?: unknown;
  /** Override the default copy. Rarely needed. */
  userMessage?: string;
  adminHint?: string;
}

/**
 * A normalised connector failure.
 *
 * `userMessage` is safe to show anyone. `adminHint` is safe to show admins.
 * `cause` is non-enumerable, so `JSON.stringify(err)` cannot leak the original
 * error (which may carry a URL with a key in the query string).
 */
export class ConnectorError extends Error {
  readonly name = "ConnectorError";
  readonly category: ConnectorErrorCategory;
  readonly connectorName: string;
  readonly subject: string;
  readonly status: number | null;
  readonly retryAfterMs: number | null;
  readonly retryable: boolean;
  readonly attempts: number;
  readonly userMessage: string;
  readonly adminHint: string;
  readonly upstreamRequestId: string | null;

  constructor(init: ConnectorErrorInit) {
    const subject = init.subject ?? init.connectorName;
    const userMessage =
      init.userMessage ?? USER_MESSAGES[init.category].replaceAll("{subject}", subject);

    // The `message` is for server logs only. It carries the status and our
    // classification — never an upstream body.
    super(
      `[${init.connectorName}] ${init.category}` +
        (init.status != null ? ` (HTTP ${init.status})` : ""),
    );

    this.category = init.category;
    this.connectorName = init.connectorName;
    this.subject = subject;
    this.status = init.status ?? null;
    this.retryAfterMs = init.retryAfterMs ?? null;
    this.retryable = RETRYABLE_CATEGORIES.has(init.category);
    this.attempts = init.attempts ?? 1;
    this.userMessage = userMessage;
    this.adminHint = init.adminHint ?? ADMIN_HINTS[init.category];
    this.upstreamRequestId = init.upstreamRequestId ?? null;

    // Non-enumerable so it survives `instanceof` checks and server logging but
    // never reaches a JSON response body.
    Object.defineProperty(this, "cause", {
      value: init.cause,
      enumerable: false,
      writable: false,
      configurable: true,
    });
  }
}

/** Narrowing helper for app code and route handlers. */
export function isConnectorError(err: unknown): err is ConnectorError {
  return err instanceof ConnectorError;
}
