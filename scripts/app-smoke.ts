/* This Source Code Form is subject to the terms of the Mozilla Public
 * License, v. 2.0. If a copy of the MPL was not distributed with this
 * file, You can obtain one at https://mozilla.org/MPL/2.0/. */

/**
 * The app smoke test: call every route a signed-in user can reach without
 * changing data, the way that user's browser would, and say what answered.
 *
 * scripts/smoke-test-app.ts is the command. This module is everything it does,
 * kept apart so scripts/app-smoke.test.ts can drive it against a fake server.
 *
 * WHERE THE ROUTES COME FROM. The registry the build generated,
 * src/generated/app-registry.ts. Each app's `routes` are the contracts the
 * generator read off its `defineRoute()` exports (scripts/route-contracts.ts):
 * path, params, methods, auth, roles and budget. Not the route files' source:
 * a regex over source is how this test once found no routes at all.
 *
 * WHAT IS SENT. GET, and HEAD (Next answers HEAD by running the GET handler),
 * to every route whose GET a signed-in user can reach on /api/apps. A route
 * that accepts only a password or an API key is served on /api/p/ instead, and
 * is listed as skipped. POST, PUT, PATCH and DELETE are listed and never sent:
 * a route contract carries nothing that marks one safe to call. Path params get
 * FAKE_PARAM, a value no record has, so those routes should answer 4xx.
 *
 * NO BYPASS. The caller is an ordinary signed-in user. An app that is inactive,
 * or that the user isn't granted, is reported as such. Nothing here activates
 * an app, grants it, or reaches around the gateway.
 */

import type {
  RouteAuth,
  RouteContract,
  RouteMethodContract,
} from "../src/lib/apps/types";
import { isConnectorErrorEnvelope } from "../src/lib/connectors/response";

// ── Vocabulary ───────────────────────────────────────────────────────────────

/**
 * What happened to one request.
 *
 *   pass     answered without a server error
 *   fail     a 5xx, a network error, or no answer in time
 *   blocked  refused before it reached the route: signed out, app inactive or
 *            not granted, rate limited, or a method the server doesn't have
 *   skipped  not sent: it could change data, or a signed-in user can't reach it
 */
export type Result = "pass" | "fail" | "blocked" | "skipped";

/** What the run could tell about an app as a whole. */
export type AppStatus =
  /** Requests were sent and reached the gateway; each row says what answered. */
  | "tested"
  /** No route a signed-in user can call without changing data. */
  | "nothing-to-test"
  /** Every request answered 404, including one to a path with no params. */
  | "inactive"
  /** Every route that needs a grant answered 403. */
  | "not-granted"
  /** The gateway refused the session: a 401, or a redirect to /login. */
  | "signed-out"
  /** Every request answered 404, but every path takes params, so a missing
   *  record and an inactive app look the same. */
  | "unconfirmed";

export type SmokeMethod = RouteMethodContract["method"] | "HEAD";

export interface RouteResult {
  method: SmokeMethod;
  /** The route's pattern, e.g. `/items/[id]`. `/` is the index route. */
  path: string;
  /** What was requested, relative to the base URL. Absent when not sent. */
  url?: string;
  status?: number;
  result: Result;
  note?: string;
  /** Time to the full response, in milliseconds. */
  ms?: number;
}

export interface AppResult {
  slug: string;
  status: AppStatus;
  /** No failed or blocked request, and the app could be tested. */
  ok: boolean;
  note?: string;
  routes: RouteResult[];
}

/** The machine-readable outcome: the last line the command prints. */
export interface Verdict {
  ok: boolean;
  baseUrl: string;
  /** The signed-in user's email. Null when the run never got that far. */
  user: string | null;
  counts: Record<Result, number>;
  apps: AppResult[];
  /** Why the run could not start: bad arguments, no sign-in, no server. */
  error?: string;
}

/** What the smoke test needs of an app: the registry entry's slug and routes. */
export interface SmokeApp {
  slug: string;
  routes?: RouteContract[];
}

