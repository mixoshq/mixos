import type { ConnectorErrorCategory } from "./errors";

export interface ConnectorManifest {
  name: string;
  displayName: string;
  /** Technical description shown to admins in the Connector Registry. */
  description: string;
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
  /** oauth2_*: scopes requested at provisioning time. Minimum set only. */
  scopes?: string[];
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
  | "cursor"
  | "offset"
  | "page"
  | "link-header";

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
