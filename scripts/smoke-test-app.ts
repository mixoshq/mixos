/* This Source Code Form is subject to the terms of the Mozilla Public
 * License, v. 2.0. If a copy of the MPL was not distributed with this
 * file, You can obtain one at https://mozilla.org/MPL/2.0/. */

/**
 * Smoke-test an app's connector data path against a running dev server.
 *
 * Usage:
 *   SMOKE_COOKIE='<authjs.session-token value>' \
 *     npx tsx scripts/smoke-test-app.ts <app-slug>
 *
 * Walks apps/<slug>/api/**\/route.ts, fetches every GET route through the
 * /api/apps/[...slug] gateway, and classifies the response so the caller
 * (typically the /mixos app skill) can decide what to do next.
 *
 * Outcome classes are documented inline on the Outcome type below. Exit
 * code is 0 only if every route lands on an OK_* / UNCONFIGURED_TENANT /
 * SKIPPED_* outcome.
 */

import { promises as fs } from "fs";
import path from "path";

const REPO_ROOT = path.resolve(__dirname, "..");
const PORT = process.env.PORT ?? "3000";
const HOST = `http://localhost:${PORT}`;
const COOKIE = process.env.SMOKE_COOKIE;
const FETCH_TIMEOUT_MS = 30_000;

interface AppManifest {
  name: string;
  connectors?: string[];
}

interface RouteInfo {
  /** Path under apps/<slug>/api, slash-joined. "" for the index route. */
  apiPath: string;
  /** HTTP methods exported from route.ts. */
  methods: string[];
  /** True if any segment is `[param]`. */
  isDynamic: boolean;
  /** Connector names referenced via `context.connectors.<name>`. */
  connectorsUsed: string[];
  /** Connectors used without a `<name>?.configured` (or `.configured`) guard. */
  unguardedConnectors: string[];
}

type Outcome =
  /** 2xx, non-empty body, not the not-connected sentinel. */
  | "OK_DATA"
  /**
   * 200 with `{ "connected": false }`. Legacy shape from the removed
   * user-scoped (per-user OAuth) connector model. Still classified rather than
   * treated as data so an app carrying the old pattern is reported clearly
   * instead of passing with an empty payload — but a connector is now either
   * configured for everyone or for no one, so new code should return 503.
   */
  | "OK_NOT_CONNECTED"
  /** 2xx with `{}`, `[]`, or null body. Could be valid; could be a shape bug. */
  | "OK_EMPTY"
  /** 503 — the `configured` guard fired. Expected when an admin hasn't set creds. */
  | "UNCONFIGURED_TENANT"
  /** 401 — no/invalid session cookie reached the gateway. */
  | "UNAUTHENTICATED"
  /** 403 — session valid but user lacks app access (or upstream auth failed). */
  | "AUTH_ERROR"
  /** 429 from the platform or upstream. */
  | "RATE_LIMITED"
  /** 5xx without a recognised guard shape — likely a real upstream/code failure. */
  | "UPSTREAM_ERROR"
  /** 5xx on a route that uses a connector without a configured guard — code bug. */
  | "GUARD_MISMATCH"
  /** Has a `[param]` segment; cannot synthesise a value. */
  | "SKIPPED_DYNAMIC"
  /** route.ts exports no GET handler. */
  | "SKIPPED_NO_GET"
  | "UNKNOWN";

interface RouteResult {
  route: RouteInfo;
  url?: string;
  status?: number;
  outcome: Outcome;
  excerpt?: string;
  notes: string[];
}

const PASSING: ReadonlySet<Outcome> = new Set([
  "OK_DATA",
  "OK_NOT_CONNECTED",
  "UNCONFIGURED_TENANT",
  "SKIPPED_DYNAMIC",
  "SKIPPED_NO_GET",
]);

