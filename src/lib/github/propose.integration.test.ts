/* This Source Code Form is subject to the terms of the Mozilla Public
 * License, v. 2.0. If a copy of the MPL was not distributed with this
 * file, You can obtain one at https://mozilla.org/MPL/2.0/. */

/**
 * Proposing an install as a pull request, end to end, against a real Postgres
 * and the fake GitHub (./fake-github.ts) standing in for `fetch`, with a
 * catalogue and GitHub's archive host stood in beside it: the tree, the refs,
 * the title, the body and the audit row of a proposal; each refusal the
 * repository's files cause; the branch rule and the preview checklist; an
 * existing folder or branch; "No CI ran" and "changed since proposed"; then,
 * with the proposals merged (their folders grafted onto main as a merge would
 * leave them), an update and a removal of what the build runs: the folder on
 * main judged against the build's record and the release it names, the
 * comparison, a tree that replaces the folder with its deletions, a tree that
 * deletes it, the refusals (a mismatched folder, the same release, an older
 * or a withdrawn one unchosen, a required connector, the last theme), the
 * lists showing each kind; and, over every request the run made, that no
 * write ever left refs/heads/mixos/ or the extension's folder, and nothing
 * merged.
 *
 * Skipped unless MIXOS_TEST_DATABASE_URL names a server this may create and
 * drop a database on:
 *
 *   docker run -d --name gh -e POSTGRES_PASSWORD=pw -p 127.0.0.1:55432:5432 postgres:17
 *   MIXOS_TEST_DATABASE_URL=postgres://postgres:pw@127.0.0.1:55432/postgres \
 *     npx tsx --test src/lib/github/propose.integration.test.ts
 */

import { after, before, describe, test } from "node:test";
import assert from "node:assert/strict";
import crypto from "node:crypto";
import fs from "node:fs";
import path from "node:path";
import zlib from "node:zlib";
import postgres, { type Sql } from "postgres";
import { migratePlatform } from "../../../scripts/platform-migrations";
import type { TarEntry } from "../repository/tar";
import { FakeGitHub } from "./fake-github";

const REPO = path.resolve(__dirname, "../../..");
const serverUrl = process.env.MIXOS_TEST_DATABASE_URL;
const skip = serverUrl ? false : "set MIXOS_TEST_DATABASE_URL to run against a real Postgres";

const run = crypto.randomBytes(3).toString("hex");
const database = `mixos_propose_${run}`;
const CATALOGUE = "http://127.0.0.1:4430";

// ── packages, as GitHub archives, and what the catalogue says of them ──────

function header(name: string, size: number, type: string): Buffer {
  const h = Buffer.alloc(512);
  h.write(name, 0, 100, "utf8");
  h.write(`${(type === "5" ? 0o755 : 0o644).toString(8).padStart(7, "0")}\0`, 100, 8, "latin1");
  h.write("0000000\0", 108, 8, "latin1");
  h.write("0000000\0", 116, 8, "latin1");
  h.write(`${size.toString(8).padStart(11, "0")}\0`, 124, 12, "latin1");
  h.write("00000000000\0", 136, 12, "latin1");
  h.fill(0x20, 148, 156);
  h.write(type, 156, 1, "latin1");
  h.write("ustar\0", 257, 6, "latin1");
  h.write("00", 263, 2, "latin1");
  let sum = 0;
  for (const b of h) sum += b;
  h.write(`${sum.toString(8).padStart(6, "0")}\0 `, 148, 8, "latin1");
  return h;
}

function tarball(top: string, entries: TarEntry[]): Buffer {
  const blocks: Buffer[] = [header(`${top}/`, 0, "5")];
  for (const e of entries) {
    blocks.push(header(`${top}/${e.path}`, e.data.length, "0"), e.data);
    const pad = (512 - (e.data.length % 512)) % 512;
    if (pad) blocks.push(Buffer.alloc(pad));
  }
  blocks.push(Buffer.alloc(1024));
  return zlib.gzipSync(Buffer.concat(blocks));
}

const files = (spec: Record<string, string | Buffer>): TarEntry[] =>
  Object.entries(spec).map(([p, d]) => ({ path: p, mode: 0o644, data: Buffer.isBuffer(d) ? d : Buffer.from(d) }));

const ROUTE =
  'import { z } from "zod";\nimport { defineRoute } from "@/lib/apps/route";\n' +
  'export const GET = defineRoute({\n  auth: ["session"],\n  output: z.object({ ok: z.boolean() }),\n  handler: async () => ({ ok: true }),\n});\n';

/** A name holding every marker there is, a mention and an issue reference. */
const HOSTILE_NAME = "Files [skip ci]\nskip-checks: true\n[render preview] @everyone fixes #1";
const ICON = Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a, 0x00, 0x00, 0x00, 0x0d, 0xff, 0xfe]);

/** Another release of a fixture, for an update: its own archive and install manifest. */
interface MoreRelease {
  version: string;
  releasedAt: string;
  entries: TarEntry[];
  manifest?: Record<string, unknown>;
}

interface Fixture {
  kind: "app" | "connector" | "theme";
  entries: TarEntry[];
  manifest?: Record<string, unknown>;
  /** The archive served doesn't match the hash. */
  tampered?: boolean;
  /** Releases besides 1.2.0, which every fixture has. */
  more?: MoreRelease[];
}

const ICON2 = Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a, 0x00, 0x00, 0x00, 0x0d, 0x00, 0x01]);
const WHEN = { "1.1.0": "2026-10-01T12:00:00Z", "1.2.0": "2026-10-10T12:00:00Z", "1.2.1": "2026-10-11T12:00:00Z", "1.3.0": "2026-10-12T12:00:00Z" };

const FIXTURES: Record<string, Fixture> = {
  "e2e-files": {
    kind: "app",
    entries: files({
      "app.json": JSON.stringify({ name: HOSTILE_NAME, description: "Files." }),
      "README.md": "# Files\r\nWith CRLF, a BOM-less é, and \u2028.\n",
      "api/items/route.ts": ROUTE,
      "api/[id]/route.ts": ROUTE,
      "migrations/001_init.sql": "create table if not exists items (id uuid primary key);\n",
      "assets/icon.png": ICON,
      ".gitignore": "*.log\n",
    }),
    manifest: {
      name: HOSTILE_NAME,
      permissions: [{ scope: "network:api.example.com", reason: "cc @acme/team, closes #2 [x](https://evil.example)" }],
    },
    more: [
      // The update: two files changed, two added (one binary, one migration), two deleted.
      {
        version: "1.3.0",
        releasedAt: WHEN["1.3.0"],
        entries: files({
          "app.json": JSON.stringify({ name: HOSTILE_NAME, description: "Files 1.3.", egress: ["api.example.com"] }),
          "api/items/route.ts": `${ROUTE}// 1.3\n`,
          "migrations/001_init.sql": "create table if not exists items (id uuid primary key);\n",
          "migrations/002_index.sql": "create index if not exists items_id on items (id);\n",
          "assets/icon.png": ICON,
          "assets/logo.png": ICON2,
          ".gitignore": "*.log\n",
        }),
        manifest: { name: HOSTILE_NAME, permissions: [{ scope: "network:api.example.com", reason: "Reads items @everyone" }] },
      },
      { version: "1.2.1", releasedAt: WHEN["1.2.1"], entries: files({ "app.json": '{"name":"Files 1.2.1"}\n' }), manifest: { yanked: true, yankedReason: "Broken @maintainer" } },
      { version: "1.1.0", releasedAt: WHEN["1.1.0"], entries: files({ "app.json": '{"name":"Files 1.1"}\n' }) },
    ],
  },
  "e2e-conn": {
    kind: "connector",
    entries: files({ "connector.json": '{"name":"e2e-conn","displayName":"Conn"}\n', "index.ts": "export default {};\n" }),
    more: [
      {
        version: "1.2.1",
        releasedAt: WHEN["1.2.1"],
        entries: files({ "connector.json": '{"name":"e2e-conn","displayName":"Conn 1.2.1"}\n', "index.ts": "export default { v: 2 };\n" }),
        manifest: { yanked: true, yankedReason: "Leaks keys" },
      },
    ],
  },
  "e2e-board": { kind: "app", entries: files({ "app.json": '{"name":"Board"}\n' }) },
  "e2e-yanked": {
    kind: "app",
    entries: files({ "app.json": '{"name":"Yanked"}\n' }),
    manifest: { yanked: true, yankedReason: "Broken, see @maintainer #99\n```\n@everyone" },
  },
  "e2e-future": { kind: "app", entries: files({ "app.json": '{"name":"Future"}\n' }), manifest: { requiresMixOS: "99.0.0" } },
  "e2e-tampered": { kind: "app", entries: files({ "app.json": '{"name":"Tampered"}\n' }), tampered: true },
  "e2e-paper": {
    kind: "theme",
    entries: files({
      "theme.json": JSON.stringify({ name: "Paper", description: "A theme." }),
      "theme.css": ":root { --background: #fff; }\n",
    }),
    more: [
      {
        version: "1.1.0",
        releasedAt: WHEN["1.1.0"],
        entries: files({ "theme.json": JSON.stringify({ name: "Paper 1.1", description: "An earlier theme." }), "theme.css": ":root { --background: #eee; }\n" }),
      },
    ],
  },
};

