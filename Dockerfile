# The production image: what self-hosting runs (deploy/docker-compose.yml, and
# the Render and Railway templates — see docs/hosting/), and what the local
# `npm run docker:prod` profile builds to reproduce production.
#
# It is NOT what Vercel builds — Vercel builds from source with its own
# pipeline. Locally it exists so `npm run docker:prod` reproduces the runtime
# shape of production (compiled output, NODE_ENV=production, no dev server, no
# devDependencies on disk) closely enough to catch the class of bug that only
# shows up after a build: missing runtime files, server components that read
# from disk, instrumentation that never registers.
#
# The image also carries the release step — database migrations and the first
# admin — as ops/release.cjs, so the same image that serves traffic can prepare
# its database first. See the `ops` notes in the builder and runner stages.
#
# Node 24 to match the pin in .nvmrc (package.json `engines` is the floor,
# >=22, not the target). bookworm-slim (glibc), NOT alpine: Next 16 builds with
# Turbopack, which needs the @next/swc native binding, and package-lock.json
# only carries @next/swc-linux-arm64-gnu / -x64-gnu. A musl base would resolve
# nothing and fail the build.

# ---------------------------------------------------------------------------
# deps — dependency install, cached on the lockfile alone
# ---------------------------------------------------------------------------
FROM node:24-bookworm-slim AS deps
WORKDIR /app

# Only the manifests, so editing source doesn't invalidate the npm layer.
COPY package.json package-lock.json ./

# `npm ci` (not `install`) because package-lock.json is committed and we want
# the exact tree CI and production resolve. Deliberately NOT `--omit=dev`: the
# builder needs tsx (the `prebuild` registry generator) and typescript (next
# build type-checks inline). NODE_ENV is intentionally left unset here — setting
# it to production would make npm skip devDependencies and break the build two
# stages later with a confusing "tsx: not found".
RUN npm ci --no-audit --no-fund

# ---------------------------------------------------------------------------
# builder — next build
# ---------------------------------------------------------------------------
FROM node:24-bookworm-slim AS builder
WORKDIR /app

ENV NEXT_TELEMETRY_DISABLED=1

# next.config.ts turns `output: "standalone"` OFF when process.env.VERCEL is
# set, so that adding this image did not silently change what Vercel produces.
# Nothing needs setting here — VERCEL is simply absent in a local build — but
# the dependency runs the other way from what you would expect, so: do not add
# a VERCEL variable to this stage.

COPY --from=deps /app/node_modules ./node_modules
COPY . .

# `npm run build`, not `npx next build`: the `prebuild` hook regenerates
# src/generated/ (the app and connector registries) from apps/ and connectors/,
# and that directory is gitignored, so it does not exist in the build context.
#
# No secrets are needed or accepted here. Everything except NEXT_PUBLIC_* is
# read at request time from the compose env_file; the one NEXT_PUBLIC_ reference
# in the codebase (src/lib/db/supabase.ts) is a fallback behind SUPABASE_URL and
# inlines as undefined, which is correct — the runtime value wins.
RUN npm run build

# Fail the build loudly if the runtime file trees did not make it into the
# standalone output. Two server code paths read the repo off disk at request
# time and neither is visible to @vercel/nft's static analysis:
#
#   - src/lib/apps/api-router.ts readdir's process.cwd()/apps/<slug>/api/** and
#     fs.access's a literal "route.ts" on every app API request. Bundling the
#     route module is not enough; the .ts source file itself must be present.
#   - src/components/apps/guide-tabs.tsx and
#     src/components/connectors/connector-guide-tabs.tsx readFile
#     process.cwd()/docs/apps/*.md and docs/connectors/*.md.
#
# next.config.ts pulls them in with outputFileTracingIncludes. Without this
# check a misconfiguration produces a perfectly healthy-looking image where
# /apps/guide 500s and nested app API routes 404 — symptoms that look like
# application bugs, days later, on someone else's machine.
RUN set -eu; \
    missing=""; \
    [ -d .next/standalone/apps ] || missing="$missing apps/"; \
    [ -f .next/standalone/docs/apps/architecture.md ] || missing="$missing docs/apps/"; \
    [ -f .next/standalone/docs/connectors/architecture.md ] || missing="$missing docs/connectors/"; \
    if [ -n "$missing" ]; then \
      echo "ERROR: missing from .next/standalone:$missing" >&2; \
      echo "  These are read from process.cwd() at runtime and must be listed in" >&2; \
      echo "  outputFileTracingIncludes in next.config.ts. See the comment above" >&2; \
      echo "  this check in the Dockerfile." >&2; \
      exit 1; \
    fi

# The release step (scripts/release.ts), bundled with its dependencies into
# ops/*.cjs. The runner stage carries compiled output and no tsx, so a script
# has to arrive already compiled to run there — and it has to run there,
# because Render and Railway run a pre-deploy command in the service's own
# image and cannot select another build stage. After `npm run build`, whose
# prebuild hook generated the app registry the bundle reads. It also puts
# libpg-query.wasm beside the bundle: the parser that checks app migrations
# loads it from there.
RUN npm run build:ops

