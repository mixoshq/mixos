/* This Source Code Form is subject to the terms of the Mozilla Public
 * License, v. 2.0. If a copy of the MPL was not distributed with this
 * file, You can obtain one at https://mozilla.org/MPL/2.0/. */

/**
 * Which paths the proxy runs for, decided by Next's own matcher code from
 * `config.matcher`, the way the server decides it.
 *
 * The app API mounts must stay out: Next keeps only the first 10 MB of the
 * body of any request the proxy runs for, and hands the route the rest cut off
 * with nothing to say so. Everything else must stay in, because the proxy is
 * where every other path gets the maintenance response.
 */

import { test } from "node:test";
import assert from "node:assert/strict";
import {
  getMiddlewareMatchers,
  type ProxyMatcher,
} from "next/dist/build/analysis/get-page-static-info";
import { getMiddlewareRouteMatcher } from "next/dist/shared/lib/router/utils/middleware-route-matcher";
import { config } from "./proxy";

// What `next build` compiles `config.matcher` with. The module exports it, and
// its type declarations leave it out.
declare module "next/dist/build/analysis/get-page-static-info" {
  export function getMiddlewareMatchers(
    matcherOrMatchers: string | string[],
    nextConfig: { basePath?: string; i18n?: unknown },
  ): ProxyMatcher[];
}

const match = getMiddlewareRouteMatcher(getMiddlewareMatchers(config.matcher, {}));

/** As the server asks it: the pathname as sent, or decoded. */
function proxyRuns(pathname: string): boolean {
  const req = {} as Parameters<typeof match>[1];
  return match(pathname, req, {}) || match(decodeURIComponent(pathname), req, {});
}

test("the two app API mounts are outside the proxy, at every depth", () => {
  for (const path of [
    "/api/apps/notes",
    "/api/apps/notes/items",
    "/api/apps/notes/items/42",
    "/api/p/notes",
    "/api/p/notes/items",
    "/api/p/notes/items/%34%32",
  ]) {
    assert.equal(proxyRuns(path), false, path);
  }
});

test("pages and every other API route stay under the proxy", () => {
  for (const path of [
    "/",
    "/login",
    "/admin/apps",
    "/apps/notes",
    "/apps/notes/settings",
    "/p/notes",
    "/p/notes/report",
    "/api/apps",
    "/api/p",
    "/api/push/subscribe",
    "/api/auth/session",
    "/api/auth/callback/credentials",
    "/api/health/ready",
    "/api/mcp",
    "/api/cron",
    "/api/oauth/token",
    "/api/analytics/track",
    "/api/connectors/acme/oauth/start",
    "/.well-known/oauth-protected-resource",
  ]) {
    assert.equal(proxyRuns(path), true, path);
  }
});

test("the static exemptions are unchanged", () => {
  for (const path of [
    "/_next/static/chunks/main.js",
    "/_next/image",
    "/themes/mixos/logo.svg",
    "/connector-assets/acme.png",
    "/screenshots/notes/1.png",
    "/branding/notes/logo.png",
    "/favicon.ico",
    "/icon.png",
    "/apple-icon.png",
  ]) {
    assert.equal(proxyRuns(path), false, path);
  }
  assert.equal(proxyRuns("/themes/guide"), true, "/themes/guide is a signed-in page");
});
