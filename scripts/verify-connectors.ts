/* This Source Code Form is subject to the terms of the Mozilla Public
 * License, v. 2.0. If a copy of the MPL was not distributed with this
 * file, You can obtain one at https://mozilla.org/MPL/2.0/. */

/**
 * Connector verification harness.
 *
 * Runs the connector abstraction against a local stub upstream that can be
 * driven into any status, header, or body on demand — including a stub OAuth
 * token endpoint. No third-party credentials, no network, deterministic.
 *
 * This is the fixture the build plan calls for: it is how a connector's
 * transport and auth policy get proven without a live vendor. Run it after any
 * change to src/lib/connectors/.
 *
 *   npm run verify:connectors
 */
import http from "node:http";
import { createHmac, randomBytes } from "node:crypto";
import { z } from "zod";
import type { AddressInfo } from "node:net";

// Self-contained: the flow-state cookie is AES-256-GCM encrypted and the
// redirect URI is built from the configured origin, so give both a value when
// the environment has none. Never overrides a real one.
process.env.CONNECTOR_ENCRYPTION_KEY ??= randomBytes(32).toString("hex");
process.env.NEXTAUTH_URL ??= "https://mos.test";
import { HttpConnector } from "../src/lib/connectors/http-connector";
import { ConnectorError } from "../src/lib/connectors/errors";
import { classifyStatus } from "../src/lib/connectors/status-map";
import {
  connectorErrorEnvelope,
  connectorErrorResponse,
  isAdminActionable,
} from "../src/lib/connectors/response";
import type { ConnectorErrorCategory } from "../src/lib/connectors/errors";
import { verifyWebhookSignature } from "../src/lib/connectors/webhook";
import type { ConnectorWebhookPolicy } from "../src/lib/connectors/types";
import {
  TOKEN_KEYS,
  buildAuthorizeUrl,
  codeChallengeFor,
  exchangeAuthorizationCode,
  newFlowState,
  openFlowState,
  redirectUriFor,
  refreshWithToken,
  safeReturnPath,
  sealFlowState,
  stateMatches,
  tokensToCredentials,
} from "../src/lib/connectors/oauth";
import type {
  ConnectorAuthPolicy,
  ConnectorHttpPolicy,
  ConnectorTestResult,
} from "../src/lib/connectors/types";

// ── Stub upstream ───────────────────────────────────────────────────────────

let hits: Record<string, number> = {};
let seen: Record<string, { auth?: string; body?: string; url?: string }> = {};
let tokenMode: "ok" | "reject400" | "throttle" | "shortlived" | "nojson" | "notoken" = "ok";
let apiMode: "ok" | "expire-once" | "always401" = "ok";

const bump = (k: string) => (hits[k] = (hits[k] ?? 0) + 1);
function reset() { hits = {}; seen = {}; tokenMode = "ok"; apiMode = "ok"; }

const server = http.createServer((req, res) => {
  const url = new URL(req.url!, "http://x");
  const key = `${req.method} ${url.pathname}`;
  bump(key);
  const n = hits[key];
  let body = "";
  req.on("data", (c) => (body += c));
  req.on("end", () => {
    seen[key] = { auth: req.headers.authorization, body, url: req.url! };
    const json = (code: number, payload: unknown, headers: Record<string, string> = {}) => {
      res.writeHead(code, { "content-type": "application/json", ...headers });
      res.end(JSON.stringify(payload));
    };

    switch (url.pathname) {
      // transport
      case "/ok": return json(200, { hello: "world" });
      case "/empty": res.writeHead(204); return res.end();
      case "/missing": res.writeHead(404); return res.end("secret-tenant-detail-must-never-surface");
      case "/throttled":
        if (n <= 2) { res.writeHead(429, { "retry-after": "1", "x-request-id": "req-abc" }); return res.end(); }
        return json(200, { recovered: true, attempt: n });
      case "/flaky5xx":
        if (n <= 1) { res.writeHead(500); return res.end(); }
        return json(200, { attempt: n });
      case "/write": res.writeHead(500); return res.end();
      case "/throttle403": res.writeHead(403, { "x-ratelimit-remaining": "0" }); return res.end();
      case "/slow": return void setTimeout(() => { res.writeHead(200); res.end("{}"); }, 3000);
      case "/html200": res.writeHead(200, { "content-type": "text/html" }); return res.end("<html>login</html>");
      case "/typed": return json(200, { id: 12345, label: "ok", secret: "tenant-secret-value" });
      case "/typed-ok": return json(200, { id: "abc", label: "ok" });
      case "/page": {
        const cursor = url.searchParams.get("cursor");
        const page = cursor ? Number(cursor) : 0;
        return json(200, {
          data: [{ i: page * 2 }, { i: page * 2 + 1 }],
          meta: { next: page < 2 ? String(page + 1) : null },
        });
      }
      // auth
      case "/token": {
        if (tokenMode === "reject400") return json(400, { error: "invalid_client", hint: "super-secret-detail" });
        if (tokenMode === "throttle") { res.writeHead(429, { "retry-after": "1" }); return res.end(); }
        if (tokenMode === "nojson") { res.writeHead(200, { "content-type": "text/html" }); return res.end("<html/>"); }
        if (tokenMode === "notoken") return json(200, {});

        const form = new URLSearchParams(body);
        const grant = form.get("grant_type");
        const ttl = tokenMode === "shortlived" ? 30 : 3600;

        // Three-legged: the initial code exchange and subsequent refreshes.
        if (grant === "authorization_code" || grant === "refresh_token") {
          bump(`grant:${grant}`);
          const seq = hits[`grant:${grant}`];
          return json(200, {
            access_token: `granted-${grant === "refresh_token" ? seq + 1 : 1}`,
            refresh_token: `refresh-${grant === "refresh_token" ? seq + 1 : 1}`,
            token_type: "Bearer",
            expires_in: ttl,
            scope: "read:things",
          });
        }

        return json(200, {
          access_token: `tok-${n}`, token_type: "Bearer", expires_in: ttl,
        });
      }
      case "/data": {
        const bearer = (req.headers.authorization ?? "").replace(/^Bearer /, "");
        if (apiMode === "always401") { res.writeHead(401); return res.end(); }
        if (apiMode === "expire-once" && (bearer === "tok-1" || bearer === "granted-1")) {
          res.writeHead(401); return res.end();
        }
        return json(200, { token: bearer });
      }
      default: return json(418, {});
    }
  });
});

