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

  // Two runtime code paths read the repository from disk by path, which
  // @vercel/nft's static analysis cannot see — it follows imports and literal
  // fs calls, not a runtime-computed directory walk:
  //
  //   - src/lib/apps/api-router.ts readdir's `process.cwd()/apps/<slug>/api/**`
  //     and checks for a literal "route.ts" on every app API request. Bundling
  //     the module via the dynamic `@apps/...` import is not enough; the .ts
  //     SOURCE FILES have to exist on disk. Without them resolveRoutePath
  //     returns null and nested app routes 404 (the bare index route still
  //     works, which makes this fail quietly — test a nested path).
  //   - src/components/apps/guide-tabs.tsx and
  //     src/components/connectors/connector-guide-tabs.tsx readFile
  //     `process.cwd()/docs/apps/*.md` and `docs/connectors/*.md`. Missing
  //     files here are an unhandled ENOENT, i.e. a 500 on the guide pages.
  //
  // Deliberately NOT also a `COPY` in the Dockerfile: one mechanism, in one
  // place. This is applied by Turbopack (the default builder in 16) on the Rust
  // side, and the values are globs resolved from the project root, so the trees
  // land at the standalone root at their project-relative paths — exactly where
  // `process.cwd()` will be. `outputFileTracingRoot` must stay unset; setting it
  // would nest the layout and break that.
  //
  // Unconditional because Vercel deploys use the same traces, so this is very
  // likely fixing those two bugs in production too, not just in the container.
  outputFileTracingIncludes: {
    // "/*" is the documented global key. It matches every dynamic route in this
    // app (including /api/apps/[...slug]); the copier de-dupes by output path,
    // so one match is enough to pull each tree in once.
    "/*": ["apps/**/*", "docs/apps/**/*", "docs/connectors/**/*"],
  },

  // Never in a build: `.mixos/` holds this checkout's installs from the
  // Registry that nobody has registered yet, and the checkout lock
  // (src/lib/repository/pending.ts). src/lib/repository/install.ts names it by a
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
  },
  devIndicators: false,
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