/**
 * A failure to start, worded to be printed as is. Its message never holds the
 * password or the session cookie.
 */
export class SmokeSetupError extends Error {
  constructor(message: string) {
    super(message);
    this.name = "SmokeSetupError";
  }
}

/** The value every path param gets. No record has it. */
export const FAKE_PARAM = "smoke-test-fake-id";

/**
 * Tiers a signed-in user's request can resolve to on /api/apps — ELIGIBLE_BY_MOUNT
 * in src/lib/apps/auth-tier.ts. A GET accepting none of them is served only on
 * /api/p/, to a password or an API key.
 */
const SIGNED_IN_TIERS: readonly RouteAuth[] = ["session", "signed-in", "public"];

/** Added to a route's own `budget.ms` before the smoke test stops waiting. */
const DEFAULT_GRACE_MS = 5_000;

/** Attempts per request when the platform answers 429. */
const RATE_LIMIT_TRIES = 3;
const MAX_RETRY_WAIT_MS = 30_000;

// ── Planning ─────────────────────────────────────────────────────────────────

export type Planned =
  | {
      send: true;
      method: "GET" | "HEAD";
      path: string;
      url: string;
      route: RouteContract;
      contract: RouteMethodContract;
    }
  | { send: false; method: SmokeMethod; path: string; note: string };

/**
 * The URL a route is called at, relative to the base URL, with FAKE_PARAM in
 * every dynamic segment (a catch-all gets it as its one segment).
 */
export function routeUrl(slug: string, routePath: string): string {
  const segments = routePath
    ? routePath
        .split("/")
        .map((seg) =>
          seg.startsWith("[") && seg.endsWith("]")
            ? FAKE_PARAM
            : encodeURIComponent(seg),
        )
    : [];
  return ["/api/apps", encodeURIComponent(slug), ...segments].join("/");
}

/** Every request the smoke test sends for an app, and every one it won't. */
export function planApp(app: SmokeApp): Planned[] {
  const planned: Planned[] = [];
  for (const route of app.routes ?? []) {
    const path = `/${route.path}`;
    for (const contract of route.methods) {
      if (contract.method !== "GET") {
        planned.push({
          send: false,
          method: contract.method,
          path,
          note: "could change data; not sent",
        });
        continue;
      }
      if (!contract.auth.some((a) => SIGNED_IN_TIERS.includes(a))) {
        planned.push({
          send: false,
          method: "GET",
          path,
          note: `only for ${contract.auth.join(" or ")} callers, on /api/p/; not sent`,
        });
        continue;
      }
      const url = routeUrl(app.slug, route.path);
      for (const method of ["GET", "HEAD"] as const) {
        planned.push({ send: true, method, path, url, route, contract });
      }
    }
  }
  return planned;
}

// ── One request ──────────────────────────────────────────────────────────────

/** What came back for one request. */
export interface Observation {
  status?: number;
  /** The body as text. Always "" for HEAD. */
  body?: string;
  /** The Location header of a redirect. */
  location?: string | null;
  error?: "timeout" | "network";
  /** For a network error: what failed, e.g. `ECONNREFUSED`. */
  message?: string;
  ms: number;
  /** How many times it was sent: more than once only after a 429. */
  tries: number;
}

type Fetch = typeof fetch;
type Sleep = (ms: number) => Promise<void>;

const realSleep: Sleep = (ms) => new Promise((resolve) => setTimeout(resolve, ms));

/** The most specific thing undici says about a failed fetch. */
function networkMessage(err: unknown): string {
  const cause = (err as { cause?: { code?: unknown; message?: unknown } })?.cause;
  if (typeof cause?.code === "string") return cause.code;
  if (typeof cause?.message === "string") return cause.message;
  return err instanceof Error ? err.message : String(err);
}

/** The values in a Cookie header, long enough to be worth hiding. */
function cookieValues(header: string): string[] {
  return header
    .split(";")
    .map((pair) => pair.slice(pair.indexOf("=") + 1).trim())
    .filter((v) => v.length >= 6);
}

