/* This Source Code Form is subject to the terms of the Mozilla Public
 * License, v. 2.0. If a copy of the MPL was not distributed with this
 * file, You can obtain one at https://mozilla.org/MPL/2.0/. */

import type { NextConfig } from "next";

const nextConfig: NextConfig = {
  // Self-contained server bundle for the local Docker production image: a
  // `.next/standalone` tree with its own traced node_modules and a generated
  // server.js, so the runner stage needs no `npm install` at all.
  //
  // Two things about it that are easy to get wrong:
  //   - The generated server.js does `process.chdir(__dirname)`, so at runtime
  //     `process.cwd()` is the standalone root — not the repo root. Everything
  //     read through cwd has to land there (see outputFileTracingIncludes).
  //   - `next start` does not work with it; Next 16 warns and points at
  //     `node .next/standalone/server.js`, which is what the container runs.
  //
  // Skipped on Vercel on purpose. Vercel builds its own output format from the
  // same traces and has never needed this extra copy; turning it on there would
  // change every production build to buy nothing. The half that production DOES
  // need is outputFileTracingIncludes below, which stays unconditional.
  output: process.env.VERCEL ? undefined : "standalone",

  // One runtime code path reads the repository from disk by path, which
  // @vercel/nft's static analysis cannot see — it follows imports and literal
  // fs calls, not a runtime-computed directory walk:
  // src/lib/apps/api-router.ts readdir's `process.cwd()/apps/<slug>/api/**` and
  // checks for a literal "route.ts" on every app API request. Bundling the
  // module through the generated route map (src/generated/app-route-loaders.ts)
  // is not enough; the .ts SOURCE FILES have to exist on disk. Without them resolveRoutePath returns null and
  // nested app routes 404 (the bare index route still works, which makes this
  // fail quietly — test a nested path).
  //
  // Deliberately NOT also a `COPY` in the Dockerfile: one mechanism, in one
  // place. This is applied by Turbopack (the default builder in 16) on the Rust
  // side, and the values are globs resolved from the project root, so the trees
  // land at the standalone root at their project-relative paths — exactly where
  // `process.cwd()` will be. `outputFileTracingRoot` must stay unset; setting it
  // would nest the layout and break that.
  //
  // Unconditional because Vercel deploys use the same traces, so this covers
  // production too, not just the container.
  outputFileTracingIncludes: {
    // "/*" is the documented global key. It matches every dynamic route in this
    // app (including /api/apps/[...slug]); the copier de-dupes by output path,
    // so one match is enough to pull the tree in once.
    "/*": ["apps/**/*"],
  },

  // Never in a build: `.mixos/` holds this checkout's installs from the
  // Registry that nobody has registered yet, the checkout lock, and an
  // extension's folder while it is being removed (src/lib/repository/pending.ts,
  // src/lib/repository/backup.ts). src/lib/repository/install.ts names it by a
  // path the tracer can follow, so it is left out by name, wherever a build runs
  // from a checkout that has some.
  outputFileTracingExcludes: {
    "/*": [".mixos/**/*"],
  },

  turbopack: {
    resolveAlias: {
      "@apps": "./apps",
      "@connectors": "./connectors",
    },
    // The platform loads an extension's optional parts with a template-literal
    // import — @apps/<slug>/services/<name>, and likewise for MCP tools,
    // search handlers, jobs, syncs and a connector's index — inside a
    // try/catch that answers "no such handler" itself. Turbopack resolves each
    // template against the files on disk, and when no installed extension has
    // that kind of file (no app declares a service, a checkout has no
    // connectors) it warns "Module not found" on every compile. That is the
    // expected state of most installs.
    //
    // Only a template import under @apps/ or @connectors/ is quieted: Turbopack
    // titles it "Module not found: Can't resolve '@apps/' <dynamic> …", and the
    // "<dynamic>" marker is what a static import never has. A static import of a
    // missing module, or a template import anywhere else, still warns.
    //
    // App API routes are not on that list: they load through a generated map of
    // explicit imports (scripts/route-loaders.ts), because a template import
    // is resolved once, when the gateway compiles, and a route added under
    // `next dev` was a 404 until a restart.
    ignoreIssue: [
      {
        path: "**/src/**",
        title: /^Module not found: Can't resolve '@(?:apps|connectors)\/' <dynamic>/,
      },
    ],
  },
  experimental: {
    // Server Fast Refresh off, so that a route built after a change sees the
    // change. Next 16.4 turns it on by default for App Router routes under
    // Turbopack, and with it on, a new app's page answers 404 after `npm run
    // registry` until `next dev` restarts.
    //
    // In dev every route's server modules share one module system, and
    // src/generated/app-registry.ts is a single module in it that nearly every
    // page imports. With Fast Refresh, an edit reaches a module that is already
    // loaded only through an update pulled when a route is built, diffed
    // against the last version that same route pulled. A route built for the
    // first time after the edit has nothing to diff against, so it applies
    // nothing, and loading its chunks doesn't replace a module that's already
    // loaded. It gets the copy another route loaded before the edit. The new
    // app's page is that route: it reads the old registry, doesn't find the
    // app, and calls notFound(). It stays that way until a route built before
    // the edit is requested again, or the server restarts.
    //
    // With it off, a route's server chunks are evicted and loaded afresh after
    // a change, as before Fast Refresh. The cost is that an edit re-evaluates
    // the route's server modules, not just the one that changed. What has to
    // survive that is already on globalThis, like the database pool in
    // src/lib/db/client.ts. This is still needed on Next 16.4.6. The plan, with
    // the reproduction that tells you when it no longer is:
    // docs/plans/20261116_0733-page-registry.md.
    turbopackServerFastRefresh: false,
    // Upgrade reminders and `next upgrade --agent` follow security advisories
    // only: a reminder appears when the installed Next.js has a published
    // advisory, not for every new release. Next's default, written down so it
    // is a decision rather than an accident.
    agentUpgrade: "security",
  },
  devIndicators: false,
  logging: {
    incomingRequests: {
      // GitHub sends the admin back here with the App's one-time code in the
      // query string, which can be exchanged for its private key until it is
      // used. Development only: production doesn't log requests.
      ignore: [/\/api\/admin\/github\/created/],
    },
  },
  async rewrites() {
    // OAuth discovery documents must live at fixed `/.well-known/...` paths
    // (RFC 8414 / RFC 9728) — that's where every MCP client looks. A
    // dot-prefixed App Router directory isn't a documented convention, so the
    // handlers live under /api/well-known and are rewritten into place.
    //
    // `:path*` matches zero or more segments, so one rule covers both the bare
    // path and the suffixed form (`/.well-known/oauth-protected-resource/api/mcp`)
    // that RFC 9728 defines for a resource that isn't at the origin root.
    return [
      {
        source: "/.well-known/oauth-protected-resource/:path*",
        destination: "/api/well-known/oauth-protected-resource/:path*",
      },
      {
        source: "/.well-known/oauth-authorization-server/:path*",
        destination: "/api/well-known/oauth-authorization-server/:path*",
      },
    ];
  },
  async headers() {
    return [
      {
        source: "/(.*)",
        headers: [
          // Content-Security-Policy is NOT set here. It carries a per-request
          // nonce and therefore lives in src/proxy.ts. Setting it in both places
          // would not merge the two policies — the browser intersects them, so
          // the result would be stricter than either and fail in ways neither
          // file explains. `frame-ancestors 'self'` moved there intact.
          { key: "X-Content-Type-Options", value: "nosniff" },
          // HTTPS-only for a year, subdomains included. Harmless on plain http
          // (browsers ignore it off TLS), so it needs no environment guard.
          {
            key: "Strict-Transport-Security",
            value: "max-age=31536000; includeSubDomains",
          },
          { key: "Referrer-Policy", value: "strict-origin-when-cross-origin" },
          {
            key: "Permissions-Policy",
            value: "camera=(), microphone=(), geolocation=(self)",
          },
        ],
      },
    ];
  },
};

export default nextConfig;