/** The commit a fixture's release is published at: 1.2.0 is named by the slug alone. */
const shaOf = (slug: string, version = "1.2.0") =>
  crypto.createHash("sha1").update(version === "1.2.0" ? `lc30-${slug}` : `lc30-${slug}-${version}`).digest("hex");

const SEGMENT = { app: "apps", connector: "connectors", theme: "themes" } as const;

async function loadModules() {
  return {
    ...(await import("./propose")),
    ...(await import("./propose-change")),
    ...(await import("./proposals")),
    ...(await import("./link")),
    ...(await import("./store")),
    ...(await import("./jwt")),
    ...(await import("./git-objects")),
    ...(await import("../repository/install-record")),
    ...(await import("../repository/content-hash")),
    platformSql: (await import("@/lib/db/client")).sql,
  };
}

describe("proposing an install as a pull request", { skip }, () => {
  let admin: Sql;
  let sql: Sql;
  let p: Awaited<ReturnType<typeof loadModules>>;
  let fake: FakeGitHub;
  let ADMIN: { id: string; email: string };
  const realFetch = globalThis.fetch;
  const logs: string[] = [];
  const answers: unknown[] = [];
  const saved = { log: console.log, warn: console.warn, error: console.error, info: console.info };
  const catalogue = new Map<string, unknown>();
  const archives = new Map<string, Buffer>();
  const env = { ...process.env };

  const ctx = { admin: async () => ADMIN };
  const kept = <T>(outcome: T): T => {
    answers.push(outcome);
    return outcome;
  };
  const audited = async (action: string) =>
    (await sql`select actor_email, target_type, target_id, details, created_at from public.admin_audit_log where action = ${action} order by created_at`).map(
      (r) => ({ ...r }) as { actor_email: string; target_type: string; target_id: string; details: Record<string, unknown>; created_at: Date },
    );
  const repo = () => fake.repositories.get(501)!;
  /** Writes to the repository: token mints and revocations aren't. */
  const posts = () => fake.requests.filter((r) => r.host === "api" && r.method !== "GET" && r.path.startsWith("/repos/"));
  const propose = async (slug: string, extra: Record<string, unknown> = {}) =>
    kept(await p.proposeInstall({ kind: FIXTURES[slug].kind, slug, ...extra }, ctx));

  /** The workflow files this repository has, as the operator's fork would. */
  const ours = (file: string) => fs.readFileSync(path.join(REPO, file), "utf8");

  before(async () => {
    admin = postgres(serverUrl!, { max: 1, onnotice: () => {} });
    await admin.unsafe(`create database ${database}`);
    const u = new URL(serverUrl!);
    u.pathname = `/${database}`;
    sql = postgres(u.toString(), { max: 1, onnotice: () => {} });
    await migratePlatform(sql, path.join(REPO, "supabase", "migrations"));
    for (const level of ["log", "warn", "error", "info"] as const) {
      console[level] = (...args: unknown[]) =>
        void logs.push(args.map((a) => (a instanceof Error ? `${a.name}: ${a.message}` : String(a))).join(" "));
    }

    process.env.DATABASE_URL = u.toString();
    process.env.PGSSLMODE = u.searchParams.get("sslmode") ?? "disable";
    process.env.GITHUB_APP_ENCRYPTION_KEY = crypto.randomBytes(32).toString("hex");
    process.env.NEXTAUTH_URL = "https://mixos.test";
    process.env.MIXOS_REPOSITORY_URL = CATALOGUE;
    // A built deployment, on Vercel: the only place Browse proposes.
    process.env.VERCEL = "1";
    for (const flag of ["INSTALL_APPS", "INSTALL_CONNECTORS", "INSTALL_THEMES"]) delete process.env[flag];
    p = await loadModules();

    const [a] = await sql`
      insert into public.users (email, display_name, is_admin) values (${`admin-${run}@mixos.test`}, 'Admin', true)
      returning id, email`;
    ADMIN = { id: a.id, email: a.email };

    // The catalogue and the archives: 1.2.0 of each fixture, which `/install`
    // answers with, and the other releases by version.
    for (const [slug, f] of Object.entries(FIXTURES)) {
      const releases: MoreRelease[] = [{ version: "1.2.0", releasedAt: WHEN["1.2.0"], entries: f.entries, manifest: f.manifest }, ...(f.more ?? [])];
      const subpath = `${SEGMENT[f.kind]}/${slug}`;
      const listed: Record<string, unknown>[] = [];
      for (const r of releases) {
        const sha = shaOf(slug, r.version);
        const archivePath = `/acme/extensions/tar.gz/${sha}`;
        const served = f.tampered ? [...r.entries, ...files({ "extra.ts": "export const x = 1;\n" })] : r.entries;
        archives.set(archivePath, tarball(`acme-extensions-${sha.slice(0, 7)}`, served.map((e) => ({ ...e, path: `${subpath}/${e.path}` }))));
        const install = {
          kind: f.kind,
          slug,
          name: slug,
          version: r.version,
          commitSha: sha,
          gitTag: `v${r.version}`,
          tarballUrl: `https://codeload.github.com${archivePath}`,
          contentHash: p.hashFileTree(r.entries),
          subpath,
          permissions: [],
          requiresMixOS: "0.1.0",
          yanked: false,
          yankedReason: null as string | null,
          ...r.manifest,
        };
        const path = `/api/v1/${SEGMENT[f.kind]}/${slug}/install`;
        if (r.version === "1.2.0") catalogue.set(path, install);
        catalogue.set(`${path}?version=${r.version}`, install);
        listed.push({
          version: r.version,
          gitTag: `v${r.version}`,
          commitSha: sha,
          contentHash: install.contentHash,
          releasedAt: r.releasedAt,
          requiresMixOS: "0.1.0",
          yanked: install.yanked === true,
          yankedReason: install.yanked ? (install.yankedReason ?? null) : null,
        });
      }
      const dotted = releases.map((r) => r.version).filter((v) => /^\d+\.\d+\.\d+$/.test(v)).sort().reverse();
      catalogue.set(`/api/v1/${SEGMENT[f.kind]}/${slug}`, {
        slug,
        kind: f.kind,
        name: slug,
        tagline: "",
        latestVersion: dotted[0],
        author: { handle: "acme @everyone", verified: false },
        sourceRepo: { host: "github", owner: "acme", name: "extensions", url: "https://github.com/acme/extensions", subpath },
        releases: listed,
      });
    }

    // GitHub, the linked repository with this repository's own files, and the App, linked.
    fake = new FakeGitHub();
    fake.push(501, "main", {
      ".github/workflows/ci.yml": ours(".github/workflows/ci.yml"),
      ".github/workflows/danger.yml": ours(".github/workflows/danger.yml"),
      "render.yaml": ours("render.yaml"),
      "vercel.json": ours("vercel.json"),
      "apps/wall-e/app.json": '{"name":"Wall-E"}\n',
    });
    const { app, pem } = fake.createApp("acme", "MixOS Test", { contents: "write", pull_requests: "write", metadata: "read", checks: "read", statuses: "read" });
    const installation = fake.install(app.id, { selection: "selected", repositories: ["acme/mixos"] });
    const key = p.parsePrivateKey(pem);
    const at = new Date().toISOString();
    assert.ok(
      await p.recordApp(
        { id: app.id, slug: app.slug, name: app.name, owner: { id: 9001, login: "acme", type: "User" }, keyFingerprint: p.keyFingerprint(key), recordedAt: at },
        p.sealPrivateKey(p.storedPem(key)),
      ),
    );
    assert.ok(
      await p.recordLink(
        {
          installationId: installation.id,
          repository: { id: 501, owner: "acme", name: "mixos", defaultBranch: "main", private: true, fork: true, parent: { id: 1345491436, fullName: "mixoshq/mixos" } },
          linkedAt: at,
          checkedAt: at,
          disabled: null,
        },
        { repositoryId: 501, branch: "main", checkedAt: at, pullRequest: true, rules: ["deletion", "pull_request"] },
      ),
    );

    globalThis.fetch = (async (input: RequestInfo | URL, init?: RequestInit) => {
      const url = new URL(typeof input === "string" ? input : input instanceof URL ? input.href : input.url);
      if (url.origin === CATALOGUE) {
        const version = url.searchParams.get("version");
        const body = catalogue.get(version ? `${url.pathname}?version=${version}` : url.pathname);
        return new Response(JSON.stringify(body ?? { error: "not found" }), {
          status: body ? 200 : 404,
          headers: { "content-type": "application/json" },
        });
      }
      if (url.hostname === "codeload.github.com") {
        const gz = archives.get(url.pathname);
        return gz ? new Response(new Uint8Array(gz), { status: 200 }) : new Response("not found", { status: 404 });
      }
      return fake.fetch(input, init);
    }) as typeof fetch;
  });

  after(async () => {
    globalThis.fetch = realFetch;
    Object.assign(console, saved);
    for (const key of ["VERCEL", "MIXOS_REPOSITORY_URL", "GITHUB_APP_ENCRYPTION_KEY", "NEXTAUTH_URL"]) {
      if (env[key] === undefined) delete process.env[key];
      else process.env[key] = env[key];
    }
    await p?.platformSql.end();
    await sql?.end();
    if (admin) {
      await admin.unsafe(`drop database if exists ${database} with (force)`);
      await admin.end();
    }
  });

  test("the preview checklist is needed first, every item, and is audited", async () => {
    const refused = await propose("e2e-files");
    assert.equal(refused.ok, false);
    assert.equal(!refused.ok && refused.code, "checklist");
    assert.equal(posts().length, 0, "nothing written");
    assert.equal((await audited("app.propose.rejected")).at(-1)?.details.reason, "checklist");

    const linkCtx = { ...ctx, origin: () => "https://mixos.test" };
    const partial = await p.confirmPreviewChecklist({ items: ["render", "railway"] }, linkCtx);
    assert.equal(partial.ok, false);
    const confirmed = await p.confirmPreviewChecklist({ items: ["render", "railway", "coolify", "other"] }, linkCtx);
    assert.ok(confirmed.ok, JSON.stringify(confirmed));
    assert.deepEqual((await audited("github.previews.confirm"))[0]?.details.items, ["render", "railway", "coolify", "other"]);
  });

  test("before the first proposal, the dialog's check reads the repository and says it's ready", async () => {
    const check = kept(await p.checkProposal({ kind: "app", slug: "e2e-files" }, ctx));
    assert.ok(check.ok, JSON.stringify(check));
    if (!check.ok) return;
    assert.equal(check.ready, true, JSON.stringify(check.lines));
    assert.deepEqual(check.names, {
      branch: "mixos/install/app-e2e-files",
      title: "Add app e2e-files 1.2.0 from 127.0.0.1:4430 [skip preview]",
      folder: "apps/e2e-files",
    });
    assert.deepEqual(check.lines.map((l) => l.id), ["rule", "checklist", "workflows", "render", "vercel", "folder", "branch"]);
    assert.match(check.lines.find((l) => l.id === "workflows")!.detail, /2 checked/);
    assert.equal(posts().filter((r) => r.path.startsWith("/repos/")).length, 0, "the check writes nothing");
    assert.equal(fake.requests.some((r) => r.path.includes("codeload")), false);
  });

  let head = "";
  let base = "";
  test("a proposal: blobs for binary files, one tree, a commit, the branch and a pull request", async () => {
    base = repo().git.branches.get("main")!;
    const before = fake.requests.length;
    const outcome = await propose("e2e-files");
    assert.ok(outcome.ok, JSON.stringify(outcome));
    if (!outcome.ok) return;
    assert.equal(outcome.pullRequest.number, 1);
    assert.equal(outcome.pullRequest.url, "https://github.com/acme/mixos/pull/1");
    assert.equal(outcome.pullRequest.branch, "mixos/install/app-e2e-files");
    head = outcome.pullRequest.head;

    // The writes, in order.
    const writes = fake.requests.slice(before).filter((r) => r.method !== "GET" && r.path.startsWith("/repos/"));
    assert.deepEqual(
      writes.map((w) => `${w.method} ${w.path}`),
      [
        "POST /repos/acme/mixos/git/blobs",
        "POST /repos/acme/mixos/git/trees",
        "POST /repos/acme/mixos/git/commits",
        "POST /repos/acme/mixos/git/refs",
        "POST /repos/acme/mixos/pulls",
      ],
    );
    const tree = writes[1].body as { base_tree: string; tree: { path: string; mode: string; type: string; content?: string; sha?: string }[] };
    assert.equal(tree.base_tree, repo().git.commits.get(base)!.tree, "on the default branch's tree");
    assert.ok(tree.tree.every((e) => e.mode === "100644" && e.type === "blob" && e.path.startsWith("apps/e2e-files/")));
    assert.deepEqual(tree.tree.filter((e) => e.sha).map((e) => e.path), ["apps/e2e-files/assets/icon.png"], "binary only as a blob");
    assert.ok(!tree.tree.some((e) => e.path.endsWith(".gitignore")), ".gitignore left out");

    // What landed on the branch: the default branch plus the folder, byte for byte, and the record.
    const git = repo().git;
    const commit = git.commits.get(head)!;
    assert.deepEqual(commit.parents, [base]);
    assert.equal(commit.author, "mixos-test[bot]");
    const onBranch = git.files(commit.tree);
    const onMain = git.files(git.commits.get(base)!.tree);
    for (const [file, entry] of onMain) assert.deepEqual(onBranch.get(file), entry, file);
    const added = [...onBranch.keys()].filter((f) => !onMain.has(f)).sort();
    assert.deepEqual(added, [
      "apps/e2e-files/.registry.json",
      "apps/e2e-files/README.md",
      "apps/e2e-files/api/[id]/route.ts",
      "apps/e2e-files/api/items/route.ts",
      "apps/e2e-files/app.json",
      "apps/e2e-files/assets/icon.png",
      "apps/e2e-files/migrations/001_init.sql",
    ]);
    for (const entry of FIXTURES["e2e-files"].entries.filter((e) => e.path !== ".gitignore")) {
      assert.equal(onBranch.get(`apps/e2e-files/${entry.path}`)?.sha, p.gitBlobSha(entry.data), entry.path);
    }
    const record = JSON.parse(git.blobs.get(onBranch.get("apps/e2e-files/.registry.json")!.sha)!.toString("utf8"));
    assert.equal(record.source, CATALOGUE);
    assert.equal(record.version, "1.2.0");
    assert.equal(record.filesHash, p.filesHash(FIXTURES["e2e-files"].entries.filter((e) => e.path !== ".gitignore")));
    assert.equal(git.branches.get("mixos/install/app-e2e-files"), head);
    assert.equal(git.branches.get("main"), base, "the default branch didn't move");

    // The names: identifiers only, whatever the manifest's name says.
    const message = commit.message;
    const pull = repo().pulls[0];
    assert.equal(pull.title, "Add app e2e-files 1.2.0 from 127.0.0.1:4430 [skip preview]");
    assert.equal(pull.head, "mixos/install/app-e2e-files");
    assert.equal(pull.base, "main");
    for (const text of [message, pull.title, pull.head]) {
      assert.ok(!/skip ci|skip-checks|render preview|@everyone|Files \[/i.test(text), text);
    }
    assert.match(message, /^Add app e2e-files 1\.2\.0 from 127\.0\.0\.1:4430\n/);
    assert.match(message, /^Registry-Commit: [0-9a-f]{40}$/m);

    // The body: the publisher's words only in the fence, escaped.
    const fence = /(`{3,})text\n([\s\S]*?)\n\1/.exec(pull.body);
    assert.ok(fence, pull.body);
    const outside = pull.body.replace(fence![0], "");
    assert.ok(!/@|#\d|skip ci|render preview/i.test(outside), outside);
    assert.match(fence![2], /^name: Files \\\[skip ci\\\] skip-checks: true \\\[render preview\\\] \\@everyone fixes \\#1$/m);
    assert.match(fence![2], /^publisher: acme \\@everyone$/m);
    assert.match(pull.body, /Vercel builds the merge and puts it into production\. The production build's release step applies the migrations/);
    assert.match(pull.body, /\*\*MixOS floor:\*\* 0\.1\.0 or newer/);
    assert.match(pull.body, /`api\/` \(2 files\), `migrations\/\*\.sql` \(1 file\)/);

    // The record of it.
    const row = (await audited("app.propose")).at(-1)!;
    assert.equal(row.actor_email, ADMIN.email);
    assert.equal(row.target_id, "e2e-files");
    assert.equal(row.details.pullRequest, 1);
    assert.equal(row.details.url, "https://github.com/acme/mixos/pull/1");
    assert.equal(row.details.branch, "mixos/install/app-e2e-files");
    assert.equal(row.details.head, head);
    assert.equal(row.details.baseCommit, base);
    assert.equal(row.details.binaryFiles, 1);
    assert.deepEqual(row.details.leftOut, { ".gitignore": 1 });
    assert.equal(row.details.branchRule, "rule");

    // The tokens: read, then write narrowed to the repository, each revoked.
    const mints = fake.requests.slice(before).filter((r) => r.path.endsWith("/access_tokens")).map((r) => r.body);
    assert.deepEqual(mints, [
      { permissions: { metadata: "read" } },
      { repository_ids: [501], permissions: { contents: "read", checks: "read", statuses: "read", pull_requests: "read" } },
      { permissions: { metadata: "read" } },
      { repository_ids: [501], permissions: { contents: "write", pull_requests: "write" } },
    ]);
    assert.ok([...fake.tokens.values()].every((t) => t.revoked));
  });

  test("an existing branch, or a folder already on the default branch, is refused", async () => {
    const before = posts().length;
    const again = await propose("e2e-files");
    assert.equal(!again.ok && again.code, "branch-exists", JSON.stringify(again));
    fake.push(501, "main", { "apps/E2E-Board/app.json": '{"name":"Board"}\n' });
    const folder = await propose("e2e-board");
    assert.equal(!folder.ok && folder.code, "folder-exists", JSON.stringify(folder));
    fake.push(501, "main", { "apps/E2E-Board/app.json": null });
    assert.equal(posts().length - before, 0, "nothing written");
    const reasons = (await audited("app.propose.rejected")).map((r) => r.details.reason);
    assert.deepEqual(reasons.slice(-2), ["branch-exists", "folder-exists"]);
  });

  test("a pull request GitHub won't open leaves the branch, and says so", async () => {
    fake.failures.set("POST /repos/acme/mixos/pulls", 422);
    const outcome = await propose("e2e-board");
    fake.failures.clear();
    assert.equal(!outcome.ok && outcome.code, "pull-request", JSON.stringify(outcome));
    assert.match(!outcome.ok ? outcome.message : "", /Look for mixos\/install\/app-e2e-board on GitHub/);
    assert.ok(!outcome.ok && outcome.links?.[0].href === "https://github.com/acme/mixos/compare/main...mixos/install/app-e2e-board");
    const row = (await audited("app.propose.rejected")).at(-1)!;
    assert.equal(row.details.branchCreated, true);
    assert.equal(row.details.head, repo().git.branches.get("mixos/install/app-e2e-board"));
    // As an admin deleting the branch on GitHub would.
    repo().git.branches.delete("mixos/install/app-e2e-board");
  });

  test("each workflow that would run the proposal with a secret or a write token refuses it, naming the file", async () => {
    const bad: Record<string, string> = {
      "pull_request_target": "on: pull_request_target\npermissions: {}\njobs:\n  a:\n    runs-on: ubuntu-latest\n    steps:\n      - run: echo\n",
      "a secret": "on: pull_request\npermissions: { contents: read }\njobs:\n  a:\n    runs-on: ubuntu-latest\n    steps:\n      - run: deploy\n        env:\n          TOKEN: ${{ secrets.DEPLOY_TOKEN }}\n",
      "a write permission": "on: pull_request\njobs:\n  a:\n    runs-on: ubuntu-latest\n    permissions: { contents: write }\n    steps:\n      - run: echo\n",
      "no permissions": "on: pull_request\njobs:\n  a:\n    runs-on: ubuntu-latest\n    steps:\n      - run: npm ci\n",
      "a push to mixos/**": "on:\n  push:\n    branches: ['mixos/**']\npermissions: {}\njobs:\n  a:\n    runs-on: ubuntu-latest\n    steps:\n      - run: echo ${{ secrets.KEY }}\n",
    };
    const before = posts().length;
    for (const [what, text] of Object.entries(bad)) {
      fake.push(501, "main", { ".github/workflows/bad.yml": text });
      const outcome = await propose("e2e-board");
      assert.equal(outcome.ok, false, what);
      if (outcome.ok) continue;
      assert.equal(outcome.code, "workflows", what);
      assert.match(outcome.message, /\.github\/workflows\/bad\.yml/, what);
      assert.deepEqual(outcome.findings?.map((f) => f.file), [".github/workflows/bad.yml"], what);
      assert.deepEqual((await audited("app.propose.rejected")).at(-1)?.details.files, [".github/workflows/bad.yml"]);
    }
    // The mixos/ job condition, on every job: accepted.
    fake.push(501, "main", {
      ".github/workflows/bad.yml":
        "on: pull_request\njobs:\n  a:\n    if: ${{ !startsWith(github.head_ref, 'mixos/') }}\n    runs-on: ubuntu-latest\n    permissions: { contents: write }\n    steps:\n      - run: echo ${{ secrets.KEY }}\n",
    });
    const accepted = await p.checkProposal({ kind: "app", slug: "e2e-board" }, ctx);
    assert.ok(accepted.ok && accepted.ready, JSON.stringify(accepted));
    fake.push(501, "main", { ".github/workflows/bad.yml": null });
    assert.equal(posts().length - before, 0, "nothing written");
  });

  test("render.yaml with previews on, and vercel.json without them off, refuse it", async () => {
    fake.push(501, "main", { "render.yaml": ours("render.yaml").replace("generation: off", "generation: automatic") });
    const render = await propose("e2e-board");
    assert.equal(!render.ok && render.code, "render", JSON.stringify(render));
    assert.match(!render.ok ? render.message : "", /`render\.yaml` turns on pull request previews for mixos/);
    fake.push(501, "main", { "render.yaml": ours("render.yaml"), "vercel.json": '{ "buildCommand": "npm run vercel-build" }\n' });
    const vercel = await propose("e2e-board");
    assert.equal(!vercel.ok && vercel.code, "vercel", JSON.stringify(vercel));
    assert.match(!vercel.ok ? vercel.message : "", /vercel\.json doesn't turn off/);
    fake.push(501, "main", { "vercel.json": ours("vercel.json") });
  });

  test("the branch rule is read again before each proposal; without one, an admin's confirmation is needed", async () => {
    repo().rules = { main: ["deletion"] };
    const refused = await propose("e2e-board");
    assert.equal(!refused.ok && refused.code, "branch-rule", JSON.stringify(refused));
    const stored = JSON.parse((await sql`select value from public.platform_settings where key = 'github_branch_rule'`)[0].value);
    assert.equal(stored.pullRequest, false, "the fresh read is stored");
    const target = await p.proposalTarget("app");
    assert.match(target?.off ?? "", /No pull_request rule applies to main/);

    const linkCtx = { ...ctx, origin: () => "https://mixos.test" };
    const override = await p.confirmBranchProtection({ reason: "classic-protection", typedRepository: "acme/mixos" }, linkCtx);
    assert.ok(override.ok, JSON.stringify(override));
    const allowed = await propose("e2e-board");
    assert.ok(allowed.ok, JSON.stringify(allowed));
    assert.equal((await audited("app.propose")).at(-1)?.details.branchRule, "override");
    await p.withdrawBranchProtection(linkCtx);
    repo().rules = { main: ["deletion", "pull_request"] };
  });

  test("a withdrawn release needs accepting; a release needing a newer MixOS and a tampered download are refused", async () => {
    const yanked = await propose("e2e-yanked");
    assert.equal(!yanked.ok && yanked.code, "yanked");
    const accepted = await propose("e2e-yanked", { allowYanked: true });
    assert.ok(accepted.ok, JSON.stringify(accepted));
    const pull = repo().pulls.find((pr) => pr.head === "mixos/install/app-e2e-yanked")!;
    assert.match(pull.body, /Withdrawn by its publisher\./);
    assert.match(pull.body, /^withdrawn: Broken, see \\@maintainer \\#99 ``` \\@everyone$/m);
    assert.equal((await audited("app.propose")).at(-1)?.details.yankedAccepted, true);

    const future = await propose("e2e-future");
    assert.equal(!future.ok && future.code, "incompatible");
    const before = posts().length;
    const tampered = await propose("e2e-tampered");
    assert.equal(!tampered.ok && tampered.code, "checksum", JSON.stringify(tampered));
    assert.equal(posts().length - before, 0, "nothing written for a tampered download");
  });

  test("a theme goes to themes/<slug>, and its body says it runs no code", async () => {
    const outcome = await propose("e2e-paper");
    assert.ok(outcome.ok, JSON.stringify(outcome));
    const pull = repo().pulls.find((pr) => pr.head === "mixos/install/theme-e2e-paper")!;
    assert.equal(pull.title, "Add theme e2e-paper 1.2.0 from 127.0.0.1:4430 [skip preview]");
    assert.match(pull.body, /\*\*Code:\*\* none\. A theme is CSS and assets\./);
    assert.ok(Object.keys(fake.filesOn(501, "mixos/install/theme-e2e-paper")).includes("themes/e2e-paper/theme.json"));
  });

  test("a checkout doesn't propose, and nor does a kind whose installs are off", async () => {
    delete process.env.VERCEL;
    const checkout = await propose("e2e-board");
    assert.equal(!checkout.ok && checkout.code, "checkout");
    assert.equal(await p.proposalTarget("app"), null);
    process.env.VERCEL = "1";
    process.env.INSTALL_APPS = "false";
    const off = await propose("e2e-board");
    assert.equal(!off.ok && off.code, "disabled");
    delete process.env.INSTALL_APPS;
    assert.deepEqual(await p.proposalTarget("app"), { repository: "acme/mixos", off: null });
  });

  test("the Apps page: waiting, then No CI ran, checks, and changed since proposed", async () => {
    const now = new Date();
    let view = await p.readProposals(ADMIN, "app", now);
    assert.equal(view.state, "ok", JSON.stringify(view));
    if (view.state !== "ok") return;
    const files = () => view.state === "ok" ? view.pulls.find((pr) => pr.slug === "e2e-files")! : null!;
    assert.deepEqual(view.pulls.map((pr) => pr.slug).sort(), ["e2e-board", "e2e-files", "e2e-yanked"]);
    assert.equal(files().ci.state, "waiting");
    assert.equal(files().version, "1.2.0");
    assert.equal(files().changed, false);
    assert.equal(files().url, "https://github.com/acme/mixos/pull/1");

    view = await p.readProposals(ADMIN, "app", new Date(now.getTime() + 11 * 60 * 1000));
    assert.equal(files().ci.label, "No CI ran");
    assert.equal(files().ci.tone, "danger");

    fake.checks.set(head, { runs: [{ name: "verify", status: "completed", conclusion: "success" }], statuses: [] });
    view = await p.readProposals(ADMIN, "app", now);
    assert.equal(files().ci.state, "passed");
    fake.checks.set(head, { runs: [{ name: "verify", status: "completed", conclusion: "failure" }], statuses: [] });
    view = await p.readProposals(ADMIN, "app", now);
    assert.equal(files().ci.state, "failed");
    fake.checks.set(head, { runs: [{ name: "danger", status: "completed", conclusion: "skipped" }], statuses: [] });
    view = await p.readProposals(ADMIN, "app", new Date(now.getTime() + 11 * 60 * 1000));
    assert.equal(files().ci.state, "none", "only skipped runs: nothing checked it");

    fake.push(501, "mixos/install/app-e2e-files", { "apps/e2e-files/app.json": '{"name":"Changed"}\n' }, "someone-else");
    view = await p.readProposals(ADMIN, "app", now);
    assert.equal(files().changed, true);
    assert.equal(files().unrecorded, false);

    // A theme's pull request is on the Themes page, not this one.
    const themes = await p.readProposals(ADMIN, "theme", now);
    assert.deepEqual(themes.state === "ok" ? themes.pulls.map((pr) => pr.slug) : null, ["e2e-paper"]);
  });

  /* ── updates and removals of what the build runs (rank 31) ───────────── */

  /** The folder `folder` as the commit `from` holds it, put on main as a merge would leave it. */
  const graft = (from: string, folder: string): string => {
    const git = repo().git;
    const main = git.branches.get("main")!;
    const files = git.files(git.commits.get(main)!.tree);
    for (const [path, file] of git.files(git.commits.get(from)!.tree)) if (path.startsWith(`${folder}/`)) files.set(path, file);
    const sha = git.putCommit(git.build(files), [main], `Merge ${folder}`, "acme", Date.now());
    git.branches.set("main", sha);
    return sha;
  };
  /** What this build runs: the install record's values, less the hashes, as the generator writes them. */
  const installOf = (slug: string, kind: "app" | "connector" | "theme", over: Record<string, unknown> = {}) => ({
    kind,
    slug,
    version: "1.2.0",
    gitTag: "v1.2.0",
    commitSha: shaOf(slug),
    source: CATALOGUE,
    repository: { owner: "acme", name: "extensions", subpath: `${SEGMENT[kind]}/${slug}` },
    requiresMixOS: "0.1.0",
    modified: false,
    ...over,
  });
  const NAMES: Record<string, string> = { "e2e-files": "Files", "e2e-conn": "Conn", "e2e-paper": "Paper" };
  type Facts = Parameters<typeof p.proposeUpdate>[1]["build"];
  const build = (over: Partial<NonNullable<Facts>> = {}): NonNullable<Facts> => ({
    installs: [installOf("e2e-files", "app"), installOf("e2e-conn", "connector"), installOf("e2e-paper", "theme")],
    apps: [
      { slug: "e2e-files", name: "Files", connectors: ["e2e-conn"], optionalConnectors: [], consumes: [], listensTo: [] },
      { slug: "wall-e", name: "Wall-E", connectors: [], optionalConnectors: ["e2e-conn"], consumes: [], listensTo: [] },
    ],
    themes: [{ slug: "e2e-paper", name: "Paper" }],
    nameOf: (_kind, slug) => NAMES[slug] ?? null,
    ...over,
  });
  const ctxB = (over: Partial<NonNullable<Facts>> = {}) => ({ ...ctx, build: build(over), storedTheme: async () => "e2e-paper" });
  const change = async (action: "update" | "remove", kind: "app" | "connector" | "theme", slug: string, extra: Partial<NonNullable<Facts>> = {}) =>
    kept(await p.checkChangeProposal({ action, kind, slug }, ctxB(extra)));
  const update = async (kind: "app" | "connector" | "theme", slug: string, extra: Record<string, unknown> = {}) =>
    kept(await p.proposeUpdate({ kind, slug, ...extra }, ctxB()));
  const folderLine = (check: Awaited<ReturnType<typeof change>>) => (check.ok ? check.lines.find((l) => l.id === "folder")! : null!);
  const onMain = (folder: string) => Object.keys(fake.filesOn(501, "main")).filter((f) => f.startsWith(`${folder}/`)).sort();

  test("an update: the folder on main has to be what the build runs, and the releases are listed", async () => {
    // As if the operator had merged the proposals: each folder on main, byte for byte.
    const conn = await propose("e2e-conn");
    assert.ok(conn.ok, JSON.stringify(conn));
    graft(repo().git.branches.get("mixos/install/connector-e2e-conn")!, "connectors/e2e-conn");
    graft(head, "apps/e2e-files");
    graft(repo().git.branches.get("mixos/install/theme-e2e-paper")!, "themes/e2e-paper");
    assert.equal(onMain("apps/e2e-files").length, 7);

    const before = posts().length;
    const check = await change("update", "app", "e2e-files");
    assert.ok(check.ok, JSON.stringify(check));
    if (!check.ok) return;
    assert.equal(check.ready, true, JSON.stringify(check.lines));
    assert.deepEqual(check.lines.map((l) => l.id), ["rule", "checklist", "workflows", "render", "vercel", "folder", "branch"]);
    assert.match(folderLine(check).detail, /^apps\/e2e-files on main holds 1\.2\.0 at [0-9a-f]{12}, which this build runs\./);
    assert.deepEqual(check.names, { branch: "mixos/update/app-e2e-files", title: null });
    assert.deepEqual(check.releases.map((r) => [r.version, r.direction, r.current, r.yanked]), [
      ["1.3.0", "newer", true, false],
      ["1.2.1", "newer", false, true],
      ["1.2.0", "same", false, false],
      ["1.1.0", "older", false, false],
    ]);
    assert.equal(check.suggested, "1.3.0");
    assert.equal(check.installed.version, "1.2.0");
    assert.equal(check.installed.yanked, false);
    assert.deepEqual(check.onBranch, { files: 7 });
    assert.equal(check.removal, null);
    assert.equal(posts().length - before, 0, "the check writes nothing");
    assert.equal(fake.requests.some((r) => r.path.includes("codeload")), false, "and downloads nothing");

    // Not in the build, or from another catalogue: said as information.
    const stranger = await change("update", "app", "e2e-board");
    assert.equal(!stranger.ok && stranger.code, "not-installed");
    const elsewhere = await change("update", "app", "e2e-files", { installs: [installOf("e2e-files", "app", { source: "https://mixos.org" })] });
    assert.equal(!elsewhere.ok && elsewhere.code, "not-updatable");
    assert.match(!elsewhere.ok ? elsewhere.message : "", /installed from mixos\.org, and this instance installs from 127\.0\.0\.1:4430/);
  });

  test("the comparison: both releases verified in memory, the folder proven, and what the tree would change", async () => {
    const c = kept(await p.compareUpdateProposal({ kind: "app", slug: "e2e-files", version: "1.3.0" }, ctxB()));
    assert.ok(c.ok, JSON.stringify(c));
    if (!c.ok) return;
    assert.equal(c.direction, "newer");
    assert.deepEqual(c.files, {
      changed: ["api/items/route.ts", "app.json"],
      added: ["assets/logo.png", "migrations/002_index.sql"],
      removed: ["README.md", "api/[id]/route.ts"],
      more: { changed: 0, added: 0, removed: 0 },
      incomplete: false,
    });
    assert.deepEqual(c.migrations, { added: ["002_index.sql"], changed: [], lacking: [] });
    assert.deepEqual(c.declarations?.find((d) => d.label === "Egress"), { label: "Egress", added: ["api.example.com"], removed: [] });
    assert.deepEqual(c.needs, { discardLocalChanges: false, allowOlder: false, allowYanked: false });
    assert.equal(c.blocker, null);
    assert.equal(c.floor.met, true);
    assert.equal(c.claims.state, "ok");
    assert.deepEqual(c.names, { branch: "mixos/update/app-e2e-files", title: "Update app e2e-files to 1.3.0 from 127.0.0.1:4430 [skip preview]" });
    assert.equal(c.compareUrl, `https://github.com/acme/extensions/compare/${shaOf("e2e-files")}...${shaOf("e2e-files", "1.3.0")}`);
    assert.equal(c.from.version, "1.2.0");
    assert.equal(c.to.version, "1.3.0");

    const same = await p.compareUpdateProposal({ kind: "app", slug: "e2e-files", version: "1.2.0" }, ctxB());
    assert.match(same.ok ? (same.blocker ?? "") : "", /apps\/e2e-files on main already holds 1\.2\.0/);
    const withdrawn = await p.compareUpdateProposal({ kind: "app", slug: "e2e-files", version: "1.2.1" }, ctxB());
    assert.ok(withdrawn.ok && withdrawn.to.yanked && withdrawn.needs.allowYanked, JSON.stringify(withdrawn));
    const older = await p.compareUpdateProposal({ kind: "app", slug: "e2e-files", version: "1.1.0" }, ctxB());
    assert.ok(older.ok && older.direction === "older" && older.needs.allowOlder, JSON.stringify(older));
    assert.equal(posts().filter((r) => r.path.startsWith("/repos/")).length, posts().length, "the comparison writes nothing");
  });

  test("a folder on main that isn't what the build runs is refused, naming the difference", async () => {
    const was = fake.filesOn(501, "main");
    const before = posts().length;

    // A file edited on GitHub: the record matches, the files don't.
    fake.push(501, "main", { "apps/e2e-files/README.md": "# Edited on GitHub\n" });
    const edited = await p.compareUpdateProposal({ kind: "app", slug: "e2e-files", version: "1.3.0" }, ctxB());
    assert.equal(!edited.ok && edited.code, "folder-mismatch", JSON.stringify(edited));
    assert.match(!edited.ok ? edited.message : "", /isn't release 1\.2\.0 as its record says: 1 changed \(`README\.md`\)/);
    const proposed = await update("app", "e2e-files", { version: "1.3.0" });
    assert.equal(!proposed.ok && proposed.code, "folder-mismatch", JSON.stringify(proposed));
    const row = (await audited("app.propose.rejected")).at(-1)!;
    assert.equal(row.details.reason, "folder-mismatch");
    assert.equal(row.details.action, "update");
    fake.push(501, "main", { "apps/e2e-files/README.md": was["apps/e2e-files/README.md"] });

    // A record on main that names another release than the build runs.
    const record = was["apps/e2e-files/.registry.json"];
    fake.push(501, "main", { "apps/e2e-files/.registry.json": record.replace('"version": "1.2.0"', '"version": "1.9.0"') });
    const other = await change("update", "app", "e2e-files");
    assert.ok(other.ok && !other.ready, JSON.stringify(other));
    assert.equal(folderLine(other).ok, false);
    assert.equal(folderLine(other).code, "folder-mismatch");
    assert.match(folderLine(other).detail, /records version 1\.9\.0, and this build runs 1\.2\.0/);
    const refusedToo = await update("app", "e2e-files", { version: "1.3.0" });
    assert.equal(!refusedToo.ok && refusedToo.code, "folder-mismatch");
    fake.push(501, "main", { "apps/e2e-files/.registry.json": record });

    // A build whose own copy is modified, and a folder that isn't on main at all.
    const modified = await change("update", "app", "e2e-files", { installs: [installOf("e2e-files", "app", { modified: true })] });
    assert.equal(modified.ok && folderLine(modified).code, "folder-modified");
    const missing = await change("update", "app", "e2e-yanked", { installs: [installOf("e2e-yanked", "app")] });
    assert.equal(missing.ok && folderLine(missing).code, "folder-missing");
    assert.match(missing.ok ? folderLine(missing).detail : "", /apps\/e2e-yanked isn't on main, so there is nothing to update there/);
    const gone = await p.proposeRemoval({ kind: "app", slug: "e2e-yanked" }, ctxB({ installs: [installOf("e2e-yanked", "app")] }));
    assert.equal(!gone.ok && gone.code, "folder-missing");
    assert.equal(posts().length - before, 0, "nothing written for any of them");
  });

  test("the same release is nothing to update; an older or a withdrawn one has to be chosen as such", async () => {
    const before = posts().length;
    const same = await update("app", "e2e-files", { version: "1.2.0" });
    assert.equal(!same.ok && same.code, "same-release", JSON.stringify(same));
    const older = await update("app", "e2e-files", { version: "1.1.0" });
    assert.equal(!older.ok && older.code, "older-release", JSON.stringify(older));
    assert.match(!older.ok ? older.message : "", /1\.1\.0 is older than 1\.2\.0, which apps\/e2e-files holds\. Choose "Propose an older release"/);
    const yanked = await update("app", "e2e-files", { version: "1.2.1" });
    assert.equal(!yanked.ok && yanked.code, "yanked", JSON.stringify(yanked));
    assert.equal(posts().length - before, 0, "nothing written");
    const reasons = (await audited("app.propose.rejected")).slice(-3).map((r) => [r.details.reason, r.details.action, r.details.version]);
    assert.deepEqual(reasons, [["same-release", "update", "1.2.0"], ["older-release", "update", "1.1.0"], ["yanked", "update", "1.2.1"]]);
  });

  let updateHead = "";
  test("an update proposed: the tree replaces the folder, deletions included; the title, the body and the audit row", async () => {
    const base = repo().git.branches.get("main")!;
    const before = fake.requests.length;
    const outcome = await update("app", "e2e-files", { version: "1.3.0" });
    assert.ok(outcome.ok, JSON.stringify(outcome));
    if (!outcome.ok) return;
    assert.equal(outcome.pullRequest.branch, "mixos/update/app-e2e-files");
    assert.match(outcome.message, /apps\/e2e-files from 1\.2\.0 to 1\.3\.0.*reverting the merge is the way back/);
    updateHead = outcome.pullRequest.head;

    const writes = fake.requests.slice(before).filter((r) => r.method !== "GET" && r.path.startsWith("/repos/"));
    assert.deepEqual(
      writes.map((w) => `${w.method} ${w.path}`),
      [
        "POST /repos/acme/mixos/git/blobs",
        "POST /repos/acme/mixos/git/blobs",
        "POST /repos/acme/mixos/git/trees",
        "POST /repos/acme/mixos/git/commits",
        "POST /repos/acme/mixos/git/refs",
        "POST /repos/acme/mixos/pulls",
      ],
    );
    const tree = writes[2].body as { base_tree: string; tree: { path: string; mode: string; type: string; content?: string; sha?: string | null }[] };
    assert.equal(tree.base_tree, repo().git.commits.get(base)!.tree);
    assert.ok(tree.tree.every((e) => e.mode === "100644" && e.type === "blob" && e.path.startsWith("apps/e2e-files/")));
    assert.deepEqual(tree.tree.filter((e) => e.sha === null).map((e) => e.path), ["apps/e2e-files/README.md", "apps/e2e-files/api/[id]/route.ts"]);
    assert.deepEqual(tree.tree.filter((e) => e.sha && e.sha !== null).map((e) => e.path).sort(), ["apps/e2e-files/assets/icon.png", "apps/e2e-files/assets/logo.png"]);

    // The branch: main with the folder replaced, nothing else touched.
    const git = repo().git;
    const commit = git.commits.get(updateHead)!;
    assert.deepEqual(commit.parents, [base]);
    const onBranch = git.files(commit.tree);
    const mainFiles = git.files(git.commits.get(base)!.tree);
    for (const [file, entry] of mainFiles) if (!file.startsWith("apps/e2e-files/")) assert.deepEqual(onBranch.get(file), entry, file);
    assert.deepEqual([...onBranch.keys()].filter((f) => f.startsWith("apps/e2e-files/")).sort(), [
      "apps/e2e-files/.registry.json",
      "apps/e2e-files/api/items/route.ts",
      "apps/e2e-files/app.json",
      "apps/e2e-files/assets/icon.png",
      "apps/e2e-files/assets/logo.png",
      "apps/e2e-files/migrations/001_init.sql",
      "apps/e2e-files/migrations/002_index.sql",
    ]);
    const release = FIXTURES["e2e-files"].more!.find((r) => r.version === "1.3.0")!;
    for (const entry of release.entries.filter((e) => e.path !== ".gitignore")) {
      assert.equal(onBranch.get(`apps/e2e-files/${entry.path}`)?.sha, p.gitBlobSha(entry.data), entry.path);
    }
    const record = JSON.parse(git.blobs.get(onBranch.get("apps/e2e-files/.registry.json")!.sha)!.toString("utf8"));
    assert.equal(record.version, "1.3.0");
    assert.equal(record.commitSha, shaOf("e2e-files", "1.3.0"));
    assert.equal(git.branches.get("main"), base, "the default branch didn't move");

    // The names and the body.
    const pull = repo().pulls.find((pr) => pr.head === "mixos/update/app-e2e-files")!;
    assert.equal(pull.title, "Update app e2e-files to 1.3.0 from 127.0.0.1:4430 [skip preview]");
    assert.equal(pull.base, "main");
    assert.match(commit.message, /^feat\(e2e-files\): update app e2e-files from 1\.2\.0 to 1\.3\.0\n/);
    assert.match(commit.message, /verified by an instance and proposed\s+through the GitHub App/);
    assert.match(commit.message, /^Registry-Replaces-Version: 1\.2\.0$/m);
    for (const text of [commit.message, pull.title]) assert.ok(!/skip ci|skip-checks|render preview|@everyone|Files \[/i.test(text), text);
    assert.match(pull.body, /### What changes\n\n- \*\*Files in `apps\/e2e-files\/`:\*\* 2 changed, 2 added, 2 deleted\./);
    assert.match(pull.body, /\*\*Manifest:\*\* changes to Egress \(1 added, 0 dropped\)/);
    assert.match(pull.body, /\*\*Migrations:\*\* 1 new migration in `1\.3\.0`\. The release step applies them, and they are forward-only: back up the database before you merge\./);
    assert.match(pull.body, /\*\*The folder it replaces\*\* was checked first/);
    assert.match(pull.body, /### Rolling back\n\nRevert the merge and deploy again/);
    const fence = /(`{3,})text\n([\s\S]*?)\n\1/.exec(pull.body)!;
    assert.ok(fence, pull.body);
    assert.ok(!/@|#\d|skip ci|render preview|api\.example\.com/i.test(pull.body.replace(fence[0], "")));
    assert.match(fence[2], /^egress adds: api\.example\.com$/m);
    assert.match(fence[2], /^permission: network:api\.example\.com - Reads items \\@everyone$/m);

    const row = (await audited("app.propose")).at(-1)!;
    assert.equal(row.details.action, "update");
    assert.equal(row.details.pullRequest, pull.number);
    assert.equal(row.details.branch, "mixos/update/app-e2e-files");
    assert.equal(row.details.head, updateHead);
    assert.equal(row.details.version, "1.3.0");
    assert.deepEqual(row.details.from, { version: "1.2.0", gitTag: "v1.2.0", commitSha: shaOf("e2e-files"), filesHash: record.filesHash === undefined ? null : (await audited("app.propose"))[0].details.filesHash });
    assert.equal(row.details.direction, "newer");
    assert.equal(row.details.deleted, 2);
    assert.equal(row.details.binaryFiles, 2);
    assert.equal(row.details.olderAccepted, false);

    const again = await update("app", "e2e-files", { version: "1.3.0" });
    assert.equal(!again.ok && again.code, "branch-exists");
  });

  test("an older release chosen, and a withdrawn one accepted, each said in the body and the audit row", async () => {
    const older = await kept(p.proposeUpdate({ kind: "theme", slug: "e2e-paper", version: "1.1.0", allowOlder: true }, ctxB()));
    assert.ok(older.ok, JSON.stringify(older));
    const paper = repo().pulls.find((pr) => pr.head === "mixos/update/theme-e2e-paper")!;
    assert.equal(paper.title, "Update theme e2e-paper to 1.1.0 from 127.0.0.1:4430 [skip preview]");
    assert.match(paper.body, /\*\*An older release\.\*\* An admin chose to go back from `1\.2\.0` to `1\.1\.0`\./);
    assert.match(paper.body, /\*\*Code:\*\* none\. A theme is CSS and assets\./);
    assert.match(repo().git.commits.get(older.ok ? older.pullRequest.head : "")!.message, /It replaces 1\.2\.0, a newer release\./);
    const olderRow = (await audited("theme.propose")).at(-1)!;
    assert.equal(olderRow.details.action, "update");
    assert.equal(olderRow.details.direction, "older");
    assert.equal(olderRow.details.olderAccepted, true);

    const refused = await kept(p.proposeUpdate({ kind: "connector", slug: "e2e-conn", version: "1.2.1" }, ctxB()));
    assert.equal(!refused.ok && refused.code, "yanked");
    const accepted = await kept(p.proposeUpdate({ kind: "connector", slug: "e2e-conn", version: "1.2.1", allowYanked: true }, ctxB()));
    assert.ok(accepted.ok, JSON.stringify(accepted));
    const conn = repo().pulls.find((pr) => pr.head === "mixos/update/connector-e2e-conn")!;
    assert.match(conn.body, /\*\*Withdrawn by its publisher\.\*\* An admin proposed it anyway\./);
    assert.match(conn.body, /^withdrawn: Leaks keys$/m);
    assert.match(conn.body, /\*\*Then:\*\* its credentials, and its users' connections, belong to its name in each database/);
    assert.equal((await audited("connector.propose")).at(-1)?.details.yankedAccepted, true);
  });

  test("a removal: refused for a required connector and the last theme; otherwise the tree deletes the folder", async () => {
    const before = posts().length;
    const conn = await kept(p.proposeRemoval({ kind: "connector", slug: "e2e-conn" }, ctxB()));
    assert.equal(!conn.ok && conn.code, "depended-on", JSON.stringify(conn));
    assert.match(!conn.ok ? conn.message : "", /^Not proposed\. Required by Files \(apps\/e2e-files\), which can't work without it\./);
    assert.deepEqual((await audited("connector.propose.rejected")).at(-1)?.details.blockers, ["required-by"]);
    const connCheck = await change("remove", "connector", "e2e-conn");
    assert.ok(connCheck.ok && !connCheck.ready && connCheck.removal?.blockers[0].code === "required-by", JSON.stringify(connCheck));
    assert.deepEqual(connCheck.ok ? connCheck.names : null, { branch: "mixos/remove/connector-e2e-conn", title: "Remove connector e2e-conn [skip preview]" });

    const last = await kept(p.proposeRemoval({ kind: "theme", slug: "e2e-paper" }, ctxB()));
    assert.equal(!last.ok && last.code, "last-theme", JSON.stringify(last));
    assert.match(!last.ok ? last.message : "", /only theme in the build, and the build needs one/);
    assert.equal(posts().length - before, 0, "nothing written");

    // With another theme in the build: allowed, warning that it is the applied one.
    const two = { themes: [{ slug: "e2e-paper", name: "Paper" }, { slug: "mixos", name: "MixOS" }] };
    const check = await change("remove", "theme", "e2e-paper", two);
    assert.ok(check.ok && check.ready, JSON.stringify(check));
    assert.deepEqual(check.ok ? check.removal?.warnings.map((w) => w.code) : null, ["applied-theme"]);
    assert.match(check.ok ? (check.removal?.warnings[0].message ?? "") : "", /applied theme in this instance's database, so pages here use MixOS/);
    assert.deepEqual(check.ok ? check.onBranch : null, { files: 3 });

    const base = repo().git.branches.get("main")!;
    const start = fake.requests.length;
    const outcome = await kept(p.proposeRemoval({ kind: "theme", slug: "e2e-paper" }, ctxB(two)));
    assert.ok(outcome.ok, JSON.stringify(outcome));
    if (!outcome.ok) return;
    const writes = fake.requests.slice(start).filter((r) => r.method !== "GET" && r.path.startsWith("/repos/"));
    assert.deepEqual(
      writes.map((w) => `${w.method} ${w.path}`),
      ["POST /repos/acme/mixos/git/trees", "POST /repos/acme/mixos/git/commits", "POST /repos/acme/mixos/git/refs", "POST /repos/acme/mixos/pulls"],
    );
    const tree = writes[0].body as { tree: { path: string; sha: string | null }[] };
    assert.deepEqual(tree.tree.map((e) => [e.path, e.sha]), [
      ["themes/e2e-paper/.registry.json", null],
      ["themes/e2e-paper/theme.css", null],
      ["themes/e2e-paper/theme.json", null],
    ]);
    const git = repo().git;
    const commit = git.commits.get(outcome.pullRequest.head)!;
    assert.deepEqual(commit.parents, [base]);
    const onBranch = git.files(commit.tree);
    assert.ok(![...onBranch.keys()].some((f) => f.startsWith("themes/e2e-paper/")), "the folder is gone");
    for (const [file, entry] of git.files(git.commits.get(base)!.tree)) {
      if (!file.startsWith("themes/e2e-paper/")) assert.deepEqual(onBranch.get(file), entry, file);
    }
    assert.equal(git.branches.get("main"), base);
    const pull = repo().pulls.find((pr) => pr.head === "mixos/remove/theme-e2e-paper")!;
    assert.equal(pull.title, "Remove theme e2e-paper [skip preview]");
    assert.match(commit.message, /^feat\(e2e-paper\): remove theme e2e-paper 1\.2\.0 from 127\.0\.0\.1:4430\n/);
    assert.match(commit.message, /Removal proposed through the GitHub App\. A theme holds no data\./);
    assert.match(pull.body, /### What goes\n\n- \*\*The folder:\*\* `themes\/e2e-paper\/`, 3 files, `\.registry\.json` included\./);
    assert.match(pull.body, /\*\*The applied theme\.\*\*/);
    assert.match(pull.body, /- A theme holds no data\./);
    assert.match(pull.body, /### Rolling back\n\nRevert the merge and deploy again/);
    assert.match(pull.body, /^name: Paper$/m);
    const row = (await audited("theme.propose")).at(-1)!;
    assert.equal(row.details.action, "remove");
    assert.equal(row.details.version, "1.2.0");
    assert.equal(row.details.deleted, 3);
    assert.deepEqual(row.details.warnings, ["applied-theme"]);

    // An app's removal says its data stays.
    const app = await kept(p.proposeRemoval({ kind: "app", slug: "e2e-files" }, ctxB(two)));
    assert.ok(app.ok, JSON.stringify(app));
    const files = repo().pulls.find((pr) => pr.head === "mixos/remove/app-e2e-files")!;
    assert.match(files.body, /Each instance keeps the app's data until an admin deletes it there\. After the merge deploys, Admin > Apps lists it under Not in this build, with Delete data\./);
    assert.match(app.ok ? app.message : "", /each instance keeps its data until an admin deletes it there/);
  });

  test("the lists show installs, updates and removals, each as such, with their checks", async () => {
    const now = new Date();
    const apps = await p.readProposals(ADMIN, "app", now);
    assert.equal(apps.state, "ok", JSON.stringify(apps));
    if (apps.state !== "ok") return;
    const files = apps.pulls.filter((pr) => pr.slug === "e2e-files").sort((a, b) => a.action.localeCompare(b.action));
    assert.deepEqual(files.map((pr) => [pr.action, pr.branch, pr.version, pr.unrecorded, pr.changed]), [
      ["install", "mixos/install/app-e2e-files", "1.2.0", false, true],
      ["remove", "mixos/remove/app-e2e-files", "1.2.0", false, false],
      ["update", "mixos/update/app-e2e-files", "1.3.0", false, false],
    ]);
    assert.ok(files.every((pr) => pr.ci.state === "waiting"));
    const themes = await p.readProposals(ADMIN, "theme", now);
    assert.deepEqual(
      themes.state === "ok" ? themes.pulls.map((pr) => [pr.action, pr.version]).sort() : null,
      [["install", "1.2.0"], ["remove", "1.2.0"], ["update", "1.1.0"]],
    );
    const connectors = await p.readProposals(ADMIN, "connector", now);
    assert.deepEqual(connectors.state === "ok" ? connectors.pulls.map((pr) => [pr.action, pr.version]).sort() : null, [["install", "1.2.0"], ["update", "1.2.1"]]);
  });

  test("over the whole run: no write outside refs/heads/mixos/ or the folder, no merge, and no secret anywhere", async () => {
    const writes = fake.requests.filter((r) => r.host === "api" && r.method !== "GET");
    for (const w of writes) {
      const pathOnly = w.path.split("?")[0];
      if (!pathOnly.startsWith("/repos/")) {
        assert.match(`${w.method} ${pathOnly}`, /^(POST \/app\/installations\/\d+\/access_tokens|DELETE \/installation\/token)$/);
        continue;
      }
      assert.match(pathOnly, /^\/repos\/acme\/mixos\/(git\/(blobs|trees|commits|refs)|pulls)$/, pathOnly);
      assert.equal(w.method, "POST");
      const body = w.body as Record<string, unknown>;
      if (pathOnly.endsWith("/git/refs")) assert.match(String(body.ref), /^refs\/heads\/mixos\//);
      if (pathOnly.endsWith("/git/trees")) {
        const entries = body.tree as { path: string; sha?: string | null }[];
        const folder = entries[0].path.split("/").slice(0, 2).join("/");
        assert.ok(entries.every((e) => e.path.startsWith(`${folder}/`)), "one folder per tree, deletions included");
        assert.ok(entries.filter((e) => e.sha === null).every((e) => e.path.startsWith(`${folder}/`)), "no deletion outside it");
      }
      if (pathOnly.endsWith("/pulls")) assert.equal(body.base, "main");
    }
    assert.ok(!fake.requests.some((r) => /merge/.test(r.path) || r.method === "PUT" || r.method === "PATCH"));
    assert.ok([...fake.tokens.values()].every((t) => t.revoked), "every token revoked");

    // Every github_ row but the key itself, which is the private key, encrypted.
    const settings = (await sql`select key, value from public.platform_settings where key like 'github\\_%' and key <> 'github_app_key'`).map(
      (r) => r.value as string,
    );
    assert.ok(settings.length >= 4, "the app, the link, the rule and the checklist");
    const auditRows = (await sql`select details from public.admin_audit_log`).map((r) => JSON.stringify(r.details));
    const places = [...logs, ...answers.map((a) => JSON.stringify(a)), ...auditRows, ...settings];
    const bodies = repo().pulls.map((pr) => `${pr.title}\n${pr.body}`);
    for (const secret of fake.secrets) {
      for (const place of [...places, ...bodies]) assert.ok(!place.includes(secret), "a secret leaked");
    }
  });
});
