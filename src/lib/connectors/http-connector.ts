/* This Source Code Form is subject to the terms of the Mozilla Public
 * License, v. 2.0. If a copy of the MPL was not distributed with this
 * file, You can obtain one at https://mozilla.org/MPL/2.0/. */

import { connectorRegistry } from "@/generated/connector-registry";
import { ConnectorError, RETRYABLE_CATEGORIES } from "./errors";
import type { ConnectorErrorCategory } from "./errors";
import {
  classifyStatus,
  extractRequestId,
  isBodyless,
  isRateLimitExhausted,
  isSuccess,
  nextPageLink,
  parseRetryAfter,
} from "./status-map";
import { TOKEN_KEYS, requestToken, requestedScopes } from "./oauth";
import { connectorConfigState } from "./status";
import type {
  BaseConnector,
  ConnectorAuthPolicy,
  ConnectorHttpPolicy,
  ConnectorPaginationPolicy,
  ConnectorTestResult,
} from "./types";

/**
 * The base every connector extends.
 *
 * A connector author writes methods that call `this.request()` and nothing
 * else. Authentication, timeouts, retries, backoff, status classification and
 * user-safe error messages all happen below this line, driven by the policy
 * declared in `connector.json`.
 *
 * Connectors remain stateless (invariant 11): this class holds credentials and
 * resolved policy for the lifetime of one instance, which the platform creates
 * fresh per request. Nothing is cached across requests, and nothing is stored
 * at module scope.
 */

const DEFAULTS = {
  timeoutMs: 10_000,
  deadlineMs: 15_000,
  maxAttempts: 3,
  maxResponseBytes: 8 * 1024 * 1024,
  backoffBaseMs: 250,
  backoffCapMs: 8_000,
  maxPages: 50,
  pageSize: 100,
} as const;

/**
 * Treat a token expiring within this window as already expired. A token that
 * dies mid-flight is indistinguishable from a rejected one and costs a wasted
 * round trip to discover. Exported so the user-scoped grant check before a
 * request (./user-grant.ts) draws the line in the same place.
 */
export const TOKEN_SKEW_MS = 60_000;

/**
 * Renews a three-legged grant under its lock and returns the stored tokens
 * afterwards — the shape `refreshConnectorTokens` and `refreshUserTokens`
 * share.
 */
export type GrantRefresher = () => Promise<Record<string, string>>;

/** Verbs that are safe to replay. Anything else needs an explicit opt-in. */
const IDEMPOTENT_VERBS = new Set(["GET", "HEAD", "OPTIONS", "PUT", "DELETE"]);

/**
 * What a connector expects a response to look like.
 *
 * Structural rather than a Zod import, so any Zod schema satisfies it and the
 * validator never enters a connector's runtime graph — only the shape of
 * `safeParse` matters. `z.object({...})` works out of the box.
 */
export interface ResponseSchema<T> {
  safeParse(data: unknown): SchemaResult<T>;
}

type SchemaResult<T> =
  | { success: true; data: T }
  | { success: false; error: { issues?: { path?: PropertyKey[] }[] } };

export interface RequestOptions<T = unknown> {
  /**
   * Validate the parsed body before returning it. A response that drifts
   * surfaces as `unexpected_response` naming the fields that failed, instead of
   * an undefined-property crash three layers up inside a widget.
   */
  schema?: ResponseSchema<T>;
  /** "json" (default) parses the body; "text" returns a string; "raw" the Response. */
  responseType?: "json" | "text" | "raw";
  /**
   * Declare a non-idempotent call safe to replay. Without this, a POST or PATCH
   * is never auto-retried — a silently duplicated write is worse than a visible
   * failure.
   */
  idempotent?: boolean;
  /** Override the per-attempt timeout. */
  timeoutMs?: number;
  /** Override the ceiling for this call including retries. */
  deadlineMs?: number;
  /** Override the total attempt budget. */
  maxAttempts?: number;
  /** Query parameters appended to the path. Undefined values are dropped. */
  query?: Record<string, string | number | boolean | undefined | null>;
}

export abstract class HttpConnector implements BaseConnector {
  abstract readonly name: string;

