/* This Source Code Form is subject to the terms of the Mozilla Public
 * License, v. 2.0. If a copy of the MPL was not distributed with this
 * file, You can obtain one at https://mozilla.org/MPL/2.0/. */

import type { AppManifest, RouteAuth } from "./types";

/**
 * Which pages and API routes of an app are reachable by which non-session tier.
 *
 * Pure, and safe on the client: it reads only the manifest the registry already
 * ships to the admin page. The admin dialog renders it, and the server actions
 * that guard the password and API-key settings validate against it, so the
 * screen and the gate can never disagree about what an app exposes.
 *
 * PAGES COME FROM `pageVisibility`; API ROUTES FROM THE HOISTED ROUTE CONTRACTS.
 * A route's auth is declared next to its handler (`defineRoute`), and the
 * registry carries it for each method, because one path can serve GET publicly
 * and keep POST behind a session.
 */

export type SurfaceKind = "page" | "api";

export interface Surface {
  kind: SurfaceKind;
  /** Stable React key: the method and path for an API route. */
  key: string;
  /** What an admin reads: `/p/<slug>/…` or `GET /api/p/<slug>/…`. */
  label: string;
  auths: RouteAuth[];
}

function formatPath(prefix: string, key: string): string {
  return key ? `${prefix}/${key}` : prefix;
}

/** Every page and API route, with the auths it accepts. */
export function appSurfaces(app: AppManifest): Surface[] {
  const out: Surface[] = [];

  for (const [key, auths] of Object.entries(app.pageVisibility ?? {})) {
    out.push({
      kind: "page",
      key: `page:${key}`,
      label: formatPath(`/p/${app.slug}`, key),
      auths,
    });
  }

  for (const route of app.routes ?? []) {
    for (const m of route.methods) {
      out.push({
        kind: "api",
        key: `api:${m.method} ${route.path}`,
        label: `${m.method} ${formatPath(`/api/p/${app.slug}`, route.path)}`,
        auths: m.auth,
      });
    }
  }

  return out;
}

/** Surfaces accepting a given tier. A surface accepting several appears in each. */
export function surfacesFor(app: AppManifest, auth: RouteAuth): Surface[] {
  return appSurfaces(app).filter((s) => s.auths.includes(auth));
}

/** Does anything in this app ask for the shared unlock password? */
export function appUsesPassword(app: AppManifest): boolean {
  return surfacesFor(app, "password").length > 0;
}

/**
 * The scopes an API key for this app can be given, one per method that accepts
 * the `key` tier, in the exact form `keyAllows()` matches: `"<METHOD> /<path>"`.
 * `"*"` (every route) is offered separately by the UI and accepted by the
 * server, so it is not listed here.
 */
export function keyScopes(app: AppManifest): string[] {
  const scopes: string[] = [];
  for (const route of app.routes ?? []) {
    for (const m of route.methods) {
      if (m.auth.includes("key")) scopes.push(`${m.method} /${route.path}`);
    }
  }
  return scopes;
}
