/* This Source Code Form is subject to the terms of the Mozilla Public
 * License, v. 2.0. If a copy of the MPL was not distributed with this
 * file, You can obtain one at https://mozilla.org/MPL/2.0/. */

import type { ConnectorErrorCategory } from "./errors";

export interface ConnectorManifest {
  name: string;
  displayName: string;
  /**
   * Public URL of the connector's icon, e.g. `/connector-assets/gmail/icon.png`.
   * Authored as a filename inside `connectors/<name>/assets/`; the generator
   * copies the directory to `public/connector-assets/<name>/` and rewrites this to
   * the URL. Absent when the connector ships no artwork, which the registry
   * renders as a generic plug glyph.
   */
  icon?: string;
  /**
   * Each person signs into their own account, instead of sharing the one an
   * admin connected. Three-legged OAuth only; the grant lives in
   * `user_connector_oauth` keyed by user, while the client id and secret stay
   * tenant-wide in `connector_configs` — the *application* is registered once,
   * only the *grant* is personal.
   */
  userScoped?: boolean;
  /**
   * What the **service** is, in a sentence or two — "Highly popular email
   * service by Google." Not what this connector does with it, and not how to
   * set it up: that is `setup`. Capped at 140 characters by the schema.
   *
   * The registry tile shows the first 15 words; the configure dialog shows all
   * of it. So the first sentence should stand on its own.
   */
  description: string;
  /**
   * How an admin provisions the credentials, structured so the registry can
   * render numbered steps with working links. Optional — a connector needing
   * nothing but a pasted API key can omit it.
   */
  setup?: ConnectorSetupGuide;
  credentialFields: CredentialField[];
  authors: ConnectorAuthor[];
  /**
   * Epoch millis of the last commit that touched this item, stamped into the
   * manifest by scripts/stamp-updated.ts. Null when nothing has been committed
   * yet — the UI renders that as "Not yet committed", not as a missing value.
   *
   * The manifest stores this as an ISO 8601 string (legible in a diff); the
   * generator parses it to millis here so the UI can do date arithmetic without
   * re-parsing on every render.
   *
   * Derived from the commit, not from a separate publish step: any commit
   * touching the directory rewrites it. That means a formatting pass or a
   * dependency bump inside the item does move the date — the tradeoff accepted
   * in exchange for a date that can never be forgotten. Written only by
   * scripts/stamp-updated.ts.
   */
  lastUpdated: number | null;
  /**
   * Connector methods to auto-instrument for usage telemetry. Each declared
   * method is wrapped by the platform's `context.connectors.<name>` proxy so a
   * telemetry event is recorded whenever an app calls it — the connector class
   * itself is never modified and records nothing directly. Defaults to `[]`
   * (no instrumentation). See `docs/connectors/telemetry.md`.
   */
  telemetry: ConnectorTelemetryDefinition[];
  /**
   * How the platform authenticates to this API. Declared, not coded — a
   * connector author picks a strategy and names the fields; `HttpConnector`
   * applies it. Absent means `{ strategy: "none" }`.
   */
  auth?: ConnectorAuthPolicy;
  /**
   * Transport policy: base URL, timeouts, retry budget, pagination. Every
   * value has a working default, so a manifest may omit this entirely.
   */
  http?: ConnectorHttpPolicy;
  /** Inbound webhook verification. Implemented in a later phase. */
  webhook?: ConnectorWebhookPolicy;
}

// ── Declarative policy ──────────────────────────────────────────────────────

export type ConnectorAuthStrategy =
  | "none"
  | "apiKey"
  | "basic"
  | "oauth2_client_credentials"
  | "oauth2_authorization_code";

/** How a scope's own description classifies it. Derived, never hand-written. */
export type ConnectorScopeAccess = "read" | "write" | "read-write";

/** One row of a provider's documented scope table. */
export interface ConnectorScope {
  scope: string;
  /** The provider's own wording, as shown on their consent screen. */
  description?: string;
  access?: ConnectorScopeAccess;
  /** Does this connector ask for it at authorization time? */
  requested: boolean;
}