async function main(): Promise<void> {
  const slug = process.argv[2];
  if (!slug) die("Usage: tsx scripts/smoke-test-app.ts <app-slug>");
  if (slug.startsWith("_")) {
    die(
      `Refusing to smoke-test underscore-prefixed app "${slug}" (template, skipped by registry).`,
    );
  }

  const appDir = path.join(REPO_ROOT, "apps", slug);
  const manifestPath = path.join(appDir, "app.json");
  let manifest: AppManifest;
  try {
    manifest = JSON.parse(await fs.readFile(manifestPath, "utf8")) as AppManifest;
  } catch (err) {
    die(`Failed to read ${manifestPath}: ${(err as Error).message}`);
  }

  const declaredConnectors = manifest.connectors ?? [];
  if (declaredConnectors.length === 0) {
    console.log(`[smoke] ${slug} declares no connectors. Nothing to smoke-test.`);
    return;
  }

  const apiDir = path.join(appDir, "api");
  let routes: RouteInfo[];
  try {
    routes = await walkApi(apiDir);
  } catch {
    console.log(`[smoke] ${slug} has no api/ directory. Nothing to smoke-test.`);
    return;
  }
  if (routes.length === 0) {
    console.log(`[smoke] ${slug} has no api routes. Nothing to smoke-test.`);
    return;
  }

  if (!COOKIE) {
    console.error(
      [
        "[smoke] SMOKE_COOKIE is not set. The /api/apps gateway requires a valid",
        "        NextAuth session.",
        `        1. Open ${HOST} and sign in as a user with access to the app.`,
        "        2. In DevTools → Application → Cookies, copy the value of",
        "           `authjs.session-token` (or `__Secure-authjs.session-token`).",
        `        3. Re-run as: SMOKE_COOKIE='<value>' npx tsx scripts/smoke-test-app.ts ${slug}`,
      ].join("\n"),
    );
    process.exit(2);
  }

  console.log(`[smoke] App: ${slug}`);
  console.log(`[smoke] Declared connectors: ${declaredConnectors.join(", ")}`);
  console.log(`[smoke] Routes discovered: ${routes.length}`);
  console.log("");

  const results: RouteResult[] = [];
  for (const route of routes) {
    results.push(await testRoute(slug, route));
  }

  printTable(results);
  printGuardWarnings(results);
  printExcerpts(results);

  const failing = results.filter((r) => !PASSING.has(r.outcome));
  console.log("");
  if (failing.length === 0) {
    console.log("[smoke] All routes look healthy.");
    process.exit(0);
  }
  console.log(
    `[smoke] ${failing.length} route(s) need attention. See "When the smoke test fails" in /mixos app.`,
  );
  process.exit(1);
}

async function walkApi(apiDir: string): Promise<RouteInfo[]> {
  const out: RouteInfo[] = [];
  await walk(apiDir, [], out);
  return out;
}

async function walk(dir: string, segments: string[], out: RouteInfo[]): Promise<void> {
  const entries = await fs.readdir(dir);

  if (entries.includes("route.ts")) {
    const filePath = path.join(dir, "route.ts");
    const source = await fs.readFile(filePath, "utf8");
    const methods = extractMethods(source);
    const { used, unguarded } = analyseConnectorUsage(source);
    out.push({
      apiPath: segments.join("/"),
      methods,
      isDynamic: segments.some((s) => s.startsWith("[") && s.endsWith("]")),
      connectorsUsed: used,
      unguardedConnectors: unguarded,
    });
  }

  for (const entry of entries) {
    if (entry === "route.ts") continue;
    const full = path.join(dir, entry);
    const stat = await fs.stat(full);
    if (stat.isDirectory()) {
      await walk(full, [...segments, entry], out);
    }
  }
}

function extractMethods(source: string): string[] {
  const methods = new Set<string>();
  const re = /export\s+(?:async\s+)?function\s+(GET|POST|PUT|PATCH|DELETE)\b/g;
  let m: RegExpExecArray | null;
  while ((m = re.exec(source)) !== null) methods.add(m[1]);
  return [...methods];
}

function analyseConnectorUsage(source: string): {
  used: string[];
  unguarded: string[];
} {
  const used = new Set<string>();
  const re = /context\.connectors\.([a-zA-Z0-9_]+)/g;
  let m: RegExpExecArray | null;
  while ((m = re.exec(source)) !== null) used.add(m[1]);

  const unguarded: string[] = [];
  for (const name of used) {
    const guardRe = new RegExp(`\\b${name}\\??\\.configured\\b`);
    if (!guardRe.test(source)) unguarded.push(name);
  }
  return { used: [...used], unguarded };
}

async function testRoute(slug: string, route: RouteInfo): Promise<RouteResult> {
  const notes: string[] = [];
  if (route.unguardedConnectors.length > 0) {
    notes.push(
      `connectors used without a configured guard: ${route.unguardedConnectors.join(", ")}`,
    );
  }

  if (route.isDynamic) return { route, outcome: "SKIPPED_DYNAMIC", notes };
  if (!route.methods.includes("GET")) return { route, outcome: "SKIPPED_NO_GET", notes };

  const url = `${HOST}/api/apps/${slug}${route.apiPath ? "/" + route.apiPath : ""}`;
  const ac = new AbortController();
  const timer = setTimeout(() => ac.abort(), FETCH_TIMEOUT_MS);
  let res: Response;
  try {
    res = await fetch(url, {
      method: "GET",
      headers: { Cookie: cookieHeader() },
      signal: ac.signal,
      redirect: "manual",
    });
  } catch (err) {
    return {
      route,
      url,
      outcome: "UPSTREAM_ERROR",
      excerpt: `fetch failed: ${(err as Error).message}`,
      notes,
    };
  } finally {
    clearTimeout(timer);
  }

  // A redirect from the gateway means the session was rejected and Next is
  // sending us to /login. Treat that as unauthenticated.
  if (res.status >= 300 && res.status < 400) {
    return {
      route,
      url,
      status: res.status,
      outcome: "UNAUTHENTICATED",
      excerpt: `redirect to ${res.headers.get("location") ?? "(unknown)"}`,
      notes,
    };
  }

  const text = await res.text();
  const excerpt = text.slice(0, 800);
  let body: unknown = null;
  try {
    body = JSON.parse(text);
  } catch {
    /* not JSON */
  }

  return {
    route,
    url,
    status: res.status,
    outcome: classify(res.status, body, route),
    excerpt,
    notes,
  };
}

