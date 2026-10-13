/* This Source Code Form is subject to the terms of the Mozilla Public
 * License, v. 2.0. If a copy of the MPL was not distributed with this
 * file, You can obtain one at https://mozilla.org/MPL/2.0/. */

/**
 * A MixOS update as a pull request, end to end, against a real Postgres and
 * the fake GitHub (./fake-github.ts) standing in for `fetch`, with a fork
 * network: upstream `mixoshq/mixos` with a tagged release on its main, and
 * the operator's fork `acme/mixos` behind it, with a commit of its own.
 *
 *   - what the notice offers, from what is stored: nothing until the App is
 *     linked, the merge by hand for a private copy, the button for a fork,
 *     and the pull request once one was opened from here;
 *   - a fork with a verified tag: the branch at the release's commit, the
 *     pull request with the notes as text and GitHub's numbers, the audit
 *     row, and the tokens used;
 *   - a tag that points elsewhere, a commit off upstream's main, GitHub unable
 *     to confirm (upstream private), a release that changes a workflow, a
 *     release the default branch already has: refused, audited, and the
 *     compare link given;
 *   - the branch rule and the preview checklist, as for an install;
 *   - an existing update branch: the open pull request's link, or the branch's;
 *   - Admin > GitHub's list: waiting, "No CI ran", checks, changed since;
 *   - over every request: no write but the one ref and the one pull request,
 *     no merge, and no secret anywhere.
 *
 * Skipped unless MIXOS_TEST_DATABASE_URL names a server this may create and
 * drop a database on:
 *
 *   docker run -d --name gh -e POSTGRES_PASSWORD=pw -p 127.0.0.1:55432:5432 postgres:17
 *   MIXOS_TEST_DATABASE_URL=postgres://postgres:pw@127.0.0.1:55432/postgres \
 *     npx tsx --test src/lib/github/update-pull.integration.test.ts
 */

import { after, before, describe, test } from "node:test";
import assert from "node:assert/strict";
import crypto from "node:crypto";
import fs from "node:fs";
import path from "node:path";
import postgres, { type Sql } from "postgres";
import { migratePlatform } from "../../../scripts/platform-migrations";
import { FakeGitHub } from "./fake-github";

const REPO = path.resolve(__dirname, "../../..");
const serverUrl = process.env.MIXOS_TEST_DATABASE_URL;
const skip = serverUrl ? false : "set MIXOS_TEST_DATABASE_URL to run against a real Postgres";

const run = crypto.randomBytes(3).toString("hex");
const database = `mixos_update_${run}`;
const UPSTREAM_ID = 1345491436;

/** The notes as mixos.org could publish them: every marker, a mention, a link. */
const NOTES = [
  "### Fixes",
  "",
  "- fix(os): [apply the security patch](https://evil.example/patch) (#12)",
  "- feat: cc @everyone, closes #3 [skip ci]",
  "",
  "<script>alert(1)</script>",
].join("\n");

async function loadModules() {
  return {
    ...(await import("./update-pull")),
    ...(await import("./proposals")),
    ...(await import("./link")),
    ...(await import("./store")),
    ...(await import("./jwt")),
    ...(await import("../platform/release-check")),
    ...(await import("../platform/releases")),
    ...(await import("../platform/version")),
    platformSql: (await import("@/lib/db/client")).sql,
  };
}