  /**
   * A cheap, synchronous "do we have what we need". Derived from
   * `auth.credentialKeys` when declared, so most connectors never write it.
   * `testConnection()` is the live proof — keeping the two separate is what
   * makes invariant 12 checkable instead of aspirational.
   *
   * The rule itself lives in `./status.ts`, because the Connector Registry has
   * to answer the same question about credentials it has read but not
   * instantiated. Two copies of it drifted once already — see that file.
   */
  get configured(): boolean {
    return (
      connectorConfigState(
        this.auth,
        this.credentials,
        this.manifest?.credentialFields,
      ) === "ready"
    );
  }

  /**
   * Prove the credentials actually work with one cheap upstream call. Required:
   * it powers the Connector Registry's Test Connection button, which is how a
   * non-technical admin finds out they pasted the wrong key — instead of
   * discovering it later through a broken widget.
   *
   * Throw a ConnectorError on failure; `request()` already produces one.
   */
  abstract testConnection(): Promise<ConnectorTestResult>;

  protected credentials: Record<string, string> = {};

  /**
   * Whose grant a refresh renews. Null is the tenant's, in connector_configs.
   *
   * A user-scoped connector's tenant row holds the client id and secret and
   * never a grant — each person's lives in user_connector_oauth — so a refresh
   * of the tenant row found no refresh token, and a token that expired
   * mid-request failed as `auth_failed` while `configured` still said true.
   * The platform binds the caller's own grant instead; see `bindUserGrant`.
   */
  #userGrant: GrantRefresher | null = null;

  /**
   * Point this instance's token refresh at one person's grant.
   *
   * Platform-only: `initializeWithUserGrant` (./user-grant.ts) calls it before
   * `initialize()`. It binds once, so nothing that holds the instance later can
   * re-point it at somebody else's grant.
   */
  static bindUserGrant(connector: BaseConnector, refresh: GrantRefresher): void {
    // A connector that does not extend this class never refreshes through it,
    // so there is nothing to point anywhere.
    if (!(connector instanceof HttpConnector)) return;
    if (connector.#userGrant) {
      throw new Error(`connector "${connector.name}" already has a grant bound.`);
    }
    connector.#userGrant = refresh;
  }

  /**
   * Subclasses that need extra setup override this and call
   * `super.initialize(credentials)` first.
   */
  initialize(credentials: Record<string, string>): void | Promise<void> {
    this.credentials = { ...credentials };

    // Tokens are minted lazily on first use, never here. `initialize()` runs
    // for every connector an app declares on every context build — minting
    // eagerly would multiply token-endpoint calls for connectors the request
    // never touches, and a transient blip at the token endpoint would exclude
    // the connector entirely (invariant 11), turning "slow auth server" into
    // "app unavailable".
  }

  // ── Declared policy ───────────────────────────────────────────────────────

  /**
   * Policy comes from this connector's `connector.json`, resolved by name.
   * Template connectors (underscore-prefixed) are absent from the registry and
   * fall through to defaults, which is what makes the template runnable.
   */
  private get manifest() {
    return connectorRegistry.find((c) => c.name === this.name);
  }

  protected get http(): ConnectorHttpPolicy {
    return this.manifest?.http ?? {};
  }

  protected get auth(): ConnectorAuthPolicy {
    return this.manifest?.auth ?? { strategy: "none" };
  }

  /** Display name for user-facing error copy. Falls back to the slug. */
  protected get subject(): string {
    return this.manifest?.displayName ?? this.name;
  }

  /** A `baseUrl` credential wins, so an admin can point at a sandbox. */
  protected get baseUrl(): string {
    return (this.credentials.baseUrl || this.http.baseUrl || "").replace(
      /\/+$/,
      "",
    );
  }

  // ── The only outbound path ────────────────────────────────────────────────

  protected async request<T = unknown>(
    path: string,
    init: RequestInit = {},
    opts: RequestOptions<T> = {},
  ): Promise<T | null> {
    return (await this.send<T>(path, init, opts)).body;
  }