function cookieHeader(): string {
  const v = COOKIE!;
  // Accept either the bare token value or a pre-formatted "name=value[; ...]"
  // pair so the user can copy directly from DevTools either way.
  return v.includes("=") ? v : `authjs.session-token=${v}`;
}

function classify(status: number, body: unknown, route: RouteInfo): Outcome {
  if (status === 401) return "UNAUTHENTICATED";
  if (status === 403) return "AUTH_ERROR";
  if (status === 429) return "RATE_LIMITED";
  if (status === 503) return "UNCONFIGURED_TENANT";

  const isObj =
    body !== null && typeof body === "object" && !Array.isArray(body);
  const errorField =
    isObj && typeof (body as { error?: unknown }).error === "string"
      ? (body as { error: string }).error
      : undefined;

  if (status >= 500) {
    if (route.unguardedConnectors.length > 0) return "GUARD_MISMATCH";
    if (errorField && /unauthor|invalid_grant|forbidden|scope|token/i.test(errorField)) {
      return "AUTH_ERROR";
    }
    return "UPSTREAM_ERROR";
  }

  if (status >= 200 && status < 300) {
    if (isObj && (body as { connected?: unknown }).connected === false) {
      return "OK_NOT_CONNECTED";
    }
    if (
      body === null ||
      (Array.isArray(body) && body.length === 0) ||
      (isObj && Object.keys(body as object).length === 0)
    ) {
      return "OK_EMPTY";
    }
    if (body !== null && typeof body !== "undefined") return "OK_DATA";
  }

  return "UNKNOWN";
}

function printTable(results: RouteResult[]): void {
  const rows = results.map((r) => ({
    route: "/" + r.route.apiPath,
    methods: r.route.methods.join(",") || "—",
    connectors: r.route.connectorsUsed.join(",") || "—",
    status: r.status?.toString() ?? "—",
    outcome: r.outcome,
  }));

  const widths = {
    route: Math.max(5, ...rows.map((r) => r.route.length)),
    methods: Math.max(7, ...rows.map((r) => r.methods.length)),
    connectors: Math.max(10, ...rows.map((r) => r.connectors.length)),
    status: Math.max(6, ...rows.map((r) => r.status.length)),
    outcome: Math.max(7, ...rows.map((r) => r.outcome.length)),
  };

  const header =
    "ROUTE".padEnd(widths.route) +
    "  " +
    "METHODS".padEnd(widths.methods) +
    "  " +
    "CONNECTORS".padEnd(widths.connectors) +
    "  " +
    "STATUS".padEnd(widths.status) +
    "  " +
    "OUTCOME";
  console.log(header);
  console.log("-".repeat(header.length));
  for (const r of rows) {
    console.log(
      r.route.padEnd(widths.route) +
        "  " +
        r.methods.padEnd(widths.methods) +
        "  " +
        r.connectors.padEnd(widths.connectors) +
        "  " +
        r.status.padEnd(widths.status) +
        "  " +
        r.outcome,
    );
  }
}

function printGuardWarnings(results: RouteResult[]): void {
  const flagged = results.filter((r) => r.notes.length > 0);
  if (flagged.length === 0) return;
  console.log("");
  console.log("[smoke] Static analysis warnings:");
  for (const r of flagged) {
    for (const note of r.notes) {
      console.log(`  /${r.route.apiPath}: ${note}`);
    }
  }
}

function printExcerpts(results: RouteResult[]): void {
  const interesting = results.filter(
    (r) => !PASSING.has(r.outcome) && r.excerpt,
  );
  if (interesting.length === 0) return;
  console.log("");
  console.log("[smoke] Response excerpts (first 400 chars, whitespace-collapsed):");
  for (const r of interesting) {
    console.log(
      `  /${r.route.apiPath} [${r.outcome}]: ${(r.excerpt ?? "").replace(/\s+/g, " ").slice(0, 400)}`,
    );
  }
}

function die(msg: string): never {
  console.error("[smoke] " + msg);
  process.exit(2);
}

main().catch((err) => {
  console.error("[smoke] Fatal:", err);
  process.exit(2);
});