/**
 * Text with every secret replaced. Belt and braces: nothing here prints a
 * secret on purpose, but an error from fetch can quote a header it refused.
 */
function scrub(text: string, secrets: readonly string[]): string {
  let out = text;
  for (const s of secrets) if (s) out = out.split(s).join("[redacted]");
  return out;
}

/** `Retry-After` in milliseconds, within bounds. */
function retryWait(res: Response): number {
  const seconds = Number(res.headers.get("retry-after"));
  const ms = Number.isFinite(seconds) && seconds > 0 ? seconds * 1000 : 1000;
  return Math.min(Math.max(ms, 250), MAX_RETRY_WAIT_MS);
}

async function request(
  f: Fetch,
  sleep: Sleep,
  absoluteUrl: string,
  method: "GET" | "HEAD",
  cookie: string,
  timeoutMs: number,
): Promise<Observation> {
  const started = performance.now();
  for (let tries = 1; ; tries++) {
    const ac = new AbortController();
    const timer = setTimeout(() => ac.abort(), timeoutMs);
    let res: Response;
    let body = "";
    try {
      res = await f(absoluteUrl, {
        method,
        headers: {
          cookie,
          accept: "application/json",
          "user-agent": "mixos-smoke-test",
        },
        redirect: "manual",
        signal: ac.signal,
      });
      // Read under the same timer: a route can send its headers and then stall.
      if (method === "GET") body = await res.text();
      else await res.body?.cancel();
    } catch (err) {
      const ms = Math.round(performance.now() - started);
      return ac.signal.aborted
        ? { error: "timeout", ms, tries }
        : { error: "network", message: networkMessage(err), ms, tries };
    } finally {
      clearTimeout(timer);
    }

    if (res.status === 429 && tries < RATE_LIMIT_TRIES) {
      await sleep(retryWait(res));
      continue;
    }
    return {
      status: res.status,
      body,
      location: res.headers.get("location"),
      ms: Math.round(performance.now() - started),
      tries,
    };
  }
}

// ── Classifying one response ─────────────────────────────────────────────────

function parseJson(text: string | undefined): unknown {
  if (!text) return undefined;
  try {
    return JSON.parse(text);
  } catch {
    return undefined;
  }
}

/** A short, printable account of an error body, or undefined if it has none. */
function describeError(text: string | undefined): string | undefined {
  const body = parseJson(text);
  let out: string | undefined;
  if (isConnectorErrorEnvelope(body)) {
    const { connector, category, message } = body.error;
    out = `${connector ? `${connector} ` : ""}${category}: ${message}`;
  } else if (
    body !== null &&
    typeof body === "object" &&
    typeof (body as { error?: unknown }).error === "string"
  ) {
    const { error, code } = body as { error: string; code?: unknown };
    out = typeof code === "string" ? `${code}: ${error}` : error;
  }
  if (!out) return undefined;
  const flat = out.replace(/\s+/g, " ").trim();
  return flat.length > 200 ? `${flat.slice(0, 199)}…` : flat;
}

/** Empty, or JSON with nothing in it: `null`, `""`, `{}`, `[]`. */
export function isEmptyBody(text: string): boolean {
  if (text.trim() === "") return true;
  const body = parseJson(text);
  if (body === null || body === "") return true;
  if (Array.isArray(body)) return body.length === 0;
  return typeof body === "object" && Object.keys(body as object).length === 0;
}

function isLoginRedirect(location: string | null | undefined): boolean {
  if (!location) return false;
  try {
    return new URL(location, "http://base.invalid").pathname === "/login";
  } catch {
    return false;
  }
}

/** What a sent request is classified against. */
export interface SentRequest {
  method: "GET" | "HEAD";
  route: RouteContract;
  contract: RouteMethodContract;
}

/**
 * One response on its own. Some answers mean something only next to the rest
 * of the app's — a 404 everywhere is an inactive app — and `settleApp`
 * revisits those.
 */
