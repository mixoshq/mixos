/* This Source Code Form is subject to the terms of the Mozilla Public
 * License, v. 2.0. If a copy of the MPL was not distributed with this
 * file, You can obtain one at https://mozilla.org/MPL/2.0/. */

import type { AppManifest, RouteAuth } from "@/lib/apps/types";
import { servesPublicSurface } from "@/lib/apps/types";

interface Props {
  app: AppManifest;
}

// One badge per accepted auth, ordered loudest-first so the widest exposure is
// the first thing an admin reads. A surface accepting several auths genuinely
// is several things at once — collapsing that to one badge would hide the case
// this panel exists to make visible.
const AUTH_ORDER: RouteAuth[] = ["public", "password", "key", "signed-in", "session"];

function badgeFor(auth: RouteAuth): { label: string; className: string } {
  switch (auth) {
    case "public":
      return { label: "Public", className: "bg-success text-success-foreground" };
    case "password":
      return { label: "Password", className: "bg-warning text-warning-foreground" };
    case "key":
      return { label: "API key", className: "bg-primary text-primary-foreground" };
    case "signed-in":
      return { label: "Signed in", className: "bg-muted text-foreground" };
    case "session":
    default:
      return { label: "Session", className: "bg-muted text-foreground" };
  }
}

function sortAuths(auths: RouteAuth[]): RouteAuth[] {
  return [...auths].sort(
    (a, b) => AUTH_ORDER.indexOf(a) - AUTH_ORDER.indexOf(b),
  );
}

function formatPath(prefix: string, key: string): string {
  // "" means the root page/route — show the surface prefix so it's obvious.
  if (!key) return prefix;
  return `${prefix}/${key}`;
}

/**
 * API rows come from the HOISTED ROUTE CONTRACTS, not from `apiVisibility`.
 *
 * The manifest map is the legacy/parity view and is usually absent, because the
 * recommended place to declare auth is next to the handler. A panel reading only
 * the map showed an empty "Public Surface" for an app whose routes were in fact
 * public — the operator's only view of what is internet-reachable, silently
 * blank. Per method, because a route may serve GET publicly and keep POST behind
 * a session.
 */
function publicApiRows(
  app: AppManifest,
): { key: string; label: string; auths: RouteAuth[] }[] {
  const rows: { key: string; label: string; auths: RouteAuth[] }[] = [];

  for (const route of app.routes ?? []) {
    for (const m of route.methods) {
      if (!servesPublicSurface(m.auth)) continue;
      rows.push({
        key: `${m.method} ${route.path}`,
        label: `${m.method} ${formatPath(`/api/p/${app.slug}`, route.path)}`,
        auths: m.auth,
      });
    }
  }

  // Anything declared only in the manifest and not carried by a contract.
  const covered = new Set((app.routes ?? []).map((r) => r.path));
  for (const [key, auths] of Object.entries(app.apiVisibility ?? {})) {
    if (covered.has(key)) continue;
    if (!servesPublicSurface(auths)) continue;
    rows.push({
      key,
      label: formatPath(`/api/p/${app.slug}`, key),
      auths,
    });
  }

  return rows;
}

export default function AppVisibilityPanel({ app }: Props) {
  const pageEntries = Object.entries(app.pageVisibility ?? {}).filter(([, auths]) =>
    servesPublicSurface(auths),
  );
  const apiRows = publicApiRows(app);
  if (pageEntries.length === 0 && apiRows.length === 0) return null;

  return (
    <div
      className="mt-4 rounded-lg border border-border bg-background p-3"
      onClick={(e) => e.stopPropagation()}
    >
      <p className="text-xs font-semibold uppercase tracking-widest text-muted-foreground">
        Public Surface
      </p>
      <p className="mt-1 text-xs text-muted-foreground">
        These pages and API routes are reachable without a signed-in user.
        Password-marked items require visitors to enter the app password
        (set below) before access.
      </p>

      <div className="mt-3 grid gap-4 sm:grid-cols-2">
        {pageEntries.length > 0 && (
          <div>
            <p className="text-xs font-medium text-foreground">Pages</p>
            <ul className="mt-1 space-y-1 text-xs">
              {pageEntries.map(([key, vis]) => {
                return (
                  <li key={key} className="flex items-center justify-between gap-2">
                    <code className="rounded bg-muted px-1 py-0.5">
                      {formatPath(`/p/${app.slug}`, key)}
                    </code>
                    <span className="flex flex-wrap justify-end gap-1">
                      {sortAuths(vis).map((auth) => {
                        const b = badgeFor(auth);
                        return (
                          <span
                            key={auth}
                            className={`rounded-full px-2 py-0.5 text-[10px] font-medium uppercase tracking-wider ${b.className}`}
                          >
                            {b.label}
                          </span>
                        );
                      })}
                    </span>
                  </li>
                );
              })}
            </ul>
          </div>
        )}

        {apiRows.length > 0 && (
          <div>
            <p className="text-xs font-medium text-foreground">API routes</p>
            <ul className="mt-1 space-y-1 text-xs">
              {apiRows.map((row) => {
                return (
                  <li key={row.key} className="flex items-center justify-between gap-2">
                    <code className="rounded bg-muted px-1 py-0.5">
                      {row.label}
                    </code>
                    <span className="flex flex-wrap justify-end gap-1">
                      {sortAuths(row.auths).map((auth) => {
                        const b = badgeFor(auth);
                        return (
                          <span
                            key={auth}
                            className={`rounded-full px-2 py-0.5 text-[10px] font-medium uppercase tracking-wider ${b.className}`}
                          >
                            {b.label}
                          </span>
                        );
                      })}
                    </span>
                  </li>
                );
              })}
            </ul>
          </div>
        )}
      </div>
    </div>
  );
}