  /**
   * `request()`, keeping the headers of the response that answered. Only
   * `paginate()` needs them: a `link-header` API says where the next page is
   * in a header rather than in the body.
   */
  private async send<T>(
    path: string,
    init: RequestInit,
    opts: RequestOptions<T>,
  ): Promise<{ body: T | null; headers: Headers }> {
    if (!this.configured) {
      throw new ConnectorError({
        category: "unconfigured",
        connectorName: this.name,
        subject: this.subject,
      });
    }

    const verb = (init.method ?? "GET").toUpperCase();
    const idempotent = opts.idempotent ?? IDEMPOTENT_VERBS.has(verb);
    const maxAttempts =
      opts.maxAttempts ?? this.http.maxAttempts ?? DEFAULTS.maxAttempts;
    const perAttemptMs =
      opts.timeoutMs ?? this.http.timeoutMs ?? DEFAULTS.timeoutMs;
    const deadlineAt =
      Date.now() +
      (opts.deadlineMs ?? this.http.deadlineMs ?? DEFAULTS.deadlineMs);
    const retryOn: ReadonlySet<ConnectorErrorCategory> = this.http.retryOn
      ? new Set(this.http.retryOn)
      : RETRYABLE_CATEGORIES;

    const url = this.resolveUrl(path, opts.query);
    let lastError: ConnectorError | null = null;
    // Counts transient-failure attempts only. An auth replay deliberately does
    // not spend this budget — a stale token is not a flaky upstream, and a
    // testConnection() pinned to maxAttempts: 1 must still be able to replay.
    let attempt = 0;
    let authReplayed = false;

    while (true) {
      const remaining = deadlineAt - Date.now();
      if (remaining <= 0) {
        throw this.withAttempts(
          lastError ??
            new ConnectorError({
              category: "timeout",
              connectorName: this.name,
              subject: this.subject,
            }),
          Math.max(1, attempt),
        );
      }

      attempt++;
      try {
        return await this.attempt<T>(url, init, opts, {
          verb,
          attempt,
          timeoutMs: Math.min(perAttemptMs, remaining),
        });
      } catch (err) {
        // Anything that isn't a ConnectorError is a programming fault (a bad
        // URL, a missing policy). Those must surface unchanged, not be retried.
        if (!(err instanceof ConnectorError)) throw err;
        lastError = err;

        // A 401 against a token-based strategy usually means our token expired
        // mid-flight. Drop it, mint a fresh one, and replay exactly once —
        // `authReplayed` is the hard bound, so this can never loop.
        if (
          err.category === "auth_failed" &&
          !authReplayed &&
          this.mintsTokens() &&
          this.heldToken()
        ) {
          authReplayed = true;
          this.invalidateToken();
          attempt--;
          continue;
        }

        const canRetry =
          attempt < maxAttempts && retryOn.has(err.category) && idempotent;
        if (!canRetry) throw this.withAttempts(err, attempt);

        const delay = err.retryAfterMs ?? backoff(attempt);
        // Sleeping past the deadline is worse than failing now: a serverless
        // function that burns its wall clock waiting helps nobody, and the
        // caller can act on `retryAfterMs` itself.
        if (Date.now() + delay > deadlineAt)
          throw this.withAttempts(err, attempt);
        await sleep(delay);
      }
    }

    throw this.withAttempts(
      lastError ??
        new ConnectorError({
          category: "upstream_error",
          connectorName: this.name,
          subject: this.subject,
        }),
      maxAttempts,
    );
  }

  // ── One attempt ───────────────────────────────────────────────────────────