// ── Probe connector ─────────────────────────────────────────────────────────

class Probe extends HttpConnector {
  readonly name = "verify-probe";
  authOverride: ConnectorAuthPolicy = { strategy: "none" };
  httpOverride: ConnectorHttpPolicy = {};
  protected get auth(): ConnectorAuthPolicy { return this.authOverride; }
  protected get http(): ConnectorHttpPolicy { return this.httpOverride; }
  async testConnection(): Promise<ConnectorTestResult> {
    await this.call("/ok");
    return { ok: true, detail: "reachable" };
  }
  call<T>(p: string, init?: RequestInit, opts?: object) {
    return (this as unknown as {
      request(a: string, b?: RequestInit, c?: object): Promise<T | null>;
    }).request(p, init, opts);
  }
  pages<T>(p: string, opts?: object) {
    return (this as unknown as {
      paginate(a: string, b?: object): AsyncGenerator<T, void, undefined>;
    }).paginate(p, opts);
  }
}

// ── Harness ─────────────────────────────────────────────────────────────────

const results: { suite: string; label: string; ok: boolean; detail: string }[] = [];
let suite = "";
const check = (label: string, ok: boolean, detail = "") =>
  results.push({ suite, label, ok, detail });

async function expectError(fn: () => Promise<unknown>): Promise<ConnectorError> {
  try { await fn(); } catch (e) { if (e instanceof ConnectorError) return e; throw e; }
  throw new Error("expected a ConnectorError, call succeeded");
}