export interface ConnectorAuthPolicy {
  strategy: ConnectorAuthStrategy;
  /** apiKey: where the credential goes. Default "bearer". */
  in?: "header" | "query" | "bearer";
  /** apiKey: header or query-parameter name (e.g. "X-Api-Key", "api_key"). */
  name?: string;
  /** apiKey: value prefix, e.g. "Token " — include the trailing space. */
  prefix?: string;
  /**
   * Credential keys this strategy reads, so `configured` can be derived rather
   * than hand-written. Must match `credentialFields[].key`.
   */
  credentialKeys?: string[];
  /** oauth2_*: token endpoint. */
  tokenUrl?: string;
  /**
   * oauth2_*: how the client authenticates *at the token endpoint*.
   * "basic" sends HTTP Basic (RFC 6749 §2.3.1, mandatory for servers to
   * support — the safer default); "post" puts the credentials in the form
   * body, which some providers require instead. Default "basic".
   */
  tokenAuth?: "basic" | "post";
  /** oauth2_authorization_code: authorization endpoint. */
  authorizeUrl?: string;
  /**
   * oauth2_*: every scope this API documents, each flagged with whether this
   * connector asks for it. Only the `requested` ones are sent at authorization
   * time — minimum set only, per invariant 17.
   *
   * Written by `scripts/check-scopes.ts <connector> --write` from `scopesUrl`.
   * The catalogue lives here, in the manifest, rather than in a database row an
   * admin populated: it is a property of the connector, it travels with the
   * code, and it shows up in a diff.
   */
  scopes?: ConnectorScope[];
  /**
   * The provider's scope reference page, parsed by the Connector Registry to
   * show permissions in plain English. Must be a page that tabulates scopes
   * against descriptions.
   */
  scopesUrl?: string;
}

export interface ConnectorHttpPolicy {
  /** Default base URL. A `baseUrl` credential overrides it at runtime. */
  baseUrl?: string;
  /** Per-attempt timeout. Default 10000. */
  timeoutMs?: number;
  /** Ceiling for the whole call including retries. Default 15000. */
  deadlineMs?: number;
  /** Total tries, not retries. Default 3 — i.e. one call plus two retries. */
  maxAttempts?: number;
  /** Narrow which categories are retried. Defaults to the transient set. */
  retryOn?: ConnectorErrorCategory[];
  /** Sent on every request unless overridden per call. */
  defaultHeaders?: Record<string, string>;
  /** This API throttles with 403 rather than 429. */
  rateLimitOn403?: boolean;
  /** Cap on a single response body, in bytes. Default 8 MiB. */
  maxResponseBytes?: number;
  pagination?: ConnectorPaginationPolicy;
}

export type ConnectorPaginationStyle =
  "cursor" | "offset" | "page" | "link-header";

export interface ConnectorPaginationPolicy {
  style: ConnectorPaginationStyle;
  /** Dot-path to the item array in a response body. Default: the body itself. */
  itemsPath?: string;
  /** cursor: dot-path to the next cursor, and the parameter to send it back in. */
  cursorPath?: string;
  cursorParam?: string;
  /** offset/page: parameter names. */
  limitParam?: string;
  offsetParam?: string;
  pageParam?: string;
  /** Items requested per page. */
  pageSize?: number;
  /** Hard stop so a broken cursor cannot loop forever. Default 50. */
  maxPages?: number;
}

export interface ConnectorWebhookPolicy {
  algorithm: "hmac-sha256" | "hmac-sha1";
  /** Header carrying the signature. */
  signatureHeader: string;
  /** Header carrying the signed timestamp, when the scheme uses one. */
  timestampHeader?: string;
  /** Reject signatures older than this. Default 300. */
  toleranceSeconds?: number;
  /** Credential key holding the signing secret. */
  secretKey: string;
}

/**
 * Declares a connector method to auto-instrument. `method` must match a public
 * method on the connector class; `description` is self-documentation shown in
 * the admin Analytics view.
 */