  private async attempt<T>(
    url: string,
    init: RequestInit,
    opts: RequestOptions<T>,
    ctx: { verb: string; attempt: number; timeoutMs: number },
  ): Promise<{ body: T | null; headers: Headers }> {
    const signals: AbortSignal[] = [AbortSignal.timeout(ctx.timeoutMs)];
    if (init.signal) signals.push(init.signal);

    // Built OUTSIDE the try below. An auth strategy that mints a token does
    // real I/O here and throws its own classified ConnectorError — catching it
    // alongside fetch would relabel "your client secret is wrong" as a network
    // blip, and network blips are retryable.
    const headers = await this.buildHeaders(init.headers);

    let res: Response;
    try {
      res = await fetch(url, {
        ...init,
        method: ctx.verb,
        headers,
        signal: signals.length > 1 ? AbortSignal.any(signals) : signals[0],
      });
    } catch (err) {
      // A ConnectorError reaching here is already classified — never reclassify.
      if (err instanceof ConnectorError) throw err;
      // `fetch` throws for aborts and for transport failures. Both are
      // retryable, but they mean different things to an admin.
      const aborted =
        err instanceof Error &&
        (err.name === "TimeoutError" || err.name === "AbortError");
      throw new ConnectorError({
        category: aborted ? "timeout" : "network_error",
        connectorName: this.name,
        subject: this.subject,
        attempts: ctx.attempt,
        cause: err,
      });
    }

    const requestId = extractRequestId(res.headers);

    if (!isSuccess(res.status)) {
      const retryAfterMs = parseRetryAfter(res.headers.get("retry-after"));
      const { category } = classifyStatus(res.status, {
        hasRetryAfter: retryAfterMs != null,
        rateLimitExhausted: isRateLimitExhausted(res.headers),
        rateLimitOn403: this.http.rateLimitOn403,
      });
      // The body is deliberately never read. Per invariant 16 those bodies
      // routinely carry account and tenant detail, and we have no way to know
      // which parts are safe.
      throw new ConnectorError({
        category,
        connectorName: this.name,
        subject: this.subject,
        status: res.status,
        retryAfterMs,
        attempts: ctx.attempt,
        upstreamRequestId: requestId,
      });
    }

    // The body in the form the caller asked for, with the headers it came with.
    const answer = (body: T | null) => ({ body, headers: res.headers });

    if (opts.responseType === "raw") return answer(res as unknown as T);

    // 204 / 205 / 304 carry no body. Calling .json() here is the single most
    // common defect in hand-written API clients.
    if (isBodyless(res.status)) return answer(null);

    const maxBytes = this.http.maxResponseBytes ?? DEFAULTS.maxResponseBytes;
    const declared = Number(res.headers.get("content-length") ?? "");
    if (!Number.isNaN(declared) && declared > maxBytes) {
      throw new ConnectorError({
        category: "payload_too_large",
        connectorName: this.name,
        subject: this.subject,
        status: res.status,
        attempts: ctx.attempt,
        upstreamRequestId: requestId,
      });
    }

    const text = await res.text();
    if (text.length > maxBytes) {
      throw new ConnectorError({
        category: "payload_too_large",
        connectorName: this.name,
        subject: this.subject,
        status: res.status,
        attempts: ctx.attempt,
        upstreamRequestId: requestId,
      });
    }

    if (opts.responseType === "text") return answer(text as unknown as T);
    if (text.trim() === "") return answer(null);

    let parsed: unknown;
    try {
      parsed = JSON.parse(text);
    } catch (err) {
      // A 2xx that isn't the shape we were promised. Usually the upstream
      // returned an HTML error or login page with a 200.
      throw new ConnectorError({
        category: "unexpected_response",
        connectorName: this.name,
        subject: this.subject,
        status: res.status,
        attempts: ctx.attempt,
        upstreamRequestId: requestId,
        cause: err,
      });
    }

    if (!opts.schema) return answer(parsed as T);

    const validated = opts.schema.safeParse(parsed);
    if (validated.success) return answer(validated.data);

    // Only the failing field *paths* are reported — never the values. A drifted
    // response is still a real response, and its contents are exactly the
    // tenant data we are not allowed to put in an error (invariant 16).
    const paths = (validated.error.issues ?? [])
      .slice(0, 5)
      .map((issue) => (issue.path ?? []).map(String).join(".") || "(root)")
      .join(", ");
    throw new ConnectorError({
      category: "unexpected_response",
      connectorName: this.name,
      subject: this.subject,
      status: res.status,
      attempts: ctx.attempt,
      upstreamRequestId: requestId,
      adminHint:
        `The response did not match what this connector expects` +
        (paths ? ` (fields: ${paths})` : "") +
        `. This usually means the upstream API changed and the connector needs updating.`,
    });
  }

  // ── Pagination ────────────────────────────────────────────────────────────