async function main() {
  await new Promise<void>((r) => server.listen(0, r));
  const base = `http://127.0.0.1:${(server.address() as AddressInfo).port}`;

  const mk = async (auth: ConnectorAuthPolicy = { strategy: "none" }, http: ConnectorHttpPolicy = {}) => {
    const c = new Probe();
    c.authOverride = auth;
    c.httpOverride = { baseUrl: base, ...http };
    await c.initialize({
      baseUrl: base, clientId: "abc", clientSecret: "s3cr3t",
      apiKey: "key-123", user: "u", pass: "p",
    });
    return c;
  };

  // ══ Transport ════════════════════════════════════════════════════════════
  suite = "transport";
  reset();

  const bare = new Probe();
  const unconf = await expectError(() => bare.call("/ok"));
  check("unconfigured is refused before any network call", unconf.category === "unconfigured", unconf.userMessage);

  const c = await mk();
  check("200 parses json", (await c.call<{ hello: string }>("/ok"))?.hello === "world");
  check("204 returns null instead of crashing on json()", (await c.call("/empty")) === null);

  const nf = await expectError(() => c.call("/missing"));
  check("404 -> not_found", nf.category === "not_found");
  check("upstream error body never leaks into the error",
    !JSON.stringify(nf).includes("secret-tenant-detail") &&
    !nf.message.includes("secret-tenant-detail") &&
    !nf.userMessage.includes("secret-tenant-detail"));

  reset();
  const t0 = Date.now();
  const rec = await c.call<{ recovered: boolean }>("/throttled", undefined, { deadlineMs: 20000 });
  const waited = Date.now() - t0;
  check("429 retried through to success", rec?.recovered === true, `${hits["GET /throttled"]} calls`);
  check("Retry-After honoured", waited >= 2000, `${waited}ms for two 1s waits`);

  reset();
  check("500 retried then succeeds", (await c.call<{ attempt: number }>("/flaky5xx"))?.attempt === 2);

  reset();
  await expectError(() => c.call("/write", { method: "POST" }));
  check("POST + 500 is NOT auto-retried", hits["POST /write"] === 1, `${hits["POST /write"]} call(s)`);

  reset();
  await expectError(() => c.call("/write", { method: "POST" }, { idempotent: true }));
  check("POST retried when explicitly declared idempotent", hits["POST /write"] === 3, `${hits["POST /write"]} calls`);

  const rl403 = await expectError(() => c.call("/throttle403", undefined, { maxAttempts: 1 }));
  check("403 + rate-limit header -> rate_limited", rl403.category === "rate_limited");
  const bare403 = classifyStatus(403, {});
  check("403 without those headers stays forbidden", bare403.category === "forbidden" && !bare403.retryable);

  const to = await expectError(() => c.call("/slow", undefined, { timeoutMs: 300, maxAttempts: 1 }));
  check("slow upstream times out", to.category === "timeout");

  const html = await expectError(() => c.call("/html200"));
  check("html body behind a 200 -> unexpected_response", html.category === "unexpected_response");

  reset();
  const t1 = Date.now();
  const ff = await expectError(() => c.call("/throttled", undefined, { deadlineMs: 500 }));
  check("Retry-After beyond the deadline fails fast rather than sleeping",
    Date.now() - t1 < 900 && ff.retryAfterMs === 1000, `${Date.now() - t1}ms`);
  check("error carries the upstream request id", ff.upstreamRequestId === "req-abc");

  const paged = await mk({ strategy: "none" }, {
    pagination: { style: "cursor", itemsPath: "data", cursorPath: "meta.next", cursorParam: "cursor", pageSize: 2 },
  });
  const items: { i: number }[] = [];
  for await (const item of paged.pages<{ i: number }>("/page")) items.push(item);
  check("cursor pagination walks every page", items.length === 6 && items[5].i === 5, `${items.length} items`);

  const capped = await mk({ strategy: "none" }, {
    pagination: { style: "cursor", itemsPath: "data", cursorPath: "meta.next", cursorParam: "cursor", pageSize: 2, maxPages: 2 },
  });
  const cappedItems: unknown[] = [];
  for await (const item of capped.pages("/page")) cappedItems.push(item);
  check("maxPages caps a runaway cursor", cappedItems.length === 4,
    `${cappedItems.length} items across 2 pages`);

  check("testConnection returns ok", (await c.testConnection()).ok === true);

  // ══ Auth ═════════════════════════════════════════════════════════════════
  suite = "auth";
  const cc = (over: Partial<ConnectorAuthPolicy> = {}): ConnectorAuthPolicy => ({
    strategy: "oauth2_client_credentials", tokenUrl: `${base}/token`,
    credentialKeys: ["clientId", "clientSecret"], scopes: ["read:things"], ...over,
  });

  reset();
  let a = await mk(cc());
  check("token minted and sent as Bearer", (await a.call<{ token: string }>("/data"))?.token === "tok-1");
  check("client_secret_basic is the default", (seen["POST /token"].auth ?? "").startsWith("Basic "));
  check("scope forwarded", (seen["POST /token"].body ?? "").includes("scope=read%3Athings"));
  await a.call("/data"); await a.call("/data");
  check("token reused for the request lifetime", hits["POST /token"] === 1, `1 mint / 3 calls`);

  reset();
  a = await mk(cc({ tokenAuth: "post" }));
  await a.call("/data");
  check("tokenAuth:post puts credentials in the body",
    !seen["POST /token"].auth && (seen["POST /token"].body ?? "").includes("client_secret=s3cr3t"));

  reset(); apiMode = "expire-once";
  a = await mk(cc());
  check("401 replays once with a fresh token",
    (await a.call<{ token: string }>("/data", undefined, { maxAttempts: 1 }))?.token === "tok-2");
  check("replay works even at maxAttempts=1", hits["GET /data"] === 2);

  reset(); apiMode = "always401";
  a = await mk(cc());
  const persistent = await expectError(() => a.call("/data"));
  check("persistent 401 -> auth_failed", persistent.category === "auth_failed");
  check("persistent 401 replays at most once", hits["GET /data"] === 2 && hits["POST /token"] === 2);

  reset(); tokenMode = "reject400";
  a = await mk(cc());
  const badClient = await expectError(() => a.call("/data"));
  check("400 invalid_client -> auth_failed", badClient.category === "auth_failed" && badClient.status === 400);
  check("token-endpoint body never leaks", !JSON.stringify(badClient).includes("super-secret-detail"));
  check("client secret never appears in the error", !JSON.stringify(badClient).includes("s3cr3t"));
  check("a failed mint is not replayed", hits["POST /token"] === 1, `${hits["POST /token"]} mint(s)`);
  check("no API call attempted without a token", (hits["GET /data"] ?? 0) === 0);

  reset(); tokenMode = "throttle";
  a = await mk(cc());
  const tokenRl = await expectError(() => a.call("/data", undefined, { maxAttempts: 2, deadlineMs: 4000 }));
  check("throttled token endpoint -> rate_limited, not auth_failed", tokenRl.category === "rate_limited");

  reset(); tokenMode = "nojson";
  a = await mk(cc());
  check("non-json token response -> unexpected_response",
    (await expectError(() => a.call("/data"))).category === "unexpected_response");

  reset(); tokenMode = "notoken";
  a = await mk(cc());
  check("200 without access_token -> auth_failed",
    (await expectError(() => a.call("/data"))).category === "auth_failed");

  reset(); tokenMode = "shortlived";
  a = await mk(cc());
  await a.call("/data"); await a.call("/data");
  check("token near expiry is re-minted before use", hits["POST /token"] === 2);

  reset();
  a = await mk({ strategy: "apiKey", in: "query", name: "api_key", credentialKeys: ["apiKey"] });
  await a.call("/data");
  check("apiKey in query", (seen["GET /data"].url ?? "").includes("api_key=key-123"));

  reset();
  a = await mk({ strategy: "basic", credentialKeys: ["user", "pass"] });
  await a.call("/data");
  check("basic auth", seen["GET /data"].auth === `Basic ${Buffer.from("u:p").toString("base64")}`);

  reset();
  a = await mk({ strategy: "apiKey", credentialKeys: ["apiKey"] });
  await a.call("/data");
  check("apiKey defaults to bearer", seen["GET /data"].auth === "Bearer key-123");

  // ══ Tenant three-legged OAuth ════════════════════════════════════════════
  suite = "tenant-oauth";

  const authCode = (over: Partial<ConnectorAuthPolicy> = {}): ConnectorAuthPolicy => ({
    strategy: "oauth2_authorization_code",
    tokenUrl: `${base}/token`,
    authorizeUrl: `${base}/authorize`,
    credentialKeys: ["clientId", "clientSecret"],
    scopes: ["read:things"],
    ...over,
  });

  // ── PKCE + flow state ────────────────────────────────────────────────────
  const flow = newFlowState("acme", "/admin/connectors");
  check("verifier meets RFC 7636 length", flow.codeVerifier.length >= 43 && flow.codeVerifier.length <= 128,
    `${flow.codeVerifier.length} chars`);
  const reopened = openFlowState(sealFlowState(flow));
  check("flow state seals and reopens intact",
    reopened?.state === flow.state && reopened?.codeVerifier === flow.codeVerifier);
  check("tampered flow cookie is rejected", openFlowState("not-a-sealed-value") === null);
  check("expired flow cookie is rejected",
    openFlowState(sealFlowState({ ...flow, exp: Date.now() - 1 })) === null);
  check("state comparison rejects a mismatch", !stateMatches("wrong", flow.state));
  check("state comparison accepts the echo", stateMatches(flow.state, flow.state));

  // ── open-redirect guard ──────────────────────────────────────────────────
  check("protocol-relative return path refused", safeReturnPath("//evil.example") === "/admin/connectors");
  check("absolute return path refused", safeReturnPath("https://evil.example") === "/admin/connectors");
  check("backslash return path refused", safeReturnPath("/admin\\@evil") === "/admin/connectors");
  check("relative return path allowed", safeReturnPath("/admin/connectors?x=1") === "/admin/connectors?x=1");

  // ── authorize URL ────────────────────────────────────────────────────────
  const authorize = new URL(buildAuthorizeUrl(authCode(), { connector: "acme", clientId: "cid", flow }));
  const q = authorize.searchParams;
  check("authorize URL: response_type=code", q.get("response_type") === "code");
  check("authorize URL: PKCE S256 challenge",
    q.get("code_challenge") === codeChallengeFor(flow.codeVerifier) && q.get("code_challenge_method") === "S256");
  check("authorize URL: state echoed", q.get("state") === flow.state);
  check("authorize URL: scope forwarded", q.get("scope") === "read:things");
  check("redirect URI built from configured origin, not a header",
    q.get("redirect_uri") === redirectUriFor("acme") &&
    redirectUriFor("acme").startsWith("https://mos.test/api/connectors/acme/oauth/"));

  // ── code exchange ────────────────────────────────────────────────────────
  reset();
  const granted = await exchangeAuthorizationCode({
    policy: authCode(), connectorName: "acme", subject: "Acme",
    clientId: "cid", clientSecret: "sec", code: "the-code", codeVerifier: flow.codeVerifier,
  });
  check("code exchange returns access + refresh tokens",
    granted.accessToken === "granted-1" && granted.refreshToken === "refresh-1");
  check("code exchange sends the verifier and redirect_uri",
    (seen["POST /token"].body ?? "").includes(`code_verifier=${flow.codeVerifier}`) &&
    (seen["POST /token"].body ?? "").includes("redirect_uri="));
  check("granted tokens map onto reserved credential keys",
    tokensToCredentials(granted)[TOKEN_KEYS.refresh] === "refresh-1");

  // ── a connector holding a grant ──────────────────────────────────────────
  class GrantedProbe extends Probe {
    refreshes = 0;
    protected async refreshStoredTokens(): Promise<Record<string, string>> {
      this.refreshes++;
      const t = await refreshWithToken({
        policy: this.authOverride, connectorName: this.name, subject: this.name,
        clientId: "cid", clientSecret: "sec",
        refreshToken: this.credentials[TOKEN_KEYS.refresh] ?? "",
      });
      return tokensToCredentials(t);
    }
  }
  const grantedProbe = async (creds: Record<string, string>) => {
    const g = new GrantedProbe();
    g.authOverride = authCode();
    g.httpOverride = { baseUrl: base };
    await g.initialize({ clientId: "cid", clientSecret: "sec", ...creds });
    return g;
  };

  const live = {
    [TOKEN_KEYS.access]: "granted-9",
    [TOKEN_KEYS.refresh]: "refresh-9",
    [TOKEN_KEYS.expiresAt]: String(Date.now() + 3_600_000),
  };

  reset();
  let g = await grantedProbe(live);
  check("live grant is used without refreshing",
    (await g.call<{ token: string }>("/data"))?.token === "granted-9" && g.refreshes === 0);

  reset();
  g = await grantedProbe({ ...live, [TOKEN_KEYS.expiresAt]: String(Date.now() + 30_000) });
  await g.call("/data");
  check("token inside the expiry skew is refreshed first", g.refreshes === 1);

  reset(); apiMode = "expire-once";
  g = await grantedProbe({ ...live, [TOKEN_KEYS.access]: "granted-1" });
  const replayed = await g.call<{ token: string }>("/data", undefined, { maxAttempts: 1 });
  check("401 on a granted token refreshes and replays once",
    replayed?.token !== "granted-1" && g.refreshes === 1, `token=${replayed?.token}`);

  reset(); apiMode = "always401";
  g = await grantedProbe(live);
  const dead = await expectError(() => g.call("/data"));
  check("persistently rejected grant -> auth_failed", dead.category === "auth_failed");
  check("rejected grant refreshes at most once", g.refreshes === 1, `${g.refreshes} refresh(es)`);

  // ── configured reflects the grant, not just the client credentials ───────
  const noGrant = new GrantedProbe();
  noGrant.authOverride = authCode();
  noGrant.httpOverride = { baseUrl: base };
  await noGrant.initialize({ clientId: "cid", clientSecret: "sec" });
  check("client credentials without a grant is NOT configured", noGrant.configured === false);
  const withGrant = await grantedProbe(live);
  check("client credentials plus a grant IS configured", withGrant.configured === true);

  // A refresh token the provider has revoked. This is the state an admin has
  // to fix by reconnecting, so it must surface as auth_failed and must not be
  // retried into a second refresh.
  reset(); tokenMode = "reject400";
  const revoked = await grantedProbe({ ...live, [TOKEN_KEYS.expiresAt]: "0" });
  const revokedErr = await expectError(() => revoked.call("/data"));
  check("revoked refresh token -> auth_failed", revokedErr.category === "auth_failed",
    `status=${revokedErr.status}`);
  check("a failed refresh is not retried into a second one", revoked.refreshes === 1,
    `${revoked.refreshes} refresh(es)`);
  check("no API call attempted once the refresh failed", (hits["GET /data"] ?? 0) === 0);
  check("provider error body never reaches the connector error",
    !JSON.stringify(revokedErr).includes("invalid_client"));

  // ══ Response validation ══════════════════════════════════════════════════
  suite = "validation";
  reset();

  const Thing = z.object({ id: z.string(), label: z.string() });

  const good = await c.call("/typed-ok", undefined, { schema: Thing });
  check("a matching response passes through", (good as { id: string })?.id === "abc");

  const drift = await expectError(() => c.call("/typed", undefined, { schema: Thing }));
  check("a drifted response -> unexpected_response", drift.category === "unexpected_response");
  check("adminHint names the failing field", drift.adminHint.includes("id"), drift.adminHint);
  check("adminHint never contains the response VALUES",
    !JSON.stringify(drift).includes("tenant-secret-value") && !JSON.stringify(drift).includes("12345"));
  check("a validation failure is not retried", hits["GET /typed"] === 1, `${hits["GET /typed"]} call(s)`);
  check("user-facing message stays non-technical",
    !drift.userMessage.includes("id:") && drift.userMessage.includes("verify-probe"),
    drift.userMessage);

  const pagedTyped = await mk({ strategy: "none" }, {
    pagination: { style: "cursor", itemsPath: "data", cursorPath: "meta.next", cursorParam: "cursor", pageSize: 2 },
  });
  const badItem = await expectError(async () => {
    for await (const item of pagedTyped.pages("/page", { itemSchema: Thing })) void item;
  });
  check("paginate validates each item", badItem.category === "unexpected_response");

  // ══ Webhook verification ═════════════════════════════════════════════════
  suite = "webhooks";

  const SECRET = "whsec_test";
  const bodyText = JSON.stringify({ event: "thing.created", id: 7 });
  const policy = (over: Partial<ConnectorWebhookPolicy> = {}): ConnectorWebhookPolicy => ({
    algorithm: "hmac-sha256", signatureHeader: "x-signature", secretKey: "hookSecret", ...over,
  });
  const macOf = (payload: string, alg: "sha256" | "sha1" = "sha256") =>
    createHmac(alg, SECRET).update(payload, "utf8").digest();
  const hdrs = (o: Record<string, string>) => new Headers(o);

  const okHex = verifyWebhookSignature({
    policy: policy(), secret: SECRET, rawBody: bodyText,
    headers: hdrs({ "x-signature": macOf(bodyText).toString("hex") }),
  });
  check("hex signature accepted", okHex.ok === true);

  check("base64 signature accepted", verifyWebhookSignature({
    policy: policy(), secret: SECRET, rawBody: bodyText,
    headers: hdrs({ "x-signature": macOf(bodyText).toString("base64") }),
  }).ok === true);

  check("algorithm-prefixed signature accepted", verifyWebhookSignature({
    policy: policy(), secret: SECRET, rawBody: bodyText,
    headers: hdrs({ "x-signature": `sha256=${macOf(bodyText).toString("hex")}` }),
  }).ok === true);

  check("sha1 policy accepted", verifyWebhookSignature({
    policy: policy({ algorithm: "hmac-sha1" }), secret: SECRET, rawBody: bodyText,
    headers: hdrs({ "x-signature": macOf(bodyText, "sha1").toString("hex") }),
  }).ok === true);

  const tampered = verifyWebhookSignature({
    policy: policy(), secret: SECRET, rawBody: bodyText.replace('"id":7', '"id":8'),
    headers: hdrs({ "x-signature": macOf(bodyText).toString("hex") }),
  });
  check("a modified body is rejected", !tampered.ok && tampered.reason === "bad-signature");

  const wrongSecret = verifyWebhookSignature({
    policy: policy(), secret: "not-the-secret", rawBody: bodyText,
    headers: hdrs({ "x-signature": macOf(bodyText).toString("hex") }),
  });
  check("a wrong secret is rejected", !wrongSecret.ok && wrongSecret.reason === "bad-signature");

  const noSecret = verifyWebhookSignature({
    policy: policy(), secret: "", rawBody: bodyText,
    headers: hdrs({ "x-signature": macOf(bodyText).toString("hex") }),
  });
  check("an unconfigured secret refuses rather than accepting",
    !noSecret.ok && noSecret.reason === "not-configured");

  const missing = verifyWebhookSignature({
    policy: policy(), secret: SECRET, rawBody: bodyText, headers: hdrs({}),
  });
  check("a missing signature header is rejected", !missing.ok && missing.reason === "missing-signature");

  const tsPolicy = policy({ timestampHeader: "x-timestamp", toleranceSeconds: 300 });
  const nowSec = Math.floor(Date.now() / 1000);
  check("timestamped signature accepted inside the window", verifyWebhookSignature({
    policy: tsPolicy, secret: SECRET, rawBody: bodyText,
    headers: hdrs({ "x-timestamp": String(nowSec), "x-signature": macOf(`${nowSec}.${bodyText}`).toString("hex") }),
  }).ok === true);

  const oldSec = nowSec - 3600;
  const stale = verifyWebhookSignature({
    policy: tsPolicy, secret: SECRET, rawBody: bodyText,
    headers: hdrs({ "x-timestamp": String(oldSec), "x-signature": macOf(`${oldSec}.${bodyText}`).toString("hex") }),
  });
  check("a validly-signed but OLD delivery is rejected", !stale.ok && stale.reason === "stale",
    "without this a captured signature replays forever");

  const nowMs = Date.now();
  check("millisecond timestamps are understood too", verifyWebhookSignature({
    policy: tsPolicy, secret: SECRET, rawBody: bodyText,
    headers: hdrs({ "x-timestamp": String(nowMs), "x-signature": macOf(`${nowMs}.${bodyText}`).toString("hex") }),
  }).ok === true);

  const okA = verifyWebhookSignature({
    policy: policy(), secret: SECRET, rawBody: bodyText,
    headers: hdrs({ "x-signature": macOf(bodyText).toString("hex") }),
  });
  check("the same delivery yields a stable dedupe key",
    okA.ok && okHex.ok && okA.eventKey === okHex.eventKey);

  // ══ Failure envelope ═════════════════════════════════════════════════════
  suite = "envelope";

  const mkErr = (category: ConnectorErrorCategory, extra: Record<string, unknown> = {}) =>
    new ConnectorError({ category, connectorName: "acme-billing", subject: "Acme Billing", ...extra });

  // Status mapping. The interesting ones are the judgement calls, not the
  // obvious passthroughs.
  const statusFor = (c: ConnectorErrorCategory) => connectorErrorEnvelope(mkErr(c)).status;
  check("unconfigured -> 503 (a dependency is unavailable, not a client error)", statusFor("unconfigured") === 503);
  check("auth_failed -> 503 (our credential, not the caller's request)", statusFor("auth_failed") === 503);
  check("forbidden -> 503", statusFor("forbidden") === 503);
  check("rate_limited -> 429", statusFor("rate_limited") === 429);
  check("not_found -> 404", statusFor("not_found") === 404);
  check("invalid_request -> 502 (the connector sent it, not the HTTP client)", statusFor("invalid_request") === 502);
  check("conflict -> 409", statusFor("conflict") === 409);
  check("payload_too_large -> 413", statusFor("payload_too_large") === 413);
  check("timeout -> 504", statusFor("timeout") === 504);
  check("upstream_error -> 502", statusFor("upstream_error") === 502);
  check("network_error -> 502", statusFor("network_error") === 502);
  check("unexpected_response -> 502", statusFor("unexpected_response") === 502);

  const throttled = connectorErrorEnvelope(mkErr("rate_limited", { retryAfterMs: 4200 }));
  check("429 sets Retry-After in whole seconds, rounded up",
    throttled.headers["Retry-After"] === "5", throttled.headers["Retry-After"]);
  check("errors are never cached", throttled.headers["Cache-Control"] === "no-store");
  check("retryAfterMs is exposed to the client", throttled.body.error.retryAfterMs === 4200);

  // Audience split.
  const asUser = connectorErrorEnvelope(mkErr("unconfigured", { upstreamRequestId: "req-77" }));
  const asAdmin = connectorErrorEnvelope(
    mkErr("unconfigured", { upstreamRequestId: "req-77" }), { isAdmin: true });
  check("everyone learns which connector failed", asUser.body.error.connector === "Acme Billing");
  check("user message names the service and who fixes it",
    asUser.body.error.message.includes("Acme Billing") && asUser.body.error.message.includes("administrator"),
    asUser.body.error.message);
  check("non-admins get no adminHint", asUser.body.error.adminHint === undefined);
  check("non-admins get no registry link", asUser.body.error.adminActionUrl === undefined);
  check("non-admins get no upstream request id", asUser.body.error.upstreamRequestId === undefined);
  check("non-admins get no raw HTTP status", asUser.body.error.status === undefined);
  check("admins get the hint", typeof asAdmin.body.error.adminHint === "string");
  check("admins get a deep link to the right row",
    asAdmin.body.error.adminActionUrl === "/admin/connectors?connector=acme-billing");
  check("admins get the upstream request id", asAdmin.body.error.upstreamRequestId === "req-77");

  // An unexpected throw forwards nothing at all.
  const boom = connectorErrorEnvelope(new Error("db password is hunter2"), { isAdmin: true });
  check("a non-ConnectorError becomes a bare internal_error",
    boom.status === 500 && boom.body.error.category === "internal_error");
  check("an unexpected error's message is never forwarded",
    !JSON.stringify(boom).includes("hunter2"));

  // Which causes are an admin's to fix.
  check("unconfigured / auth_failed / forbidden are admin-actionable",
    ["unconfigured", "auth_failed", "forbidden"].every((c) => isAdminActionable(c as ConnectorErrorCategory)));
  check("transient causes are not admin-actionable",
    !isAdminActionable("timeout") && !isAdminActionable("upstream_error") && !isAdminActionable("rate_limited"));

  // The real Response a route returns.
  reset();
  const notFoundErr = await expectError(() => c.call("/missing"));
  const response = connectorErrorResponse(notFoundErr, { isAdmin: false });
  const payload = (await response.json()) as { error: Record<string, unknown> };
  check("connectorErrorResponse returns a real 404 Response", response.status === 404);
  check("envelope carries no upstream body",
    !JSON.stringify(payload).includes("secret-tenant-detail"));
  check("envelope shape is stable",
    ["category", "message", "connector", "retryAfterMs"].every((k) => k in payload.error));

  // ══ Advisory locking (requires a database) ═══════════════════════════════
  // The refresh lock is the one guarantee that cannot be proven without real
  // Postgres: it exists so that concurrent serverless invocations produce ONE
  // refresh, and with a provider that rotates refresh tokens on use, losing
  // that race invalidates the credential permanently.
  suite = "advisory-lock";
  if (!process.env.DATABASE_URL && !process.env.POSTGRES_URL && !process.env.PGHOST) {
    console.log("\n── advisory-lock ──\n  SKIP  no database configured (set DATABASE_URL to run)");
  } else {
    const { mutateConnectorCredentials } = await import("../src/lib/connectors/config");
    const { sql } = await import("../src/lib/db/client");
    const probeName = "__verify_probe__";

    try {
      await sql`delete from public.connector_configs where connector_name = ${probeName}`;

      // 1. Lost-update check. Eight concurrent read-modify-writes, each pausing
      //    mid-mutation the way a token-endpoint round trip would.
      const WRITERS = 8;
      await Promise.all(
        Array.from({ length: WRITERS }, () =>
          mutateConnectorCredentials(probeName, async (current) => {
            const n = Number(current.counter ?? "0");
            await new Promise((r) => setTimeout(r, 15));
            return { counter: String(n + 1) };
          }),
        ),
      );
      const [afterWrites] = await sql<{ encrypted_credentials: string }[]>`
        select encrypted_credentials from public.connector_configs where connector_name = ${probeName}
      `;
      const { decrypt } = await import("../src/lib/connectors/encryption");
      const finalCount = Number(
        (JSON.parse(decrypt(afterWrites.encrypted_credentials)) as Record<string, string>).counter,
      );
      check(`${WRITERS} concurrent writers, no lost updates`, finalCount === WRITERS,
        `counter=${finalCount}, expected ${WRITERS}`);

      // 2. The refresh-collapse guarantee: every waiter re-reads inside the
      //    lock and stands down if the work is already done.
      await sql`delete from public.connector_configs where connector_name = ${probeName}`;
      await mutateConnectorCredentials(probeName, () => ({ token: "old", fresh: "no" }));

      let refreshes = 0;
      await Promise.all(
        Array.from({ length: WRITERS }, () =>
          mutateConnectorCredentials(probeName, async (current) => {
            if (current.fresh === "yes") return null; // someone already did it
            await new Promise((r) => setTimeout(r, 15));
            refreshes++;
            return { token: "new", fresh: "yes" };
          }),
        ),
      );
      check(`${WRITERS} concurrent refreshes collapse to one`, refreshes === 1,
        `${refreshes} refresh(es)`);

      // 3. Webhook replay protection. A verified signature proves origin, not
      //    freshness of delivery — the claim is what makes it apply once.
      const { claimWebhookDelivery, releaseWebhookDelivery, pruneWebhookEvents } =
        await import("../src/lib/connectors/webhook");
      const evKey = `verify-${randomBytes(8).toString("hex")}`;
      check("first delivery is claimed", (await claimWebhookDelivery("__probe__", evKey)) === true);
      check("a replayed delivery is refused", (await claimWebhookDelivery("__probe__", evKey)) === false);

      const races = await Promise.all(
        Array.from({ length: 6 }, () => claimWebhookDelivery("__probe__", `race-${evKey}`)),
      );
      check("6 concurrent deliveries of one event: exactly one wins",
        races.filter(Boolean).length === 1, `${races.filter(Boolean).length} winner(s)`);

      await releaseWebhookDelivery(evKey);
      check("releasing a claim lets the provider's retry through",
        (await claimWebhookDelivery("__probe__", evKey)) === true);
      await sql`delete from public.connector_webhook_events where connector_name = '__probe__'`;
      check("the prune sweep runs without throwing", typeof (await pruneWebhookEvents()) === "number");

      // 4. Credentials an admin typed must survive a token write-back.
      await sql`delete from public.connector_configs where connector_name = ${probeName}`;
      await mutateConnectorCredentials(probeName, () => ({ clientId: "cid", clientSecret: "sec" }));
      const merged = await mutateConnectorCredentials(probeName, () =>
        tokensToCredentials({ accessToken: "a", refreshToken: "r", expiresAt: Date.now() + 1000 }),
      );
      check("token write-back never clobbers admin-entered credentials",
        merged.clientId === "cid" && merged.clientSecret === "sec" && merged[TOKEN_KEYS.access] === "a");
    } finally {
      await sql`delete from public.connector_configs where connector_name = ${probeName}`;
      await sql.end({ timeout: 5 });
    }
  }

  // ── report ───────────────────────────────────────────────────────────────
  server.close();
  let current = "";
  for (const r of results) {
    if (r.suite !== current) { current = r.suite; console.log(`\n── ${current} ──`); }
    console.log(`  ${r.ok ? "PASS" : "FAIL"}  ${r.label}${r.detail ? `  (${r.detail})` : ""}`);
  }
  const failed = results.filter((r) => !r.ok);
  console.log(`\n${results.length - failed.length}/${results.length} passed`);
  if (failed.length) process.exitCode = 1;
}

main().catch((e) => { console.error(e); server.close(); process.exitCode = 1; });