export function classify(
  req: SentRequest,
  obs: Observation,
): { result: Result; note?: string } {
  if (obs.error === "timeout") {
    return { result: "fail", note: `no answer in ${(obs.ms / 1000).toFixed(1)}s` };
  }
  if (obs.error === "network") {
    return { result: "fail", note: `network error: ${obs.message ?? "unknown"}` };
  }

  const status = obs.status ?? 0;
  const detail = describeError(obs.body);
  const withDetail = (lead: string) => (detail ? `${lead} ${detail}` : lead);

  if (status >= 500) return { result: "fail", note: withDetail(`${status}`) };

  if (status >= 300 && status < 400) {
    if (isLoginRedirect(obs.location)) {
      return { result: "blocked", note: "signed out: redirected to /login" };
    }
    return { result: "pass", note: `redirects to ${obs.location ?? "nowhere"}` };
  }

  if (status === 401) return { result: "blocked", note: "401: the session was refused" };
  if (status === 429) {
    return { result: "blocked", note: `429: rate limited, ${obs.tries} tries` };
  }
  if (status === 405) {
    return {
      result: "blocked",
      note: "405: the server has no GET here. Is it running the build this registry came from?",
    };
  }

  const params = req.route.params;
  if (status === 403) {
    const roles = req.contract.roles;
    return {
      result: "pass",
      note: roles.length > 0 ? `403: needs role ${roles.join(" or ")}` : withDetail("403"),
    };
  }
  if (status >= 400) {
    // The expected answer to a param no record has.
    if (params.length > 0) return { result: "pass" };
    const lead = `${status} with no params`;
    return { result: "pass", note: detail ? `${lead} (${detail})` : lead };
  }

  const notes: string[] = [];
  if (params.length > 0) notes.push(`${status} for a fake ${params.join(", ")}`);
  if (req.method === "GET") {
    const body = obs.body ?? "";
    if (isEmptyBody(body)) notes.push("empty body");
    else if ((parseJson(body) as { connected?: unknown } | undefined)?.connected === false) {
      notes.push("connected: false");
    }
  }
  return { result: "pass", ...(notes.length > 0 ? { note: notes.join("; ") } : {}) };
}

// ── Settling an app ──────────────────────────────────────────────────────────

/** A sent request with what came back and how it was first classified. */
export interface Sent extends SentRequest {
  path: string;
  url: string;
  obs: Observation;
  result: Result;
  note?: string;
}

/**
 * Only a session reaches this route on /api/apps, and a session needs a grant
 * (`resolveAuthTier`). A `signed-in` or `public` route answers without one.
 */
function needsGrant(auth: readonly RouteAuth[]): boolean {
  return auth.includes("session") && !auth.includes("signed-in") && !auth.includes("public");
}

/**
 * Decide what the app's answers add up to, and re-mark the rows that the
 * whole explains: when the app is inactive or not granted, its 404s and 403s
 * came from the gateway, not from its routes.
 *
 * Why these rules: the gateway answers an inactive app with the same 404 it
 * gives a route that doesn't exist, on purpose, so that an app that is off
 * can't be told from one that was never there. A path with no params that
 * this build declares should never be missing, so 404 on every route,
 * including one of those, means the app isn't being served. A grant-only
 * route answers 403 to an ungranted user before its handler runs, so 403 on
 * every one of them means no grant.
 */