describe("a MixOS update as a pull request", { skip }, () => {
  let admin: Sql;
  let sql: Sql;
  let p: Awaited<ReturnType<typeof loadModules>>;
  let fake: FakeGitHub;
  let ADMIN: { id: string; email: string };
  const realFetch = globalThis.fetch;
  const logs: string[] = [];
  const answers: unknown[] = [];
  const saved = { log: console.log, warn: console.warn, error: console.error, info: console.info };
  const env = { ...process.env };

  /** Upstream's commits: A is where the fork started, C is the release. */
  const commits = { A: "", B: "", C: "", side: "" };
  let VERSION = "";
  let TAG = "";

  const ctx = { admin: async () => ADMIN };
  const kept = <T>(outcome: T): T => {
    answers.push(outcome);
    return outcome;
  };
  const audited = async (action: string) =>
    (await sql`select actor_email, target_type, target_id, details, created_at from public.admin_audit_log where action = ${action} order by created_at`).map(
      (r) => ({ ...r }) as { actor_email: string; target_type: string; target_id: string; details: Record<string, unknown>; created_at: Date },
    );
  const upstream = () => fake.repositories.get(UPSTREAM_ID)!;
  const fork = () => fake.repositories.get(501)!;
  /** Writes to the repository: token mints and revocations aren't. */
  const posts = () => fake.requests.filter((r) => r.host === "api" && r.method !== "GET" && r.path.startsWith("/repos/"));
  const propose = async (tag = TAG) => kept(await p.proposeMixOSUpdate({ tag }, ctx));
  const notice = () => {
    const n = p.describeRelease(release(), "stable", p.mixosVersion());
    assert.ok(n, "the release is newer than this build");
    return n;
  };
  const offer = () => p.mixosUpdateOffer(notice());
  const ours = (file: string) => fs.readFileSync(path.join(REPO, file), "utf8");

  /** The release on record, as the release check would have stored it. */
  const release = (over: Partial<{ tag: string; commitSha: string; notes: string }> = {}) => ({
    tag: TAG,
    commitSha: commits.C,
    publishedAt: "2026-10-20T09:00:00Z",
    prerelease: false,
    notes: NOTES,
    ...over,
  });
  async function storeRelease(over: Partial<{ tag: string; commitSha: string; notes: string }> = {}) {
    const state = {
      channel: "stable",
      latest: release(over),
      lastSuccessAt: new Date().toISOString(),
      lastAttemptAt: new Date().toISOString(),
      lastError: null,
      nextCheckAt: new Date(Date.now() + 21 * 3600_000).toISOString(),
    };
    await sql`
      insert into public.platform_settings (key, value, updated_at) values ('mixos_release_check', ${JSON.stringify(state)}, now())
      on conflict (key) do update set value = excluded.value, updated_at = excluded.updated_at`;
  }

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
    process.env.MIXOS_REPOSITORY_URL = "https://mixos.org";
    // A built deployment, on Vercel: the only place the notice offers.
    process.env.VERCEL = "1";
    delete process.env.MIXOS_UPDATE_CHECK;
    delete process.env.MIXOS_RELEASE_CHANNEL;
    p = await loadModules();
    VERSION = p.mixosVersion();
    const [major, minor, patch] = VERSION.split(/[.-]/).map(Number);
    TAG = `v${major}.${minor + 1}.${patch}`;

    const [a] = await sql`
      insert into public.users (email, display_name, is_admin) values (${`admin-${run}@mixos.test`}, 'Admin', true)
      returning id, email`;
    ADMIN = { id: a.id, email: a.email };

    // GitHub: upstream at A, the fork made of it, then upstream releases C
    // and the fork adds a commit of its own, B.
    fake = new FakeGitHub();
    commits.A = fake.push(UPSTREAM_ID, "main", {
      ".github/workflows/ci.yml": ours(".github/workflows/ci.yml"),
      ".github/workflows/danger.yml": ours(".github/workflows/danger.yml"),
      "render.yaml": ours("render.yaml"),
      "vercel.json": ours("vercel.json"),
      "package.json": JSON.stringify({ version: VERSION }),
      "src/lib/platform/version.ts": "export const v = 1;\n",
    });
    fake.repositories.delete(501);
    fake.fork(UPSTREAM_ID, { id: 501, owner: "acme", name: "mixos", private: true, rules: { main: ["deletion", "pull_request"] } });
    commits.C = fake.push(UPSTREAM_ID, "main", {
      "package.json": JSON.stringify({ version: TAG.slice(1) }),
      "src/lib/platform/version.ts": "export const v = 2;\n",
      "supabase/migrations/20261020_release.sql": "select 1;\n",
    }, "mixoshq");
    fake.tag(UPSTREAM_ID, TAG, commits.C);
    // A commit on a side branch of upstream, tagged as nothing is on main.
    fake.branch(UPSTREAM_ID, "topic", commits.A);
    commits.side = fake.push(UPSTREAM_ID, "topic", { "README.md": "# not a release\n" }, "mixoshq");
    commits.B = fake.push(501, "main", { "apps/wall-e/app.json": '{"name":"Wall-E"}\n' }, "acme");
    // Upstream public, so the cross-fork compares answer; private again for the 404 case.
    upstream().private = false;

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
    await storeRelease();

    globalThis.fetch = (async (input: RequestInfo | URL, init?: RequestInit) => {
      const url = new URL(typeof input === "string" ? input : input instanceof URL ? input.href : input.url);
      if (url.origin === "https://mixos.org") throw new TypeError("nothing here fetches mixos.org");
      return fake.fetch(input, init);
    }) as typeof fetch;
    void installation;
  });

  after(async () => {
    globalThis.fetch = realFetch;
    Object.assign(console, saved);
    for (const key of ["VERCEL", "MIXOS_COMMIT", "MIXOS_REPOSITORY_URL", "GITHUB_APP_ENCRYPTION_KEY", "NEXTAUTH_URL", "MIXOS_UPDATE_CHECK", "MIXOS_RELEASE_CHANNEL"]) {
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

  async function link(record: { fork: boolean; parent: { id: number; fullName: string } | null }) {
    const installation = [...fake.installations.values()][0];
    const at = new Date().toISOString();
    await sql`delete from public.platform_settings where key in ('github_link', 'github_branch_rule', 'github_preview_checklist')`;
    assert.ok(
      await p.recordLink(
        {
          installationId: installation.id,
          repository: { id: 501, owner: "acme", name: "mixos", defaultBranch: "main", private: true, ...record },
          linkedAt: at,
          checkedAt: at,
          disabled: null,
        },
        { repositoryId: 501, branch: "main", checkedAt: at, pullRequest: true, rules: ["deletion", "pull_request"] },
      ),
    );
  }

  test("not linked: the notice offers nothing, and a proposal is refused", async () => {
    assert.equal(await offer(), null);
    const refused = await propose();
    assert.equal(!refused.ok && refused.code, "not-linked");
    assert.equal(posts().length, 0);
    assert.equal((await audited("mixos.update.propose.rejected")).at(-1)?.details.reason, "not-linked");
  });

  test("a private copy: the merge by hand and the compare link, no button, and a proposal refused", async () => {
    await link({ fork: false, parent: null });
    process.env.MIXOS_COMMIT = commits.A;
    const o = await offer();
    assert.equal(o?.kind, "copy");
    if (o?.kind !== "copy") return;
    assert.equal(o.command, `git fetch upstream --tags && git merge ${TAG}`);
    assert.equal(o.compareUrl, `https://github.com/mixoshq/mixos/compare/${commits.A}...${TAG}`);
    const refused = await propose();
    assert.equal(!refused.ok && refused.code, "not-a-fork", JSON.stringify(refused));
    assert.deepEqual(!refused.ok ? refused.links?.map((l) => l.href) : null, [o.compareUrl]);
    assert.equal(posts().length, 0);
    // A fork of another fork takes the same path: its recorded parent isn't upstream.
    await link({ fork: true, parent: { id: 777, fullName: "someone/mixos" } });
    assert.equal((await offer())?.kind, "copy");
  });

  test("a fork of upstream: the button, with the names built from the tag, off until the checklist holds", async () => {
    await link({ fork: true, parent: { id: UPSTREAM_ID, fullName: "mixoshq/mixos" } });
    const o = await offer();
    assert.deepEqual(o, {
      kind: "fork",
      tag: TAG,
      commitSha: commits.C,
      repository: "acme/mixos",
      defaultBranch: "main",
      branch: `mixos/update-${TAG}`,
      title: `Update MixOS to ${TAG} [skip preview]`,
      off: "Confirm on Admin > GitHub that no host builds previews of the App's branches.",
      compareUrl: `https://github.com/mixoshq/mixos/compare/${commits.A}...${TAG}`,
    });
    delete process.env.VERCEL;
    assert.equal(await offer(), null, "a checkout offers nothing");
    const checkout = await propose();
    assert.equal(!checkout.ok && checkout.code, "checkout");
    process.env.VERCEL = "1";
  });

  test("the preview checklist is needed first, as for an install", async () => {
    const refused = await propose();
    assert.equal(!refused.ok && refused.code, "checklist", JSON.stringify(refused));
    assert.equal(posts().length, 0, "nothing written");
    const confirmed = await p.confirmPreviewChecklist({ items: ["render", "railway", "coolify", "other"] }, { ...ctx, origin: () => "https://mixos.test" });
    assert.ok(confirmed.ok, JSON.stringify(confirmed));
    const o = await offer();
    assert.equal(o?.kind === "fork" ? o.off : "not a fork", null, "on, once the checklist holds");
  });

  test("a tag that points elsewhere: refused, audited, with the compare link", async () => {
    fake.tag(UPSTREAM_ID, TAG, commits.side);
    const refused = await propose();
    fake.tag(UPSTREAM_ID, TAG, commits.C);
    assert.equal(!refused.ok && refused.code, "tag-mismatch", JSON.stringify(refused));
    assert.match(!refused.ok ? refused.message : "", /not identical\. The release list and upstream disagree/);
    assert.deepEqual(!refused.ok ? refused.links?.map((l) => l.label) : null, ["What changed, on GitHub"]);
    assert.equal(posts().length, 0, "nothing written");
    const row = (await audited("mixos.update.propose.rejected")).at(-1)!;
    assert.equal(row.target_id, TAG);
    assert.equal(row.details.reason, "tag-mismatch");
    assert.equal(row.details.tagCompare, "diverged");
    assert.equal(row.details.commitSha, commits.C);
  });

  test("a commit that isn't on upstream's main: refused, audited", async () => {
    // The list names the side branch's commit, and upstream's tag agrees.
    await storeRelease({ commitSha: commits.side });
    fake.tag(UPSTREAM_ID, TAG, commits.side);
    const refused = await propose();
    fake.tag(UPSTREAM_ID, TAG, commits.C);
    await storeRelease();
    assert.equal(!refused.ok && refused.code, "not-on-main", JSON.stringify(refused));
    assert.match(!refused.ok ? refused.message : "", /isn't on mixoshq\/mixos's main \(GitHub says diverged\)/);
    assert.equal(posts().length, 0, "nothing written");
    const row = (await audited("mixos.update.propose.rejected")).at(-1)!;
    assert.deepEqual([row.details.reason, row.details.tagCompare, row.details.mainCompare], ["not-on-main", "identical", "diverged"]);
  });

  test("GitHub can't confirm it (upstream private, a 404): refused, audited", async () => {
    upstream().private = true;
    const refused = await propose();
    upstream().private = false;
    assert.equal(!refused.ok && refused.code, "unverified", JSON.stringify(refused));
    assert.match(!refused.ok ? refused.message : "", /GitHub couldn't confirm it: GitHub answered GET .*compare.* with 404/);
    assert.deepEqual(!refused.ok ? refused.links?.map((l) => l.label) : null, ["What changed, on GitHub"]);
    assert.equal(posts().length, 0, "nothing written");
    const row = (await audited("mixos.update.propose.rejected")).at(-1)!;
    assert.equal(row.details.reason, "unverified");
    assert.match(String(row.details.tagCompare), /404/);
  });

  test("a release that changes a workflow: refused before anything is written, with the compare link", async () => {
    const D = fake.push(UPSTREAM_ID, "main", { ".github/workflows/ci.yml": `${ours(".github/workflows/ci.yml")}\n# changed\n` }, "mixoshq");
    const next = TAG.replace(/\d+$/, (n) => String(Number(n) + 1));
    fake.tag(UPSTREAM_ID, next, D);
    await storeRelease({ tag: next, commitSha: D });
    const refused = await propose(next);
    assert.equal(!refused.ok && refused.code, "workflows-changed", JSON.stringify(refused));
    assert.match(!refused.ok ? refused.message : "", /changes `\.github\/workflows\/ci\.yml`, which the App can't push: it has no workflows permission/);
    assert.deepEqual(!refused.ok ? refused.findings?.map((f) => f.file) : null, [".github/workflows/ci.yml"]);
    assert.equal(posts().length, 0, "nothing written");
    const row = (await audited("mixos.update.propose.rejected")).at(-1)!;
    assert.deepEqual(row.details.files, [".github/workflows/ci.yml"]);
    // Upstream's main back to the release, for the rest.
    upstream().git.branches.set("main", commits.C);
    await storeRelease();
  });

  test("a release the list no longer names, or that isn't newer: refused without asking GitHub", async () => {
    const before = fake.requests.length;
    const stale = await propose("v99.0.0");
    assert.equal(!stale.ok && stale.code, "stale");
    await storeRelease({ tag: `v${VERSION}`, commitSha: commits.A });
    const same = await propose(`v${VERSION}`);
    assert.equal(!same.ok && same.code, "not-newer");
    await storeRelease();
    assert.equal(fake.requests.length, before, "GitHub wasn't asked");
  });

  let head = "";
  test("a fork with a verified tag: the branch at the release's commit, and the pull request", async () => {
    const mainBefore = fork().git.branches.get("main")!;
    const before = fake.requests.length;
    const outcome = await propose();
    assert.ok(outcome.ok, JSON.stringify(outcome));
    if (!outcome.ok) return;
    assert.deepEqual(outcome.pullRequest, { number: 1, url: "https://github.com/acme/mixos/pull/1", branch: `mixos/update-${TAG}`, head: commits.C });
    assert.deepEqual(outcome.compare, { ahead: 1, behind: 1, commits: 1, files: 3 });
    assert.match(outcome.message, /Opened pull request #1 on acme\/mixos: v\d+\.\d+\.\d+, 1 commit ahead of main/);
    head = outcome.pullRequest.head;

    // The writes: the ref, then the pull request, and nothing else.
    const writes = fake.requests.slice(before).filter((r) => r.method !== "GET" && r.path.startsWith("/repos/"));
    assert.deepEqual(writes.map((w) => `${w.method} ${w.path}`), ["POST /repos/acme/mixos/git/refs", "POST /repos/acme/mixos/pulls"]);
    assert.deepEqual(writes[0].body, { ref: `refs/heads/mixos/update-${TAG}`, sha: commits.C });
    // The compares, as GitHub was asked them.
    const compares = fake.requests.slice(before).filter((r) => r.path.includes("/compare/")).map((r) => decodeURIComponent(r.path.split("/compare/")[1]));
    assert.deepEqual(compares, [`${commits.C}...mixoshq:${TAG}`, `mixoshq:main...${commits.C}`, `main...${commits.C}`]);

    // What landed: the branch at upstream's commit, main untouched.
    assert.equal(fork().git.branches.get(`mixos/update-${TAG}`), commits.C);
    assert.equal(fork().git.branches.get("main"), mainBefore, "the default branch didn't move");
    assert.equal(fork().git.commits.get(commits.C)?.author, "mixoshq", "upstream's commit, not one of the App's");

    const pull = fork().pulls[0];
    assert.equal(pull.title, `Update MixOS to ${TAG} [skip preview]`);
    assert.equal(pull.head, `mixos/update-${TAG}`);
    assert.equal(pull.base, "main");
    assert.equal(pull.author.login, "mixos-test[bot]");
    // The body: the notes only in the fence, escaped; the numbers; the checklist.
    const fence = /(`{3,})text\n([\s\S]*?)\n\1/.exec(pull.body);
    assert.ok(fence, pull.body);
    const outside = pull.body.replace(fence![0], "");
    assert.ok(!/evil\.example|@everyone|#\d|skip ci|<script|alert/i.test(outside), outside);
    assert.match(fence![2], /^- fix\(os\): apply the security patch \(https:\/\/evil\.example\/patch\) \(\\#12\)$/m);
    assert.match(fence![2], /^- feat: cc \\@everyone, closes \\#3 \\\[skip ci\\\]$/m);
    assert.ok(!/<script|alert/.test(fence![2]));
    assert.match(outside, /\*\*Against `main`:\*\* 1 commit ahead, 1 commit behind, 3 files changed/);
    assert.match(outside, /\*\*Platform migrations:\*\* 1 file under `supabase\/migrations\/`/);
    assert.match(outside, /Vercel builds the merge and puts it into production\. The production build's release step applies the migrations/);
    assert.match(outside, /Back up the database first/);
    assert.match(outside, new RegExp(`https://mixos\\.org/docs/releases/${TAG.replace(/\./g, "\\.")}`));

    // The record of it.
    const row = (await audited("mixos.update.propose")).at(-1)!;
    assert.equal(row.actor_email, ADMIN.email);
    assert.equal(row.target_type, "mixos");
    assert.equal(row.target_id, TAG);
    assert.equal(row.details.pullRequest, 1);
    assert.equal(row.details.url, "https://github.com/acme/mixos/pull/1");
    assert.equal(row.details.branch, `mixos/update-${TAG}`);
    assert.equal(row.details.head, commits.C);
    assert.equal(row.details.baseCommit, commits.B);
    assert.equal(row.details.repositoryId, 501);
    assert.deepEqual(row.details.compare, { ahead: 1, behind: 1, commits: 1, files: 3 });
    assert.equal(row.details.branchRule, "rule");

    // The tokens: read, then write, each narrowed and revoked.
    const mints = fake.requests.slice(before).filter((r) => r.path.endsWith("/access_tokens")).map((r) => r.body);
    assert.deepEqual(mints, [
      { permissions: { metadata: "read" } },
      { repository_ids: [501], permissions: { contents: "read", checks: "read", statuses: "read", pull_requests: "read" } },
      { permissions: { metadata: "read" } },
      { repository_ids: [501], permissions: { contents: "write", pull_requests: "write" } },
    ]);
    assert.ok([...fake.tokens.values()].every((t) => t.revoked));
  });

  test("once opened from here, the notice says so and offers nothing else", async () => {
    const o = await offer();
    assert.equal(o?.kind, "proposed");
    if (o?.kind !== "proposed") return;
    assert.equal(o.number, 1);
    assert.equal(o.url, "https://github.com/acme/mixos/pull/1");
    assert.equal(o.by, ADMIN.email);
    assert.equal((await p.mixosUpdateOffer(notice(), { evenIfProposed: true }))?.kind, "fork");
  });

  test("an existing update branch: the open pull request's link, and nothing written", async () => {
    const before = posts().length;
    const again = await propose();
    assert.equal(!again.ok && again.code, "pull-request-open", JSON.stringify(again));
    assert.equal(!again.ok ? again.message : "", `Pull request #1 is already open for ${TAG}.`);
    assert.deepEqual(!again.ok ? again.links : null, [{ label: "Pull request #1", href: "https://github.com/acme/mixos/pull/1" }]);
    assert.equal(posts().length, before, "nothing written");
    assert.equal((await audited("mixos.update.propose.rejected")).at(-1)?.details.pullRequest, 1);

    // The pull request closed, the branch left: the branch's link.
    fork().pulls[0].state = "closed";
    const left = await propose();
    assert.equal(!left.ok && left.code, "branch-exists", JSON.stringify(left));
    assert.match(!left.ok ? left.message : "", /already exists, with no open pull request/);
    assert.deepEqual(!left.ok ? left.links?.map((l) => l.href) : null, [`https://github.com/acme/mixos/tree/mixos/update-${TAG}`]);
    fork().pulls[0].state = "open";
  });

  test("the default branch already at the release: refused", async () => {
    const mainWas = fork().git.branches.get("main")!;
    fork().git.branches.set("main", commits.C);
    fork().git.branches.delete(`mixos/update-${TAG}`);
    const merged = await propose();
    fork().git.branches.set("main", mainWas);
    fork().git.branches.set(`mixos/update-${TAG}`, commits.C);
    assert.equal(!merged.ok && merged.code, "already-merged", JSON.stringify(merged));
    assert.match(!merged.ok ? merged.message : "", /main already has .* commit\. Deploy it/);
  });

  test("the branch rule is read again; without one, an admin's confirmation is needed", async () => {
    fork().rules = { main: ["deletion"] };
    const refused = await propose();
    assert.equal(!refused.ok && refused.code, "branch-rule", JSON.stringify(refused));
    const stored = JSON.parse((await sql`select value from public.platform_settings where key = 'github_branch_rule'`)[0].value);
    assert.equal(stored.pullRequest, false, "the fresh read is stored");
    fork().rules = { main: ["deletion", "pull_request"] };
  });

  test("Admin > GitHub's list: waiting, then No CI ran, checks, and changed since opened", async () => {
    const now = new Date();
    let view = await p.readProposals(ADMIN, "mixos", now);
    assert.equal(view.state, "ok", JSON.stringify(view));
    if (view.state !== "ok") return;
    const one = () => (view.state === "ok" ? view.pulls[0] : null!);
    assert.equal(view.pulls.length, 1);
    assert.equal(one().kind, "mixos");
    assert.equal(one().slug, TAG);
    assert.equal(one().branch, `mixos/update-${TAG}`);
    assert.equal(one().version, TAG.slice(1));
    assert.equal(one().ci.state, "waiting");
    assert.equal(one().changed, false);
    assert.equal(one().unrecorded, false);
    assert.equal(one().url, "https://github.com/acme/mixos/pull/1");

    view = await p.readProposals(ADMIN, "mixos", new Date(now.getTime() + 11 * 60 * 1000));
    assert.deepEqual([one().ci.label, one().ci.tone], ["No CI ran", "danger"]);
    fake.checks.set(head, { runs: [{ name: "verify", status: "completed", conclusion: "success" }], statuses: [] });
    view = await p.readProposals(ADMIN, "mixos", now);
    assert.equal(one().ci.state, "passed");

    fake.push(501, `mixos/update-${TAG}`, { "src/extra.ts": "export const x = 1;\n" }, "someone-else");
    view = await p.readProposals(ADMIN, "mixos", now);
    assert.equal(one().changed, true);
    // The Apps page doesn't list it.
    const apps = await p.readProposals(ADMIN, "app", now);
    assert.deepEqual(apps.state === "ok" ? apps.pulls : null, []);
  });

  test("over the whole run: no write but the one ref and the one pull request, no merge, and no secret anywhere", async () => {
    const writes = fake.requests.filter((r) => r.host === "api" && r.method !== "GET");
    const repoWrites = writes.filter((w) => w.path.split("?")[0].startsWith("/repos/"));
    assert.deepEqual(repoWrites.map((w) => `${w.method} ${w.path}`), ["POST /repos/acme/mixos/git/refs", "POST /repos/acme/mixos/pulls"]);
    for (const w of writes) {
      const pathOnly = w.path.split("?")[0];
      if (pathOnly.startsWith("/repos/")) continue;
      assert.match(`${w.method} ${pathOnly}`, /^(POST \/app\/installations\/\d+\/access_tokens|DELETE \/installation\/token)$/);
    }
    assert.ok(!fake.requests.some((r) => /merge/.test(r.path) || r.method === "PUT" || r.method === "PATCH"));
    // Every compare was asked of the linked repository, and named upstream only as the constant does.
    const compares = fake.requests.filter((r) => r.path.includes("/compare/")).map((r) => r.path);
    assert.ok(compares.length >= 9, String(compares.length));
    for (const path of compares) {
      assert.match(
        path,
        /^\/repos\/acme\/mixos\/compare\/(?:[0-9a-f]{40}\.\.\.mixoshq%3Av[0-9A-Za-z.-]+|mixoshq%3Amain\.\.\.[0-9a-f]{40}|main\.\.\.[0-9a-f]{40})$/,
        path,
      );
    }
    assert.ok([...fake.tokens.values()].every((t) => t.revoked), "every token revoked");

    const settings = (await sql`select key, value from public.platform_settings where key like 'github\\_%' and key <> 'github_app_key'`).map(
      (r) => r.value as string,
    );
    const auditRows = (await sql`select details from public.admin_audit_log`).map((r) => JSON.stringify(r.details));
    const places = [...logs, ...answers.map((a) => JSON.stringify(a)), ...auditRows, ...settings];
    const bodies = fork().pulls.map((pr) => `${pr.title}\n${pr.body}`);
    for (const secret of fake.secrets) {
      for (const place of [...places, ...bodies]) assert.ok(!place.includes(secret), "a secret leaked");
    }
  });
});