export interface ConnectorTelemetryDefinition {
  method: string;
  description?: string;
  /**
   * True when the method changes state upstream. Read by the MCP context, which
   * refuses a mutating call from a read-only tool — closing the one hole
   * `docs/apps/mcp.md` documented as reviewer-enforced.
   */
  mutates?: boolean;
}

/** A link an admin follows while provisioning. Always https — see the schema. */
export interface ConnectorDocLink {
  label: string;
  url: string;
}

/**
 * Reference material — a scope table, an API reference — shown below the setup
 * checklist rather than inside a step.
 */
export interface ConnectorReferenceLink extends ConnectorDocLink {
  /**
   * When someone would open it, behind a "?". Required: a link inside a step
   * is explained by the sentence around it, and this one has nothing around
   * it.
   */
  why: string;
}

export interface ConnectorSetupStep {
  /** The instruction, and only the instruction. One imperative sentence. */
  text: string;
  /**
   * Why the step is that way — rendered behind a "?" the reader opens on hover
   * or focus. Rationale only: a tooltip is not somewhere an instruction can
   * live, so anything the reader must *do* belongs in `text`.
   */
  why?: string;
  /**
   * Literal values the step tells the admin to choose — "Internal", "Web
   * application" — emboldened where they appear in `text`. Every entry must
   * occur in the sentence; the build rejects one that does not.
   */
  values?: string[];
  /** Where the step is carried out, when that is somewhere else. */
  link?: ConnectorDocLink;
  /**
   * Render this deployment's redirect URI, with a copy button, beneath this
   * step. Required on exactly one step of a three-legged connector — it is the
   * one value the manifest cannot carry, since it comes from the running
   * deployment's origin.
   */
  showRedirectUri?: boolean;
}

/**
 * Provisioning instructions for the Connector Registry.
 *
 * Structured rather than prose because the two things an admin most needs are
 * things prose cannot carry: a clickable link to the provider's console, and a
 * slot for the redirect URI, which only the running deployment knows.
 */
/**
 * Provider-specific warnings attached to the platform's own steps, so each
 * appears at the control it is about rather than all at once on arrival.
 */
export interface ConnectorSetupNotes {
  credentials?: string;
  authorize?: string;
  verify?: string;
}

export interface ConnectorSetupGuide {
  /** Label for the provider-side step. Defaults to "Get your credentials". */
  title?: string;
  /**
   * The provider-side work only — what an admin does in someone else's console.
   * Saving credentials, authorizing and verifying are the registry's own steps,
   * because it can tell whether those are done.
   */
  steps: ConnectorSetupStep[];
  notes?: ConnectorSetupNotes;
  /** Reference material — scope tables, API docs. Not steps to carry out. */
  docs?: ConnectorReferenceLink[];
}

export interface ConnectorAuthor {
  name: string;
  email: string;
}

export interface CredentialField {
  key: string;
  label: string;
  type: "text" | "password";
}

export interface BaseConnector {
  readonly name: string;
  readonly configured: boolean;
  /**
   * Receive decrypted credentials. May be async: an OAuth strategy needs I/O
   * to mint or refresh a token before the connector is usable. The platform
   * always awaits this, so a synchronous implementation remains valid.
   */
  initialize(credentials: Record<string, string>): void | Promise<void>;
}

/** One verified inbound webhook delivery, handed to `handleWebhook()`. */
export interface ConnectorWebhookEvent {
  /** Parsed JSON body, or the raw string when the payload was not JSON. */
  body: unknown;
  /** The exact bytes that were signed. Use this if you need to re-verify. */
  rawBody: string;
  headers: Record<string, string>;
}

/**
 * A connector that accepts inbound webhooks. Optional — implement it only if
 * the connector declares a `webhook` policy in its manifest.
 */
export interface WebhookCapableConnector extends BaseConnector {
  handleWebhook(event: ConnectorWebhookEvent): Promise<void>;
}

/** Result of a successful `testConnection()`. Failure throws a ConnectorError. */
export interface ConnectorTestResult {
  ok: true;
  /** Short, non-sensitive confirmation, e.g. "Authenticated as Acme Ltd". */
  detail?: string;
}