export function settleApp(slug: string, planned: Planned[], sent: Sent[]): AppResult {
  let status: AppStatus;
  let note: string | undefined;

  const refused = (s: Sent) => s.obs.status === 401 || isLoginRedirect(s.obs.location);

  if (sent.length === 0) {
    status = "nothing-to-test";
    note =
      planned.length === 0
        ? "no API routes"
        : "every route could change data, or takes a password or API key";
  } else if (sent.every(refused)) {
    status = "signed-out";
    note = "the gateway refused the session. Sign in again and re-run.";
  } else if (sent.every((s) => s.obs.status === 404)) {
    if (sent.some((s) => s.route.params.length === 0)) {
      status = "inactive";
      note =
        "every route answered 404, including one with no params: the app is inactive, " +
        "or not in this server's build. Activate it in Admin > Apps.";
      for (const s of sent) {
        s.result = "blocked";
        s.note = "404: app not served";
      }
    } else {
      status = "unconfirmed";
      note =
        "every route takes params and answered 404, as an inactive app's would. " +
        "Check it's active in Admin > Apps.";
    }
  } else {
    const grantOnly = sent.filter((s) => needsGrant(s.contract.auth));
    if (grantOnly.length > 0 && grantOnly.every((s) => s.obs.status === 403)) {
      status = "not-granted";
      note =
        "every route that needs a grant answered 403. Grant the app to this user in " +
        "Admin > Users, with a role its routes accept.";
      for (const s of grantOnly) {
        s.result = "blocked";
        s.note = "403: not granted";
      }
    } else {
      status = "tested";
    }
  }

  // Rows in plan order, so GET and HEAD sit together and skips sit with their route.
  const bySent = new Map(sent.map((s) => [`${s.method} ${s.url}`, s]));
  const getStatus = new Map<string, number | undefined>();
  for (const s of sent) if (s.method === "GET") getStatus.set(s.url, s.obs.status);

  const routes: RouteResult[] = planned.flatMap((p): RouteResult[] => {
    if (!p.send) {
      return [{ method: p.method, path: p.path, result: "skipped", note: p.note }];
    }
    const s = bySent.get(`${p.method} ${p.url}`);
    if (!s) return [];
    let rowNote = s.note;
    // HEAD runs the GET handler, so the two should agree.
    const getAnswer = getStatus.get(s.url);
    if (s.method === "HEAD" && s.obs.status !== undefined && getAnswer !== s.obs.status) {
      const mismatch = `GET answered ${getAnswer ?? "nothing"}`;
      rowNote = rowNote ? `${rowNote}; ${mismatch}` : mismatch;
    }
    return [
      {
        method: s.method,
        path: s.path,
        url: s.url,
        ...(s.obs.status !== undefined ? { status: s.obs.status } : {}),
        result: s.result,
        ...(rowNote ? { note: rowNote } : {}),
        ms: s.obs.ms,
      },
    ];
  });

  const testable = status === "tested" || status === "nothing-to-test" || status === "unconfirmed";
  const ok = testable && routes.every((r) => r.result === "pass" || r.result === "skipped");
  return { slug, status, ok, ...(note ? { note } : {}), routes };
}

// ── Running ──────────────────────────────────────────────────────────────────

export interface RunOptions {
  /** Absolute, without a trailing slash. */
  baseUrl: string;
  /** The Cookie header that carries the session. */
  cookie: string;
  apps: SmokeApp[];
  fetch?: Fetch;
  sleep?: Sleep;
  /** Added to each route's `budget.ms` to get how long to wait for it. */
  graceMs?: number;
  /** Called with each app as soon as it's settled, for progress output. */
  onApp?: (app: AppResult) => void;
}

/** Smoke-test each app in turn, one request at a time. */
export async function runSmoke(opts: RunOptions): Promise<AppResult[]> {
  const f = opts.fetch ?? fetch;
  const sleep = opts.sleep ?? realSleep;
  const grace = opts.graceMs ?? DEFAULT_GRACE_MS;
  const hidden = cookieValues(opts.cookie);
  const results: AppResult[] = [];

  for (const app of opts.apps) {
    const planned = planApp(app);
    const sent: Sent[] = [];
    for (const p of planned) {
      if (!p.send) continue;
      const obs = await request(
        f,
        sleep,
        `${opts.baseUrl}${p.url}`,
        p.method,
        opts.cookie,
        p.contract.budget.ms + grace,
      );
      const req = { method: p.method, route: p.route, contract: p.contract };
      const { result, note } = classify(req, obs);
      sent.push({
        ...req,
        path: p.path,
        url: p.url,
        obs,
        result,
        ...(note ? { note: scrub(note, hidden) } : {}),
      });
    }
    const result = settleApp(app.slug, planned, sent);
    results.push(result);
    opts.onApp?.(result);
  }
  return results;
}

// ── Verdict ──────────────────────────────────────────────────────────────────

