/* This Source Code Form is subject to the terms of the Mozilla Public
 * License, v. 2.0. If a copy of the MPL was not distributed with this
 * file, You can obtain one at https://mozilla.org/MPL/2.0/. */

/**
 * The maintenance response, and the parts of deciding on it that need no
 * database: what counts as behind, how long an answer is kept, which paths are
 * exempt, and what everything else gets. `./maintenance.ts` wires this to the
 * real checks, and `src/proxy.ts` runs it before anything else.
 *
 * ── THE WHOLE INSTANCE ──────────────────────────────────────────────────────
 *
 * A database behind the build fails one request at a time: whichever touches a
 * missing column or table errors, in whatever feature it belongs to, and the
 * rest work. The readiness probe keeps such a revision out of rotation on a
 * host that waits for it, but not every host does, and a probe tells nobody
 * who opens a page. So while the platform schema is behind, every request but
 * the two health probes gets a 503 with `Retry-After`: a static page for a
 * page, JSON for an API route. The scheduler tick waits, webhook senders retry,
 * and no route runs against a schema it wasn't written for.
 *
 * ── ONE APP ─────────────────────────────────────────────────────────────────
 *
 * An app whose own migrations are behind fails the same way, but only in its
 * own code: nothing else reads its schema. So the rest of the instance serves,
 * and that app alone answers "This app is being updated", with the same 503
 * and `Retry-After`. The app gate (`src/lib/apps/app-gate.ts`) holds back its
 * code, and each caller answers in its own terms. Pages are answered here,
 * from the proxy (`appMaintenanceGate`), because a page can't set its own
 * status: by the time it renders, the response is a 200.
 *
 * ── CAN'T TELL IS NOT BEHIND ────────────────────────────────────────────────
 *
 * The same rule as readiness: an unreachable database or a failing query is
 * not evidence that the schema is behind, and closing the whole instance on it
 * would turn every database blip into an outage page. A check that doesn't
 * answer within `MAINTENANCE_WAIT_MS` counts the same way, so the gate adds at
 * most that to a request while the database is slow.
 *
 * ── NO NUMBERS ──────────────────────────────────────────────────────────────
 *
 * No body carries a version, a count or a file name, and none tells the reader
 * what to run: a visitor isn't the operator. The server log names the versions
 * or the files, and the release step (`./maintenance.ts`).
 */

import { NextResponse } from "next/server";
import { withTimeout } from "@/lib/timeout";
import type { AppMigrationStatus } from "./app-migrations";
import type { SchemaVersionStatus } from "./schema-version";

export interface MaintenanceState {
  /** The platform schema is provably behind this build: the whole instance waits. */
  platformBehind: boolean;
  /** Apps with a migration this build carries that the database hasn't applied. */
  appsBehind: ReadonlySet<string>;
}

/** What a check that failed, or didn't answer in time, counts as. */
const CANT_TELL: MaintenanceState = { platformBehind: false, appsBehind: new Set() };

/**
 * The two checks' answers as one state. Both already report "can't tell" as
 * ok with nothing pending, so it reads as not behind here without a case of
 * its own.
 */
export function maintenanceStateOf(
  schema: Pick<SchemaVersionStatus, "ok">,
  apps: Pick<AppMigrationStatus, "pending">,
): MaintenanceState {
  return {
    platformBehind: !schema.ok,
    appsBehind: new Set(apps.pending.map((m) => m.slug)),
  };
}

/** How long an answer is kept: the same window as the checks' own caches. */
const MAINTENANCE_CACHE_MS = 15_000;

/** How long a request waits for a fresh answer: readiness's budget for its ping. */
const MAINTENANCE_WAIT_MS = 2_000;

/** Where an answer is kept, and the read that will replace it. */
export interface MaintenanceStateStore {
  kept?: { at: number; state: MaintenanceState };
  reading?: Promise<MaintenanceState>;
}

/**
 * Keep `read`'s answer for `ttlMs`, and share one read between every request
 * that arrives while it runs. A read that throws counts as can't tell and is
 * kept like any other answer, so a database that is down isn't asked once per
 * request. A request that waits `waitMs` without an answer is served as can't
 * tell; the read carries on, and its answer is kept when it comes.
 *
 * Kept in `store`, which callers that each build their own copy of this module
 * can share, so they keep one answer between them.
 */
export function cachedMaintenanceState(
  read: () => Promise<MaintenanceState>,
  {
    ttlMs = MAINTENANCE_CACHE_MS,
    waitMs = MAINTENANCE_WAIT_MS,
    now = Date.now,
    store = {},
  }: { ttlMs?: number; waitMs?: number; now?: () => number; store?: MaintenanceStateStore } = {},
): () => Promise<MaintenanceState> {
  function refresh(): Promise<MaintenanceState> {
    // `then(read)` rather than `read()`, so a read that throws before it
    // returns a promise is caught like one that rejects.
    store.reading ??= Promise.resolve()
      .then(read)
      .catch(() => CANT_TELL)
      .then((state) => {
        store.kept = { at: now(), state };
        store.reading = undefined;
        return state;
      });
    return store.reading;
  }

  return async () => {
    const { kept } = store;
    if (kept && now() - kept.at < ttlMs) return kept.state;
    return withTimeout(refresh(), waitMs, () => new Error("maintenance check timed out")).catch(
      () => CANT_TELL,
    );
  };
}

