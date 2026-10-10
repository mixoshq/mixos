/* This Source Code Form is subject to the terms of the Mozilla Public
 * License, v. 2.0. If a copy of the MPL was not distributed with this
 * file, You can obtain one at https://mozilla.org/MPL/2.0/. */

import { ConnectorError, isConnectorError } from "./errors";
import type { ConnectorErrorCategory } from "./errors";

/**
 * Turning a connector failure into something a human can act on.
 *
 * Two audiences, one payload. Everyone gets a named, non-technical sentence —
 * "Billing data is unavailable right now, an administrator needs to finish
 * setting up Acme Billing" — because a user who can't see *which* integration
 * broke can't tell their admin anything useful. Only admins additionally get
 * `adminHint`, the upstream request id, and a deep link to the Registry.
 *
 * The upstream response body never appears in either. `ConnectorError` never
 * captured it (invariant 16), so there is nothing here to leak.
 *
 * Framework-free on purpose: this returns a standard `Response`, so app routes,
 * server actions, and the verification harness all use the same code path.
 */

export type EnvelopeCategory = ConnectorErrorCategory | "internal_error";

export interface ConnectorErrorEnvelope {
  error: {
    /** Coarse machine-readable cause. Drives which treatment the UI renders. */
    category: EnvelopeCategory;
    /** Safe to show anyone. */
    message: string;
    /** The connector's display name, or null when the failure wasn't one. */
    connector: string | null;
    /** When the upstream told us how long to wait. */
    retryAfterMs: number | null;
    // ── admins only, omitted entirely otherwise ──
    adminHint?: string;
    adminActionUrl?: string;
    upstreamRequestId?: string | null;
    status?: number | null;
  };
}

/**
 * Category → HTTP status.
 *
 * The guiding question is "whose problem is this, from the caller's side?" A
 * missing credential is not the caller's fault and not their fix, so it is a
 * 503 rather than a 500 — it is genuinely a temporarily unavailable dependency.
 * `invalid_request` maps to 502, not 400: the *connector* sent something the
 * upstream rejected, which is our defect, not the HTTP client's.
 */
const HTTP_STATUS: Record<ConnectorErrorCategory, number> = {
  unconfigured: 503,
  auth_failed: 503,
  forbidden: 503,
  rate_limited: 429,
  not_found: 404,
  invalid_request: 502,
  conflict: 409,
  payload_too_large: 413,
  timeout: 504,
  upstream_error: 502,
  network_error: 502,
  unexpected_response: 502,
};

/**
 * Failures an admin has to resolve. From a user's seat these are one problem —
 * "someone needs to fix the connection" — even though the causes differ.
 */
const ADMIN_ACTIONABLE: ReadonlySet<ConnectorErrorCategory> = new Set([
  "unconfigured",
  "auth_failed",
  "forbidden",
]);

export function isAdminActionable(category: EnvelopeCategory): boolean {
  return ADMIN_ACTIONABLE.has(category as ConnectorErrorCategory);
}

/**
 * Is this parsed response body a connector failure envelope?
 *
 * Structural rather than `instanceof`, because it runs where there is no
 * ConnectorError to check against: in the browser, on the JSON a route
 * answered with.
 */
export function isConnectorErrorEnvelope(
  value: unknown,
): value is ConnectorErrorEnvelope {
  const error = (value as { error?: unknown } | null)?.error;
  return (
    typeof error === "object" &&
    error !== null &&
    typeof (error as { category?: unknown }).category === "string" &&
    typeof (error as { message?: unknown }).message === "string"
  );
}

/** Deep link to the Registry row for this connector. */
export function registryUrlFor(connectorName: string): string {
  return `/admin/connectors?connector=${encodeURIComponent(connectorName)}`;
}

export interface EnvelopeOptions {
  /** Attach admin-only fields. Read from `context.user.isAdmin`. */
  isAdmin?: boolean;
}

export interface BuiltEnvelope {
  body: ConnectorErrorEnvelope;
  status: number;
  headers: Record<string, string>;
}

/**
 * Build the envelope, status, and headers for any thrown value.
 *
 * A non-ConnectorError becomes a bare `internal_error` with no detail at all:
 * an unexpected throw is exactly the case where we cannot reason about what the
 * message contains, so none of it is forwarded.
 */
export function connectorErrorEnvelope(
  err: unknown,
  opts: EnvelopeOptions = {},
): BuiltEnvelope {
  const headers: Record<string, string> = { "Cache-Control": "no-store" };

  if (!isConnectorError(err)) {
    return {
      status: 500,
      headers,
      body: {
        error: {
          category: "internal_error",
          message: "Something went wrong. Please try again.",
          connector: null,
          retryAfterMs: null,
        },
      },
    };
  }

  const e: ConnectorError = err;
  const status = HTTP_STATUS[e.category];

  // Give a rate-limited caller the same signal the upstream gave us, in the
  // header they already know how to read.
  if (e.retryAfterMs != null && status === 429) {
    headers["Retry-After"] = String(Math.max(1, Math.ceil(e.retryAfterMs / 1000)));
  }

  const body: ConnectorErrorEnvelope = {
    error: {
      category: e.category,
      message: e.userMessage,
      connector: e.subject,
      retryAfterMs: e.retryAfterMs,
    },
  };

  if (opts.isAdmin) {
    body.error.adminHint = e.adminHint;
    body.error.adminActionUrl = registryUrlFor(e.connectorName);
    body.error.upstreamRequestId = e.upstreamRequestId;
    body.error.status = e.status;
  }

  return { body, status, headers };
}

/**
 * The envelope as a Response, for code that owns its own Response — a `raw`
 * route, a server action:
 *
 *   try {
 *     return Response.json(await context.connectors.acme.listThings());
 *   } catch (err) {
 *     return connectorErrorResponse(err, { isAdmin: context.user?.isAdmin });
 *   }
 *
 * A `defineRoute` handler does not need it: a ConnectorError it lets propagate
 * is answered with this same envelope by the route pipeline (see
 * `toErrorResponse` in src/lib/apps/errors.ts).
 */
export function connectorErrorResponse(
  err: unknown,
  opts: EnvelopeOptions = {},
): Response {
  const { body, status, headers } = connectorErrorEnvelope(err, opts);
  return Response.json(body, { status, headers });
}