function emptyCounts(): Record<Result, number> {
  return { pass: 0, fail: 0, blocked: 0, skipped: 0 };
}

export function buildVerdict(baseUrl: string, user: string | null, apps: AppResult[]): Verdict {
  const counts = emptyCounts();
  for (const app of apps) for (const r of app.routes) counts[r.result] += 1;
  return { ok: apps.every((a) => a.ok), baseUrl, user, counts, apps };
}

/** The verdict of a run that couldn't start. */
export function setupFailure(baseUrl: string, error: string): Verdict {
  return { ok: false, baseUrl, user: null, counts: emptyCounts(), apps: [], error };
}

/** 0 when every app passed, 1 when anything failed or was blocked, 2 when the run couldn't start. */
export function exitCodeFor(verdict: Verdict): 0 | 1 | 2 {
  if (verdict.error !== undefined) return 2;
  return verdict.ok ? 0 : 1;
}

// ── Human-readable report ────────────────────────────────────────────────────

/** An app's lines: a heading, then one row per request. */
export function formatApp(app: AppResult): string[] {
  const lines = [`[smoke] ${app.slug}: ${app.status}${app.note ? ` (${app.note})` : ""}`];
  const width = Math.max(4, ...app.routes.map((r) => r.path.length));
  for (const r of app.routes) {
    const status = r.status !== undefined ? String(r.status) : "-";
    const ms = r.ms !== undefined ? `${r.ms}ms` : "";
    lines.push(
      `  ${r.result.padEnd(7)}  ${r.method.padEnd(6)} ${r.path.padEnd(width)}  ${status.padStart(3)}  ${ms.padStart(7)}` +
        (r.note ? `  ${r.note}` : ""),
    );
  }
  return lines;
}

export function formatSummary(verdict: Verdict): string {
  if (verdict.error !== undefined) return `[smoke] Could not run: ${verdict.error}`;
  const byStatus = new Map<AppStatus, number>();
  for (const a of verdict.apps) byStatus.set(a.status, (byStatus.get(a.status) ?? 0) + 1);
  const apps = [...byStatus].map(([s, n]) => `${n} ${s}`).join(", ");
  const c = verdict.counts;
  return (
    `[smoke] ${verdict.ok ? "OK" : "NOT OK"}: ${verdict.apps.length} app(s)${apps ? ` (${apps})` : ""}; ` +
    `${c.pass} pass, ${c.fail} fail, ${c.blocked} blocked, ${c.skipped} skipped`
  );
}

// ── Signing in ───────────────────────────────────────────────────────────────

const SESSION_COOKIE = /^(?:__Secure-)?authjs\.session-token(?:\.\d+)?$/;

/** Auth.js names the session cookie `__Secure-…` over HTTPS. */
export function sessionCookieName(baseUrl: string): string {
  return new URL(baseUrl).protocol === "https:"
    ? "__Secure-authjs.session-token"
    : "authjs.session-token";
}

/**
 * SMOKE_COOKIE as a Cookie header. A bare token, as DevTools shows it, gets
 * the session cookie's name; `name=value[; …]` is used as is.
 */
export function cookieHeaderFrom(value: string, baseUrl: string): string {
  const v = value.trim();
  return v.includes("=") ? v : `${sessionCookieName(baseUrl)}=${v}`;
}

/** `name=value` pairs from Set-Cookie headers, dropping deletions. */
function setCookies(res: Response): Map<string, string> {
  const out = new Map<string, string>();
  for (const line of res.headers.getSetCookie()) {
    const pair = line.split(";", 1)[0];
    const eq = pair.indexOf("=");
    if (eq <= 0) continue;
    const name = pair.slice(0, eq).trim();
    const value = pair.slice(eq + 1).trim();
    if (value) out.set(name, value);
    else out.delete(name);
  }
  return out;
}

function cookieHeader(cookies: Map<string, string>): string {
  return [...cookies].map(([k, v]) => `${k}=${v}`).join("; ");
}