/**
 * Answered whatever the schema says. They are how a host and an operator find
 * out what state the instance is in, and the check would only answer what
 * readiness asks for itself.
 */
const EXEMPT = new Set(["/api/health/live", "/api/health/ready"]);

/** Every maintenance answer's `Retry-After`, in seconds. */
export const RETRY_AFTER_SECONDS = "30";

/** The headers every maintenance answer carries, the whole instance's or one app's. */
export const MAINTENANCE_HEADERS = {
  "Retry-After": RETRY_AFTER_SECONDS,
  "Cache-Control": "no-store",
} as const;

const MESSAGE = "This instance is being updated. Try again shortly.";

/**
 * What an app answers while its own migrations are behind: its routes and
 * pages, `callAppRoute()` and its MCP tools, in the same words.
 */
export const APP_UPDATING_MESSAGE = "This app is being updated. Try again shortly.";

// Static, with no script, and no digit but the heading tag's. It can't name the
// brand or use the theme: both come from the database this page exists to stay
// away from.
function staticPage(title: string, message: string): string {
  return `<!doctype html>
<html lang="en">
<head>
<meta name="viewport" content="width=device-width">
<meta name="color-scheme" content="light dark">
<title>${title}</title>
<style>body { font-family: system-ui, sans-serif; text-align: center; }</style>
</head>
<body>
<h1>${title}</h1>
<p>${message}</p>
</body>
</html>
`;
}

const PAGE = staticPage("Down for maintenance", MESSAGE);

// One app's. Static too, because the proxy answers it before any page renders,
// and as plain: it says an update is under way, not what it waits for.
const APP_PAGE = staticPage("Being updated", APP_UPDATING_MESSAGE);

// Its own policy rather than the proxy's nonce policy: the page has nothing to
// run, so it may run nothing.
const PAGE_CSP =
  "default-src 'none'; style-src 'unsafe-inline'; base-uri 'none'; form-action 'none'; frame-ancestors 'self'";

function isUnder(pathname: string, prefix: string): boolean {
  return pathname === prefix || pathname.startsWith(`${prefix}/`);
}

/** Machine callers get JSON. `/.well-known` is `/api/well-known` before the rewrite. */
function wantsJson(pathname: string): boolean {
  return isUnder(pathname, "/api") || isUnder(pathname, "/.well-known");
}

function pageResponse(page: string): NextResponse {
  return new NextResponse(page, {
    status: 503,
    headers: {
      ...MAINTENANCE_HEADERS,
      "Content-Type": "text/html; charset=utf-8",
      "Content-Security-Policy": PAGE_CSP,
    },
  });
}

function maintenanceResponse(pathname: string): NextResponse {
  if (wantsJson(pathname)) {
    // `error` because it's what every API route here fails with, and what the
    // app SDK shows.
    return NextResponse.json({ error: MESSAGE }, { status: 503, headers: MAINTENANCE_HEADERS });
  }
  return pageResponse(PAGE);
}

/**
 * The maintenance response for `pathname`, or null to serve it as usual. The
 * health probes never ask `state`, so they answer even while it is slow.
 */
export async function maintenanceGate(
  pathname: string,
  state: () => Promise<MaintenanceState>,
): Promise<NextResponse | null> {
  if (EXEMPT.has(pathname)) return null;
  const { platformBehind } = await state();
  return platformBehind ? maintenanceResponse(pathname) : null;
}

// ── one app ─────────────────────────────────────────────────────────────────

/** Where an app's page is served: `/apps/<slug>/…` signed in, `/p/<slug>/…` public. */
export interface AppPagePath {
  surface: "apps" | "p";
  slug: string;
  /** The page's key, as the page route builds it: the path below the slug, "" for the root page. */
  pageKey: string;
}

/**
 * The app page `pathname` addresses, or null for any other path. An app's API
 * routes are not pages: the gateway answers for them, after it has resolved
 * the route, so a path no route serves stays a 404.
 */
export function appPagePath(pathname: string): AppPagePath | null {
  const [root, surface, slug, ...rest] = pathname.split("/");
  if (root !== "" || (surface !== "apps" && surface !== "p") || !slug) return null;
  // The platform's own page, which Next serves ahead of the root page of an
  // app with that slug.
  if (surface === "apps" && slug === "guide" && rest.length === 0) return null;
  let pageKey: string;
  try {
    // Decoded, as Next decodes the page's params.
    pageKey = rest
      .filter((segment) => segment !== "")
      .map((segment) => decodeURIComponent(segment))
      .join("/");
  } catch {
    // Not a path Next would route to a page either.
    return null;
  }
  return { surface, slug, pageKey };
}

/**
 * The "being updated" page for an app page whose app's own migrations are
 * behind this build, or null to serve it as usual.
 *
 * Only an app in `appsBehind` is looked at further, so every other page is
 * decided from the answer already kept, with no query. `updating` is asked
 * only then, and says whether the app gate holds this page back for the
 * update, which needs the database. It is what keeps a switched-off app's page
 * answering as it always has.
 */
export async function appMaintenanceGate(
  pathname: string,
  state: () => Promise<MaintenanceState>,
  updating: (page: AppPagePath) => Promise<boolean>,
): Promise<NextResponse | null> {
  const page = appPagePath(pathname);
  if (!page) return null;
  const { appsBehind } = await state();
  if (!appsBehind.has(page.slug)) return null;
  return (await updating(page)) ? pageResponse(APP_PAGE) : null;
}
