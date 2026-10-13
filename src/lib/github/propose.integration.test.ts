/* This Source Code Form is subject to the terms of the Mozilla Public
 * License, v. 2.0. If a copy of the MPL was not distributed with this
 * file, You can obtain one at https://mozilla.org/MPL/2.0/. */

/**
 * Proposing an install as a pull request, end to end, against a real Postgres
 * and the fake GitHub (./fake-github.ts) standing in for `fetch`, with a
 * catalogue and GitHub's archive host stood in beside it: the tree, the refs,
 * the title, the body and the audit row of a proposal; each refusal the
 * repository's files cause; the branch rule and the preview checklist; an
 * existing folder or branch; "No CI ran" and "changed since proposed"; and,
 * over every request the run made, that no write ever left refs/heads/mixos/
 * or the extension's folder, and nothing merged.
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

interface Fixture {
  kind: "app" | "connector" | "theme";
  entries: TarEntry[];
  manifest?: Record<string, unknown>;
  /** The archive served doesn't match the hash. */
  tampered?: boolean;
}

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
  },
};

const SEGMENT = { app: "apps", connector: "connectors", theme: "themes" } as const;

async function loadModules() {
  return {
    ...(await import("./propose")),
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

    // The catalogue and the archives.
    for (const [slug, f] of Object.entries(FIXTURES)) {
      const sha = crypto.createHash("sha1").update(`lc30-${slug}`).digest("hex");
      const archivePath = `/acme/extensions/tar.gz/${sha}`;
      const served = f.tampered ? [...f.entries, ...files({ "extra.ts": "export const x = 1;\n" })] : f.entries;
      archives.set(archivePath, tarball(`acme-extensions-${sha.slice(0, 7)}`, served.map((e) => ({ ...e, path: `${SEGMENT[f.kind]}/${slug}/${e.path}` }))));
      const install = {
        kind: f.kind,
        slug,
        name: slug,
        version: "1.2.0",
        commitSha: sha,
        gitTag: "v1.2.0",
        tarballUrl: `https://codeload.github.com${archivePath}`,
        contentHash: p.hashFileTree(f.entries),
        subpath: `${SEGMENT[f.kind]}/${slug}`,
        permissions: [],
        requiresMixOS: "0.1.0",
        yanked: false,
        ...f.manifest,
      };
      catalogue.set(`/api/v1/${SEGMENT[f.kind]}/${slug}/install`, install);
      catalogue.set(`/api/v1/${SEGMENT[f.kind]}/${slug}`, {
        slug,
        kind: f.kind,
        name: install.name,
        tagline: "",
        author: { handle: "acme @everyone", verified: false },
        sourceRepo: { host: "github", owner: "acme", name: "extensions", url: "https://github.com/acme/extensions", subpath: install.subpath },
        releases: [],
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
        const body = catalogue.get(url.pathname);
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
        const entries = body.tree as { path: string }[];
        const folder = entries[0].path.split("/").slice(0, 2).join("/");
        assert.ok(entries.every((e) => e.path.startsWith(`${folder}/`)), "one folder per tree");
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