  /**
   * Walk a paginated collection as an async iterable, following whichever
   * style the manifest declares:
   *
   *   for await (const item of this.paginate<Thing>("/things")) { ... }
   *
   * Bounded by `maxPages` so a cursor that never terminates cannot spin
   * forever — the failure mode that turns one bad response into an outage.
   */
  protected async *paginate<T>(
    path: string,
    opts: RequestOptions<unknown> & {
      pagination?: ConnectorPaginationPolicy;
      /** Validates each item, not the page envelope. */
      itemSchema?: ResponseSchema<T>;
    } = {},
  ): AsyncGenerator<T, void, undefined> {
    const policy = opts.pagination ?? this.http.pagination;
    if (!policy) {
      throw new Error(
        `connector "${this.name}" called paginate() without a pagination policy — declare http.pagination in connector.json.`,
      );
    }

    const maxPages = policy.maxPages ?? DEFAULTS.maxPages;
    const pageSize = policy.pageSize ?? DEFAULTS.pageSize;
    const query: Record<string, string | number | boolean | undefined | null> =
      {
        ...(opts.query ?? {}),
      };
    if (policy.limitParam) query[policy.limitParam] = pageSize;

    let cursor: string | null = null;
    let nextUrl: string | null = null;
    // link-header only: the origin the walk started on, and every URL it has
    // requested or been sent to, so a Link pointing back cannot loop.
    let origin: string | null = null;
    const visited = new Set<string>();

    for (let page = 0; page < maxPages; page++) {
      if (policy.style === "cursor" && cursor && policy.cursorParam) {
        query[policy.cursorParam] = cursor;
      } else if (policy.style === "offset" && policy.offsetParam) {
        query[policy.offsetParam] = page * pageSize;
      } else if (policy.style === "page" && policy.pageParam) {
        query[policy.pageParam] = page + 1;
      }

      // A next-page URL from a Link header is complete, query and all.
      const target = nextUrl ?? path;
      const pageQuery = nextUrl ? undefined : query;
      const { body, headers } = await this.send<unknown>(
        target,
        { method: "GET" },
        { ...opts, query: pageQuery, responseType: "json" },
      );
      if (body == null) return;

      const items = getPath(body, policy.itemsPath);
      if (!Array.isArray(items)) {
        throw new ConnectorError({
          category: "unexpected_response",
          connectorName: this.name,
          subject: this.subject,
        });
      }
      for (const item of items) {
        if (!opts.itemSchema) {
          yield item as T;
          continue;
        }
        const checked = opts.itemSchema.safeParse(item);
        if (!checked.success) {
          throw new ConnectorError({
            category: "unexpected_response",
            connectorName: this.name,
            subject: this.subject,
            adminHint:
              "A paged item did not match what this connector expects. The upstream API likely changed.",
          });
        }
        yield checked.data;
      }

      // Decide whether another page exists.
      if (policy.style === "cursor") {
        const next = getPath(body, policy.cursorPath);
        cursor = typeof next === "string" && next.length > 0 ? next : null;
        if (!cursor) return;
      } else if (policy.style === "link-header") {
        // The server says whether another page exists, in `Link: <…>;
        // rel="next"`, and its absence is the end. Page size proves nothing
        // either way here: a short page that still links onward is followed.
        const requested = this.resolveUrl(target, pageQuery);
        origin ??= new URL(requested).origin;
        visited.add(requested);
        const next = nextPageLink(headers.get("link"), requested);
        if (!next || visited.has(next)) return;
        // The next request carries this connector's credentials, so the walk
        // stays on the origin it started on. A Link elsewhere is refused, not
        // followed.
        if (new URL(next).origin !== origin) {
          throw new ConnectorError({
            category: "unexpected_response",
            connectorName: this.name,
            subject: this.subject,
            adminHint:
              "The upstream's pagination Link header pointed at a different host. This connector only follows pages on the host the listing started on.",
          });
        }
        visited.add(next);
        nextUrl = next;
      } else if (items.length < pageSize) {
        return;
      }
    }
  }

  // ── Helpers ───────────────────────────────────────────────────────────────

  /** Are these credential keys all present and non-empty? */
  protected hasCredentials(...keys: string[]): boolean {
    return keys.every((k) => (this.credentials[k] ?? "").length > 0);
  }