async function reach(
  f: Fetch,
  url: string,
  init: RequestInit,
  hidden: readonly string[],
): Promise<Response> {
  try {
    return await f(url, { ...init, redirect: "manual", signal: AbortSignal.timeout(30_000) });
  } catch (err) {
    throw new SmokeSetupError(
      scrub(`can't reach ${new URL(url).origin}: ${networkMessage(err)}`, hidden),
    );
  }
}

/** Why Auth.js turned the sign-in down, from the `error` it redirects with. */
function signInRefusal(res: Response): string {
  const location = res.headers.get("location");
  let code: string | null = null;
  try {
    code = location ? new URL(location, "http://base.invalid").searchParams.get("error") : null;
  } catch {
    code = null;
  }
  if (code === "CredentialsSignin") return "wrong email or password";
  if (code === "MissingCSRF") return "the server refused the CSRF token";
  if (code) return `the server answered ${code}`;
  return `the server answered ${res.status} and set no session cookie`;
}

/**
 * Sign in with the password, the way Auth.js's own client does, and return the
 * session cookie as a Cookie header.
 *
 * Auth.js guards the credentials callback with a double-submit CSRF token:
 * GET /api/auth/csrf returns the token and sets a cookie holding it and a hash
 * of it with AUTH_SECRET. The POST has to carry both, the token in the form and
 * the cookie alongside. On success the answer is a redirect that sets
 * `authjs.session-token` (`__Secure-` prefixed over HTTPS, in numbered chunks
 * if it's long).
 *
 * The sign-in page itself uses a server action, which a script can't call. The
 * callback runs the same `authorize()` against the same users table.
 */
export async function signIn(opts: {
  baseUrl: string;
  email: string;
  password: string;
  fetch?: Fetch;
}): Promise<string> {
  const f = opts.fetch ?? fetch;

  const hidden = [opts.password];
  const csrfRes = await reach(
    f,
    `${opts.baseUrl}/api/auth/csrf`,
    { headers: { accept: "application/json" } },
    hidden,
  );
  const csrf = (await csrfRes.json().catch(() => null)) as { csrfToken?: unknown } | null;
  if (!csrfRes.ok || typeof csrf?.csrfToken !== "string") {
    throw new SmokeSetupError(
      `sign-in failed: ${opts.baseUrl}/api/auth/csrf answered ${csrfRes.status} without a CSRF token. Is this a MixOS server?`,
    );
  }
  const jar = setCookies(csrfRes);

  const res = await reach(
    f,
    `${opts.baseUrl}/api/auth/callback/credentials`,
    {
      method: "POST",
      headers: {
        "content-type": "application/x-www-form-urlencoded",
        cookie: cookieHeader(jar),
      },
      body: new URLSearchParams({
        email: opts.email,
        password: opts.password,
        csrfToken: csrf.csrfToken,
        callbackUrl: `${opts.baseUrl}/`,
      }),
    },
    hidden,
  );
  await res.body?.cancel();

  const session = new Map([...setCookies(res)].filter(([name]) => SESSION_COOKIE.test(name)));
  if (session.size === 0) throw new SmokeSetupError(`sign-in failed: ${signInRefusal(res)}`);
  return cookieHeader(session);
}

/**
 * Whose session this is, asked of Auth.js. Null when the server doesn't accept
 * the cookie: expired, revoked, or minted by another server.
 */
export async function sessionUser(opts: {
  baseUrl: string;
  cookie: string;
  fetch?: Fetch;
}): Promise<string | null> {
  const f = opts.fetch ?? fetch;
  const res = await reach(
    f,
    `${opts.baseUrl}/api/auth/session`,
    { headers: { accept: "application/json", cookie: opts.cookie } },
    cookieValues(opts.cookie),
  );
  if (!res.ok) {
    throw new SmokeSetupError(
      `${opts.baseUrl}/api/auth/session answered ${res.status}. Is this a MixOS server?`,
    );
  }
  const body = (await res.json().catch(() => null)) as { user?: { email?: unknown } } | null;
  const email = body?.user?.email;
  return typeof email === "string" && email ? email : null;
}