# ---------------------------------------------------------------------------
# runner — the shipped image
# ---------------------------------------------------------------------------
FROM node:24-bookworm-slim AS runner
WORKDIR /app

ENV NODE_ENV=production \
    NEXT_TELEMETRY_DISABLED=1 \
    PORT=3000 \
    HOSTNAME=0.0.0.0

# The commit this image was built from, shown on the admin pages beside the
# version. Purely descriptive — nothing gates on it — but "which code is this
# instance actually running" is unanswerable without it. Read by
# src/lib/platform/version.ts. deploy/docker-compose.yml passes it from the
# shell:
#
#   MIXOS_COMMIT=$(git rev-parse HEAD) docker compose -f deploy/docker-compose.yml build
#
# EMPTY BY DEFAULT, which the app reads as unset. Render and Railway build this
# image without the argument and set their own commit variables at runtime, and
# the app falls through to those; with none, the commit shows as unknown.
#
# It is an ARG in the RUNNER stage rather than something the builder derives from
# git, because .dockerignore keeps .git out of the build context (line 23) — the
# builder has no repository to ask.
#
# The version needs no argument. `npm run build` above stamps package.json's
# version into the build (src/generated/build-info.ts).
ARG MIXOS_COMMIT=""
ENV MIXOS_COMMIT=${MIXOS_COMMIT}

# WHERE THE RUNTIME FILE TREES LAND, AND WHY IT IS THIS COPY AND NOT ANOTHER
# --------------------------------------------------------------------------
# The standalone server.js does `process.chdir(__dirname)` before listening, so
# process.cwd() at runtime is *the standalone root* — here, /app. Everything the
# app reads via process.cwd() has to sit directly under that root.
#
# outputFileTracingIncludes copies apps/ and docs/ into .next/standalone/ at
# their project-relative paths, so the single COPY below puts them at
# /app/apps and /app/docs — exactly where cwd-relative reads expect them. No
# second `COPY /app/apps ./apps` is needed, and adding one would be actively
# worse: two mechanisms for one invariant, either able to mask the other's
# breakage, and only one of them also fixes the Vercel deployment (which relies
# on the same nft traces).
#
# The trap this comment exists to prevent: a hand-written `COPY apps ./apps`
# looks equivalent but is only correct while the standalone root happens to
# equal WORKDIR. Set outputFileTracingRoot (e.g. for a monorepo) and Next nests
# the output as .next/standalone/<subdir>/server.js, cwd becomes /app/<subdir>,
# and /app/apps goes invisible while the image still looks complete.
COPY --from=builder /app/.next/standalone ./

# Standalone deliberately omits these two — the docs assume a CDN serves them.
# There is no CDN in front of this container, so server.js has to.
COPY --from=builder /app/.next/static ./.next/static
COPY --from=builder /app/public ./public

# The release step and the platform schema it applies: `node ops/release.cjs`.
# It resolves everything from the image root (/app) — the platform migrations
# here, the app migrations under apps/ from the standalone copy above.
COPY --from=builder /app/ops ./ops
COPY --from=builder /app/supabase/migrations ./supabase/migrations

# READ-ONLY TO THE SERVER. The copies above have no --chown, so every file is
# root's: the server runs as `node` and can read its code but not change it.
# It owns only the two directories Next writes to while serving:
#
#   .next/cache                 optimized images, from /_next/image
#   .next/server/route-cache    Next's copy of a pre-rendered page (the 404
#                               page) once it has served or regenerated it
#
# Neither is in the build output, so they are made here. route-cache is Next's
# own name for it (next/dist/server/lib/route-cache-key.js). If an upgrade
# renames it, Next logs a warning when the write fails and serves the page
# from memory.
#
# deploy/docker-compose.yml also runs the image on a read-only root
# filesystem, with a tmpfs on both, owned by uid 1000, and on /tmp. Anything
# added that writes at runtime needs the same: a directory `node` owns here,
# and a mount there.
RUN mkdir -p .next/cache .next/server/route-cache \
 && chown node:node .next/cache .next/server/route-cache

# The node base image already ships an unprivileged `node` user (uid 1000);
# reusing it beats minting another one.
USER node

EXPOSE 3000

# `node -e` rather than curl/wget: bookworm-slim ships neither reliably, and
# installing one just for a health probe adds an apt layer and a root step for
# no benefit. Node has had a global fetch since 18.
#
# /live, not /ready: this is the container's own restart signal, and a Postgres
# blip should not restart the app process. The compose healthcheck uses /ready,
# which is the "should this receive traffic" question.
HEALTHCHECK --interval=30s --timeout=5s --start-period=30s --retries=3 \
  CMD node -e "fetch('http://127.0.0.1:3000/api/health/live').then(r => process.exit(r.ok ? 0 : 1)).catch(() => process.exit(1))"

# NOT `next start`. Next 16 warns that it "does not work with output:
# standalone configuration" and points here instead — and this stage has no
# full node_modules to run the next CLI from anyway. Port and host come from the
# PORT / HOSTNAME env above; server.js has no CLI flags.
CMD ["node", "server.js"]