  private resolveUrl(path: string, query?: RequestOptions["query"]): string {
    const absolute = /^https?:\/\//i.test(path);
    if (!absolute && !this.baseUrl) {
      throw new Error(
        `connector "${this.name}" has no base URL — set http.baseUrl in connector.json or add a baseUrl credential.`,
      );
    }
    const url = new URL(
      absolute ? path : `${this.baseUrl}/${path.replace(/^\/+/, "")}`,
    );

    for (const [key, value] of Object.entries(query ?? {})) {
      if (value == null) continue;
      url.searchParams.set(key, String(value));
    }

    // apiKey-in-query is applied last so it cannot be clobbered by a caller.
    const { strategy, in: where, name } = this.auth;
    if (strategy === "apiKey" && where === "query" && name) {
      url.searchParams.set(
        name,
        this.credentials[this.apiKeyCredential()] ?? "",
      );
    }
    return url.toString();
  }

  private async buildHeaders(
    callerHeaders: HeadersInit | undefined,
  ): Promise<Headers> {
    const headers = new Headers(this.http.defaultHeaders ?? {});
    headers.set("accept", "application/json");
    for (const [k, v] of Object.entries(await this.authHeaders()))
      headers.set(k, v);
    // Caller headers win — a method knows more about its own call than the
    // manifest does.
    if (callerHeaders) {
      for (const [k, v] of new Headers(callerHeaders).entries())
        headers.set(k, v);
    }
    return headers;
  }

  /**
   * Headers for the declared auth strategy. OAuth strategies are rejected in
   * `initialize()`, so they never reach here.
   */
  protected async authHeaders(): Promise<Record<string, string>> {
    const { strategy, in: where = "bearer", name, prefix } = this.auth;

    if (
      strategy === "oauth2_client_credentials" ||
      strategy === "oauth2_authorization_code"
    ) {
      return { authorization: `Bearer ${await this.bearerToken()}` };
    }

    if (strategy === "apiKey") {
      const value = this.credentials[this.apiKeyCredential()] ?? "";
      if (where === "query") return {};
      if (where === "header" && name)
        return { [name]: `${prefix ?? ""}${value}` };
      return { authorization: `${prefix ?? "Bearer "}${value}` };
    }

    if (strategy === "basic") {
      const [userKey, passKey] = this.auth.credentialKeys ?? [
        "username",
        "password",
      ];
      const raw = `${this.credentials[userKey] ?? ""}:${this.credentials[passKey] ?? ""}`;
      return {
        authorization: `Basic ${Buffer.from(raw, "utf-8").toString("base64")}`,
      };
    }

    return {};
  }

  /** Credential key holding the API key. First declared key, else "apiKey". */
  private apiKeyCredential(): string {
    return this.auth.credentialKeys?.[0] ?? "apiKey";
  }

  // ── OAuth 2.0 client credentials ──────────────────────────────────────────

  /**
   * The minted token. Lives on the instance, which the platform creates fresh
   * per request — so this is request-lifetime only and does not violate the
   * stateless-connector invariant. It is never written to module scope.
   */
  private accessToken: { value: string; expiresAt: number } | null = null;

  private mintsTokens(): boolean {
    return (
      this.auth.strategy === "oauth2_client_credentials" ||
      this.auth.strategy === "oauth2_authorization_code"
    );
  }

  /** Did we actually present a token that the upstream then rejected? */
  private heldToken(): boolean {
    if (this.auth.strategy === "oauth2_authorization_code") {
      return (this.credentials[TOKEN_KEYS.access] ?? "").length > 0;
    }
    return this.accessToken !== null;
  }

  /** Force the next call to obtain a fresh token. */
  private invalidateToken(): void {
    this.accessToken = null;
    if (this.auth.strategy === "oauth2_authorization_code") {
      // Zeroing the expiry is what makes the next bearerToken() refresh.
      this.credentials = { ...this.credentials, [TOKEN_KEYS.expiresAt]: "0" };
    }
  }

  /** A valid bearer token, obtaining one if we don't already hold a live one. */
  private async bearerToken(): Promise<string> {
    if (this.auth.strategy === "oauth2_authorization_code")
      return this.grantedToken();

    if (
      this.accessToken &&
      this.accessToken.expiresAt - TOKEN_SKEW_MS > Date.now()
    ) {
      return this.accessToken.value;
    }
    this.accessToken = await this.mintToken();
    return this.accessToken.value;
  }

  /** Exchange client credentials for a token. Lives only for this instance. */
  private async mintToken(): Promise<{ value: string; expiresAt: number }> {
    const [idKey, secretKey] = this.auth.credentialKeys ?? [
      "clientId",
      "clientSecret",
    ];
    const params: Record<string, string> = { grant_type: "client_credentials" };
    const scopes = requestedScopes(this.auth);
    if (scopes.length) params.scope = scopes.join(" ");

    const token = await requestToken({
      policy: this.auth,
      clientId: this.credentials[idKey] ?? "",
      clientSecret: this.credentials[secretKey] ?? "",
      params,
      connectorName: this.name,
      subject: this.subject,
      timeoutMs: this.http.timeoutMs ?? DEFAULTS.timeoutMs,
    });
    return { value: token.accessToken, expiresAt: token.expiresAt };
  }

  /**
   * The tenant's granted access token, refreshed if it has expired.
   *
   * The refresh itself happens under a Postgres advisory lock so concurrent
   * serverless invocations produce one refresh rather than several — with a
   * provider that rotates refresh tokens on use, losing that race invalidates
   * the credential permanently.
   */
  private async grantedToken(): Promise<string> {
    const expiresAt = Number(this.credentials[TOKEN_KEYS.expiresAt] ?? 0);
    const current = this.credentials[TOKEN_KEYS.access];
    if (current && expiresAt - TOKEN_SKEW_MS > Date.now()) return current;

    let refreshed: Record<string, string>;
    try {
      refreshed = await this.refreshStoredTokens();
    } catch (err) {
      // Drop the dead token so the 401 replay does not attempt a second
      // refresh — a revoked grant should cost one token call, not two.
      this.credentials = { ...this.credentials, [TOKEN_KEYS.access]: "" };
      throw err;
    }

    this.credentials = { ...this.credentials, ...refreshed };
    const next = this.credentials[TOKEN_KEYS.access];
    if (!next) {
      throw new ConnectorError({
        category: "auth_failed",
        connectorName: this.name,
        subject: this.subject,
      });
    }
    return next;
  }

  /**
   * Refresh and persist the grant: the caller's own when one is bound (a
   * user-scoped connector), otherwise the tenant's. Imported lazily so the
   * database layer stays out of the module graph for every connector that
   * never uses the authorization-code flow. Overridden in the verification
   * harness.
   */
  protected async refreshStoredTokens(): Promise<Record<string, string>> {
    if (this.#userGrant) return this.#userGrant();
    const { refreshConnectorTokens } = await import("./config");
    return refreshConnectorTokens({
      connectorName: this.name,
      subject: this.subject,
      policy: this.auth,
      skewMs: TOKEN_SKEW_MS,
    });
  }

  private withAttempts(err: ConnectorError, attempts: number): ConnectorError {
    if (err.attempts === attempts) return err;
    return new ConnectorError({
      category: err.category,
      connectorName: err.connectorName,
      subject: err.subject,
      status: err.status,
      retryAfterMs: err.retryAfterMs,
      attempts,
      upstreamRequestId: err.upstreamRequestId,
      userMessage: err.userMessage,
      adminHint: err.adminHint,
    });
  }
}

/** Exponential backoff with full jitter. Attempt is 1-based. */
function backoff(attempt: number): number {
  const ceiling = Math.min(
    DEFAULTS.backoffCapMs,
    DEFAULTS.backoffBaseMs * 2 ** (attempt - 1),
  );
  return Math.random() * ceiling;
}

function sleep(ms: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

function getPath(obj: unknown, path?: string): unknown {
  if (!path) return obj;
  return path
    .split(".")
    .reduce<unknown>(
      (acc, key) =>
        acc == null ? undefined : (acc as Record<string, unknown>)[key],
      obj,
    );
}
