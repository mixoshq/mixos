/* This Source Code Form is subject to the terms of the Mozilla Public
 * License, v. 2.0. If a copy of the MPL was not distributed with this
 * file, You can obtain one at https://mozilla.org/MPL/2.0/. */

/**
 * The GitHub link end to end, against a real Postgres and the fake GitHub
 * (./fake-github.ts) standing in for `fetch`: creating the App, linking,
 * every operation's check, the branch rule and its confirmation, replacing the
 * key, unlinking, forgetting, upstream, rotating the encryption key, and that
 * no token, JWT or key reaches the logs, the audit log, the stored settings or
 * an answer.
 *
 * Skipped unless MIXOS_TEST_DATABASE_URL names a server this may create and
 * drop a database on:
 *
 *   docker run -d --name gh -e POSTGRES_PASSWORD=pw -p 127.0.0.1:55432:5432 postgres:17
 *   MIXOS_TEST_DATABASE_URL=postgres://postgres:pw@127.0.0.1:55432/postgres \
 *     npx tsx --test src/lib/github/link.integration.test.ts
 */

import { after, before, describe, test } from "node:test";
import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import { createDecipheriv, randomBytes } from "node:crypto";
import path from "node:path";
import postgres, { type Sql } from "postgres";
import { migratePlatform } from "../../../scripts/platform-migrations";
import { FakeGitHub, newPrivateKeyPem } from "./fake-github";

const REPO = path.resolve(__dirname, "../../..");
const serverUrl = process.env.MIXOS_TEST_DATABASE_URL;
const skip = serverUrl ? false : "set MIXOS_TEST_DATABASE_URL to run against a real Postgres";

const run = randomBytes(3).toString("hex");
const database = `mixos_github_${run}`;
const ORIGIN = "https://mixos.test";
const KEY_1 = randomBytes(32);
const KEY_2 = randomBytes(32);

async function loadPlatform() {
  return {
    ...(await import("./link")),
    ...(await import("./store")),
    ...(await import("./rekey")),
    ...(await import("./page-state")),
    ...(await import("./repository")),
    ...(await import("./jwt")),
    platformSql: (await import("@/lib/db/client")).sql,
  };
}

/** AES-256-GCM as src/lib/connectors/encryption.ts stores it, to check a row by hand. */
function opens(stored: string, key: Buffer): string | null {
  try {
    const [iv, tag, data] = stored.split(":").map((p) => Buffer.from(p, "base64"));
    const decipher = createDecipheriv("aes-256-gcm", key, iv);
    decipher.setAuthTag(tag);
    return Buffer.concat([decipher.update(data), decipher.final()]).toString("utf8");
  } catch {
    return null;
  }
}

describe("the GitHub link", { skip }, () => {
  let admin: Sql;
  let sql: Sql;
  let p: Awaited<ReturnType<typeof loadPlatform>>;
  let fake: FakeGitHub;
  const realFetch = globalThis.fetch;
  const logs: string[] = [];
  const answers: unknown[] = [];
  const states: string[] = [];
  const saved = { log: console.log, warn: console.warn, error: console.error, info: console.info };
  let ADMIN: { id: string; email: string };
  let OTHER: { id: string; email: string };

  const ctx = (actor = ADMIN, now?: () => Date) => ({
    admin: async () => actor,
    origin: () => ORIGIN,
    ...(now ? { now } : {}),
  });

  /** Keep every answer, for the leak check at the end. */
  function kept<T>(outcome: T): T {
    answers.push(outcome);
    return outcome;
  }

  const setting = async (key: string) =>
    ((await sql`select value from public.platform_settings where key = ${key}`)[0]?.value as string | undefined) ?? null;
  const githubRows = async () =>
    (await sql`select key from public.platform_settings where key like 'github\\_%' order by key`).map((r) => r.key as string);
  const audited = async (action: string) =>
    (await sql`select actor_email, target_type, target_id, details from public.admin_audit_log where action = ${action} order by created_at`).map(
      (r) => ({ ...r }),
    );
  const appRecord = async () => JSON.parse((await setting("github_app"))!) as { id: number; slug: string; keyFingerprint: string };
  const linkRecord = async () => JSON.parse((await setting("github_link"))!) as Record<string, unknown> & { disabled: unknown };

  /** The page's "Create on GitHub", the browser's post to GitHub, and GitHub sending the admin back. */
  async function create(
    account: { type: "user" } | { type: "organization"; login: string } = { type: "user" },
    actor = ADMIN,
  ): Promise<{ created: string; cookieState: string; code: string; state: string }> {
    const { outcome, cookieState } = await p.startAppCreation(
      { account: account.type, organization: account.type === "organization" ? account.login : undefined, name: "MixOS Test" },
      ctx(actor),
    );
    kept(outcome);
    assert.ok(outcome.ok, JSON.stringify(outcome));
    if (!outcome.ok) throw new Error("unreachable");
    states.push(cookieState!);
    const posted = await fake.fetch(outcome.action, {
      method: "POST",
      headers: { "content-type": "application/x-www-form-urlencoded" },
      body: new URLSearchParams({ manifest: outcome.manifest }).toString(),
      redirect: "manual",
    });
    const back = new URL(posted.headers.get("location")!);
    const code = back.searchParams.get("code")!;
    const state = back.searchParams.get("state")!;
    const created = await p.finishAppCreation({ code, state, cookieState: cookieState! }, actor);
    return { created, cookieState: cookieState!, code, state };
  }

  before(async () => {
    admin = postgres(serverUrl!, { max: 1, onnotice: () => {} });
    await admin.unsafe(`create database ${database}`);
    const u = new URL(serverUrl!);
    u.pathname = `/${database}`;
    sql = postgres(u.toString(), { max: 1, onnotice: () => {} });
    for (const level of ["log", "warn", "error", "info"] as const) {
      console[level] = (...args: unknown[]) => void logs.push(args.map((a) => (a instanceof Error ? `${a.name}: ${a.message}` : String(a))).join(" "));
    }
    await migratePlatform(sql, path.join(REPO, "supabase", "migrations"));

    process.env.DATABASE_URL = u.toString();
    process.env.PGSSLMODE = u.searchParams.get("sslmode") ?? "disable";
    process.env.GITHUB_APP_ENCRYPTION_KEY = KEY_1.toString("hex");
    process.env.NEXTAUTH_URL = ORIGIN;
    p = await loadPlatform();

    const [a] = await sql`
      insert into public.users (email, display_name, is_admin) values (${`admin-${run}@mixos.test`}, 'Admin', true)
      returning id, email`;
    const [b] = await sql`
      insert into public.users (email, display_name, is_admin) values (${`other-${run}@mixos.test`}, 'Other', true)
      returning id, email`;
    ADMIN = { id: a.id, email: a.email };
    OTHER = { id: b.id, email: b.email };

    fake = new FakeGitHub();
    globalThis.fetch = fake.fetch;
  });

  after(async () => {
    globalThis.fetch = realFetch;
    Object.assign(console, saved);
    await p?.platformSql.end();
    await sql?.end();
    if (admin) {
      await admin.unsafe(`drop database if exists ${database} with (force)`);
      await admin.end();
    }
  });

  test("creating the App: a state that works once, for its admin and browser, and the code exchanged at once", async () => {
    // Started by one admin, finished by another with the cookie: refused, and spent.
    const { outcome, cookieState } = await p.startAppCreation({ account: "user", name: "MixOS Test" }, ctx(ADMIN));
    assert.ok(outcome.ok);
    if (!outcome.ok) return;
    states.push(cookieState!);
    assert.equal(new URL(outcome.action).searchParams.get("state"), cookieState);
    assert.deepEqual(JSON.parse(outcome.manifest), (await import("./manifest")).appManifest(ORIGIN, "MixOS Test"));
    const pending = JSON.parse((await setting("github_manifest_state"))!);
    assert.equal(pending.userId, ADMIN.id);
    assert.notEqual(pending.hash, cookieState, "only a hash of the state is kept");

    const posted = await fake.fetch(outcome.action, {
      method: "POST",
      headers: { "content-type": "application/x-www-form-urlencoded" },
      body: new URLSearchParams({ manifest: outcome.manifest }).toString(),
      redirect: "manual",
    });
    const back = new URL(posted.headers.get("location")!);
    const code = back.searchParams.get("code")!;
    const state = back.searchParams.get("state")!;
    assert.equal(back.origin + back.pathname, `${ORIGIN}/api/admin/github/created`);

    // A different cookie: refused, and the pending state is left alone.
    assert.equal(await p.finishAppCreation({ code, state, cookieState: "x".repeat(43) }, ADMIN), "state");
    assert.ok(await setting("github_manifest_state"));
    // Another admin, with the cookie: refused.
    assert.equal(await p.finishAppCreation({ code, state, cookieState: state }, OTHER), "state");
    assert.equal(fake.calls().filter((c) => c.startsWith("POST /app-manifests")).length, 0, "no code was exchanged");

    // Expired: started 16 minutes before it came back.
    const late = await p.startAppCreation({ account: "user", name: "MixOS Test" }, ctx(ADMIN, () => new Date(Date.now() - 16 * 60 * 1000)));
    assert.ok(late.outcome.ok);
    if (!late.outcome.ok) return;
    assert.equal(await p.finishAppCreation({ code, state: late.cookieState!, cookieState: late.cookieState! }, ADMIN), "state");

    // GitHub failing the exchange: refused, logged without the code, which
    // could still be exchanged.
    fake.failures.set("POST /app-manifests", 502);
    assert.equal((await create()).created, "conversion-failed");
    fake.failures.clear();
    assert.ok(logs.some((l) => l.includes("[github] Creating the App: GitHub answered POST /app-manifests/{code}/conversions with 502")));
    assert.equal(await setting("github_app"), null);

    // The real round trip.
    const first = await create();
    assert.equal(first.created, "created");
    assert.equal(fake.calls().filter((c) => c.startsWith("POST /app-manifests")).length, 2);
    // Used once: the same state and code again are refused.
    assert.equal(await p.finishAppCreation({ code: first.code, state: first.state, cookieState: first.cookieState }, ADMIN), "state");

    const app = await appRecord();
    const fakeApp = fake.apps.get(app.id)!;
    assert.equal(app.slug, fakeApp.slug);
    assert.deepEqual(fakeApp.permissions, { contents: "write", pull_requests: "write", metadata: "read", checks: "read", statuses: "read" });
    assert.deepEqual(fakeApp.events, []);
    const stored = (await setting("github_app_key"))!;
    assert.ok(!stored.includes("PRIVATE KEY"), "the key is stored encrypted");
    const pem = opens(stored, KEY_1);
    assert.ok(pem, "under GITHUB_APP_ENCRYPTION_KEY");
    assert.equal(p.keyFingerprint(p.parsePrivateKey(pem!)), app.keyFingerprint);
    assert.ok([...fakeApp.keys.keys()].includes(app.keyFingerprint));

    const rows = await audited("github.app.create");
    assert.equal(rows.length, 1);
    assert.equal(rows[0].actor_email, ADMIN.email);
    assert.equal(rows[0].target_id, String(app.id));
    assert.equal((rows[0].details as { keyFingerprint: string }).keyFingerprint, app.keyFingerprint);
    assert.ok((await audited("github.app.create.rejected")).length >= 3);
  });

  test("one App at a time: no second round trip, and no code exchanged while one is recorded", async () => {
    const again = await p.startAppCreation({ account: "user", name: "Another" }, ctx());
    kept(again.outcome);
    assert.equal(again.outcome.ok, false);
    if (!again.outcome.ok) assert.equal(again.outcome.code, "exists");
    assert.equal(again.cookieState, null);

    // A state kept from before, and a code GitHub issued: still refused, unexchanged.
    const value = randomBytes(32).toString("base64url");
    await p.saveManifestState({ hash: p.manifestStateHash(value), userId: ADMIN.id, expiresAt: new Date(Date.now() + 60_000).toISOString() });
    const posted = await fake.fetch(`https://github.com/settings/apps/new?state=${value}`, {
      method: "POST",
      headers: { "content-type": "application/x-www-form-urlencoded" },
      body: new URLSearchParams({ manifest: JSON.stringify((await import("./manifest")).appManifest(ORIGIN, "Second")) }).toString(),
      redirect: "manual",
    });
    const code = new URL(posted.headers.get("location")!).searchParams.get("code")!;
    const before = fake.calls().length;
    assert.equal(await p.finishAppCreation({ code, state: value, cookieState: value }, ADMIN), "exists");
    assert.equal(fake.calls().length, before, "GitHub wasn't asked");
  });

  test("linking refuses every repository, two, and the wrong installation; links one, with a narrowed read", async () => {
    const app = await appRecord();
    let out = kept(await p.finishLinking({}, ctx()));
    assert.equal(out.ok, false);
    if (!out.ok) assert.equal(out.code, "not-installed");

    const installation = fake.install(app.id, { selection: "all", repositories: [] });
    out = kept(await p.finishLinking({ installationId: installation.id }, ctx()));
    assert.equal(!out.ok && out.code, "all-repositories");
    fake.changeInstallation(installation.id, { selection: "selected", repositories: ["acme/mixos", "acme/website"] });
    out = kept(await p.finishLinking({ installationId: installation.id }, ctx()));
    assert.equal(!out.ok && out.code, "more-than-one-repository");
    assert.equal(await setting("github_link"), null);
    assert.deepEqual(
      (await audited("github.link.rejected")).map((r) => (r.details as { reason: string }).reason),
      ["all-repositories", "more-than-one-repository"],
    );

    fake.changeInstallation(installation.id, { repositories: ["acme/mixos"] });
    out = kept(await p.finishLinking({ installationId: installation.id + 1 }, ctx()));
    assert.equal(!out.ok && out.code, "not-this-installation");

    fake.requests.length = 0;
    out = kept(await p.finishLinking({ installationId: installation.id }, ctx()));
    assert.equal(out.ok, true, JSON.stringify(out));
    const link = await linkRecord();
    assert.equal(link.installationId, installation.id);
    assert.deepEqual(link.repository, {
      id: 501,
      owner: "acme",
      name: "mixos",
      defaultBranch: "main",
      private: true,
      fork: true,
      parent: { id: 1345491436, fullName: "mixoshq/mixos" },
    });
    assert.equal(JSON.parse((await setting("github_branch_rule"))!).pullRequest, true);

    const mints = fake.requests.filter((r) => r.path.endsWith("/access_tokens")).map((r) => r.body);
    assert.deepEqual(mints, [
      { permissions: { metadata: "read" } },
      { repository_ids: [501], permissions: { contents: "read", checks: "read", statuses: "read", pull_requests: "read" } },
    ]);
    assert.equal(fake.calls().filter((c) => c === "DELETE /installation/token").length, 2);
    assert.ok([...fake.tokens.values()].every((t) => t.revoked), "every token is revoked when its operation ends");
    const linked = await audited("github.link");
    assert.equal(linked.length, 1);
    assert.equal((linked[0].details as { repository: string }).repository, "acme/mixos");

    out = kept(await p.finishLinking({}, ctx()));
    assert.equal(!out.ok && out.code, "linked");
  });

  test("every operation checks the installation again, and a widened one turns the link off", async () => {
    const link = await linkRecord();
    const installationId = link.installationId as number;
    const rules = await p.withLinkedRepository("read", ADMIN, (repo) => p.readBranchRules(repo));
    assert.equal(rules.pullRequest, true);

    // The write shape, narrowed the same way. It needs a scope: the one
    // folder its writes may touch (./repository.ts).
    fake.requests.length = 0;
    await assert.rejects(p.withLinkedRepository("write", ADMIN, async () => undefined), /needs a write scope/);
    assert.equal(fake.calls().filter((c) => c.endsWith("/access_tokens")).length, 0, "refused before a token is minted");
    await p.withLinkedRepository("write", ADMIN, async () => undefined, { scope: { folder: "apps/files" } });
    assert.deepEqual(fake.requests.filter((r) => r.path.endsWith("/access_tokens")).map((r) => r.body)[1], {
      repository_ids: [501],
      permissions: { contents: "write", pull_requests: "write" },
    });
    assert.ok([...fake.tokens.values()].every((t) => t.revoked));

    const widenings: [Parameters<FakeGitHub["changeInstallation"]>[1], string][] = [
      [{ selection: "all" }, "all-repositories"],
      [{ selection: "selected", repositories: ["acme/mixos", "acme/website"] }, "more-than-one-repository"],
      [{ selection: "selected", repositories: ["acme/website"] }, "repository-changed"],
      [{ selection: "selected", repositories: ["acme/mixos"], permissions: { ...fake.installations.get(installationId)!.permissions, workflows: "write" } }, "permissions-widened"],
    ];
    const original = { ...fake.installations.get(installationId)!.permissions };
    for (const [change, problem] of widenings) {
      fake.changeInstallation(installationId, change);
      await assert.rejects(
        p.withLinkedRepository("read", ADMIN, async () => assert.fail("ran with a widened installation")),
        (err: unknown) => err instanceof p.GitHubLinkError && err.outcome.code === problem,
        problem,
      );
      const off = (await linkRecord()).disabled as { reason: string };
      assert.equal(off.reason, problem);
      // Off now: refused before GitHub is asked.
      const before = fake.calls().length;
      await assert.rejects(p.withLinkedRepository("read", ADMIN, async () => undefined), (err: unknown) => err instanceof p.GitHubLinkError && err.outcome.code === "disabled");
      assert.equal(fake.calls().length, before);
      // Check again, still widened: still off.
      const still = kept(await p.checkLink(ctx()));
      assert.equal(!still.ok && still.code, problem);
      // Narrowed back: Check again turns it on.
      fake.changeInstallation(installationId, { selection: "selected", repositories: ["acme/mixos"], permissions: original });
      const back = kept(await p.checkLink(ctx()));
      assert.equal(back.ok, true, JSON.stringify(back));
      assert.equal((await linkRecord()).disabled, null);
    }
    assert.deepEqual(
      (await audited("github.link.disable")).map((r) => (r.details as { reason: string }).reason),
      widenings.map(([, problem]) => problem),
      "each switch-off is audited once",
    );
    assert.equal((await audited("github.link.enable")).length, widenings.length);

    // Suspended: refused, not switched off.
    fake.changeInstallation(installationId, { suspended: true });
    const suspended = kept(await p.checkLink(ctx()));
    assert.equal(!suspended.ok && suspended.code, "suspended");
    assert.equal((await linkRecord()).disabled, null);
    fake.changeInstallation(installationId, { suspended: false });
  });

  test("a renamed repository is refused until Check again records the new name, by id", async () => {
    fake.rename(501, "acme", "mixos-instance");
    await assert.rejects(p.withLinkedRepository("read", ADMIN, async () => undefined), (err: unknown) => err instanceof p.GitHubLinkError && err.outcome.code === "moved");
    const out = kept(await p.checkLink(ctx()));
    assert.equal(out.ok, true, JSON.stringify(out));
    assert.equal(((await linkRecord()).repository as { name: string }).name, "mixos-instance");
    const refreshed = await audited("github.link.refresh");
    assert.deepEqual((refreshed[0].details as { from: unknown; to: unknown }).to, { repository: "acme/mixos-instance", defaultBranch: "main" });
    assert.equal((await p.withLinkedRepository("read", ADMIN, (repo) => p.readBranchRules(repo))).pullRequest, true);
  });

  test("the branch rule: read on Check again; another protection confirmed with the name typed, and withdrawn", async () => {
    fake.repositories.get(501)!.rules = { main: ["deletion"] };
    let out = kept(await p.checkLink(ctx()));
    assert.ok(out.ok);
    assert.equal(JSON.parse((await setting("github_branch_rule"))!).pullRequest, false);
    assert.deepEqual(p.branchRuleSatisfied(await p.readGitHubState()), { ok: false });

    out = kept(await p.confirmBranchProtection({ reason: "classic-protection", typedRepository: "acme/mixos" }, ctx()));
    assert.equal(!out.ok && out.code, "typed");
    out = kept(await p.confirmBranchProtection({ reason: "classic-protection", typedRepository: "acme/mixos-instance" }, ctx()));
    assert.equal(out.ok, true);
    assert.deepEqual(p.branchRuleSatisfied(await p.readGitHubState()), { ok: true, via: "override" });
    const confirmed = await audited("github.branch-rule.override");
    assert.equal((confirmed[0].details as { reason: string }).reason, "classic-protection");

    out = kept(await p.withdrawBranchProtection(ctx()));
    assert.equal(out.ok, true);
    assert.equal(await setting("github_branch_rule_override"), null);
    assert.equal((await audited("github.branch-rule.override.clear")).length, 1);

    fake.repositories.get(501)!.rules = { main: ["pull_request", "deletion", "creation", "update"] };
    assert.ok(kept(await p.checkLink(ctx())).ok);
    assert.deepEqual(p.branchRuleSatisfied(await p.readGitHubState()), { ok: true, via: "rule" });
    out = kept(await p.confirmBranchProtection({ reason: "free-private", typedRepository: "acme/mixos-instance" }, ctx()));
    assert.equal(!out.ok && out.code, "not-needed");
  });

  test("replacing the private key: another App's and a stray key are refused; the App's own is stored", async () => {
    const app = await appRecord();
    const original = app.keyFingerprint;

    // Another App's key: GitHub checks a JWT against this App's keys, and refuses it.
    const someoneElse = fake.createApp("acme", "Someone Else", { contents: "read" });
    let out = kept(await p.replacePrivateKey({ pem: someoneElse.pem }, ctx()));
    assert.equal(!out.ok && out.code, "key-refused", JSON.stringify(out));

    // And should GitHub ever answer GET /app as another App, the id decides.
    const realFake = fake.fetch;
    globalThis.fetch = (async (input: RequestInfo | URL, init?: RequestInit) => {
      const res = await realFake(input, init);
      if (String(input) !== "https://api.github.com/app") return res;
      return Response.json({ ...((await res.json()) as object), id: someoneElse.app.id });
    }) as typeof fetch;
    out = kept(await p.replacePrivateKey({ pem: fake.addKey(app.id).pem }, ctx()));
    globalThis.fetch = fake.fetch;
    assert.equal(!out.ok && out.code, "another-app");

    out = kept(await p.replacePrivateKey({ pem: newPrivateKeyPem().pem }, ctx()));
    assert.equal(!out.ok && out.code, "key-refused");
    out = kept(await p.replacePrivateKey({ pem: "-----BEGIN RSA PRIVATE KEY-----\nnope\n-----END RSA PRIVATE KEY-----" }, ctx()));
    assert.equal(!out.ok && out.code, "key");
    assert.equal((await appRecord()).keyFingerprint, original, "refused keys change nothing");

    // A key generated in the App's settings: checked, stored, audited.
    const fresh = fake.addKey(app.id);
    out = kept(await p.replacePrivateKey({ pem: fresh.pem }, ctx()));
    assert.ok(out.ok, JSON.stringify(out));
    if (out.ok) assert.ok(out.message.includes(`Delete the old key, ${original}`), out.message);
    assert.equal((await appRecord()).keyFingerprint, fresh.fingerprint);
    assert.ok(opens((await setting("github_app_key"))!, KEY_1)?.includes("PRIVATE KEY"));
    const replaced = (await audited("github.app.key.replace")).at(-1)!.details;
    assert.deepEqual(replaced, { appSlug: app.slug, previousFingerprint: original, fingerprint: fresh.fingerprint });
    assert.deepEqual(
      (await audited("github.app.key.replace.rejected")).map((r) => (r.details as { reason: string }).reason),
      ["refused", "another-app", "refused"],
    );

    // Every other key deleted on GitHub, as the reminder says: the link still works.
    for (const fingerprint of [...fake.apps.get(app.id)!.keys.keys()]) {
      if (fingerprint !== fresh.fingerprint) fake.deleteKey(app.id, fingerprint);
    }
    assert.ok(kept(await p.checkLink(ctx())).ok);
  });

  test("unlinking: when GitHub refuses to uninstall, nothing is forgotten; then it uninstalls and forgets", async () => {
    const app = await appRecord();
    const installationId = (await linkRecord()).installationId as number;
    fake.failures.set("DELETE /app/installations", 500);
    let out = kept(await p.unlink(ctx()));
    assert.equal(!out.ok && out.code, "uninstall-refused");
    assert.ok(fake.installations.has(installationId));
    assert.deepEqual(await githubRows(), ["github_app", "github_app_key", "github_branch_rule", "github_link"]);
    assert.equal((await audited("github.unlink.rejected")).length, 1);

    fake.failures.clear();
    out = kept(await p.unlink(ctx()));
    assert.equal(out.ok, true, JSON.stringify(out));
    if (out.ok) assert.ok(out.links?.some((l) => l.href === `https://github.com/settings/apps/${app.slug}`));
    assert.equal(fake.installations.has(installationId), false);
    assert.ok(fake.calls().includes(`DELETE /app/installations/${installationId}`));
    assert.deepEqual(await githubRows(), []);
    const unlinked = await audited("github.unlink");
    assert.deepEqual((unlinked[0].details as { installationIds: number[] }).installationIds, [installationId]);
  });

  test("forgetting is refused while GitHub accepts the key, and needs the slug typed", async () => {
    assert.equal((await create()).created, "created");
    const app = await appRecord();
    let out = kept(await p.forgetApp({ typedSlug: "wrong" }, ctx()));
    assert.equal(!out.ok && out.code, "typed");
    out = kept(await p.forgetApp({ typedSlug: app.slug }, ctx()));
    assert.equal(!out.ok && out.code, "key-works");
    assert.ok(await setting("github_app"));

    for (const fingerprint of [...fake.apps.get(app.id)!.keys.keys()]) fake.deleteKey(app.id, fingerprint);
    out = kept(await p.unlink(ctx()));
    assert.equal(!out.ok && out.code, "key-refused");
    out = kept(await p.forgetApp({ typedSlug: app.slug }, ctx()));
    assert.equal(out.ok, true);
    assert.deepEqual(await githubRows(), []);
    assert.equal(((await audited("github.app.forget"))[0].details as { why: string }).why, "key-refused");
  });

  test("a repository whose rules GitHub won't show still links, and needs a confirmation", async () => {
    assert.equal((await create()).created, "created");
    const app = await appRecord();
    fake.install(app.id, { selection: "selected", repositories: ["acme/website"] });
    fake.failures.set("GET /repos/acme/website/rules", 403);
    let out = kept(await p.finishLinking({}, ctx()));
    fake.failures.clear();
    assert.equal(out.ok, true, JSON.stringify(out));
    if (out.ok) assert.match(out.message, /didn't let the App read the rules on main \(403\)/);
    const rule = JSON.parse((await setting("github_branch_rule"))!);
    assert.equal(rule.unreadStatus, 403);
    assert.equal(rule.pullRequest, false);
    assert.deepEqual(p.branchRuleSatisfied(await p.readGitHubState()), { ok: false });
    out = kept(await p.confirmBranchProtection({ reason: "free-private", typedRepository: "acme/website" }, ctx()));
    assert.equal(out.ok, true);
    assert.deepEqual(p.branchRuleSatisfied(await p.readGitHubState()), { ok: true, via: "override" });
    assert.ok(kept(await p.unlink(ctx())).ok);
  });

  test("an App on upstream MixOS is never linked", async () => {
    assert.equal((await create({ type: "organization", login: "mixoshq" })).created, "created");
    const app = await appRecord();
    fake.install(app.id, { selection: "selected", repositories: ["mixoshq/mixos"] });
    const out = kept(await p.finishLinking({}, ctx()));
    assert.equal(!out.ok && out.code, "upstream");
    assert.equal(await setting("github_link"), null);
    assert.equal((await audited("github.link.rejected")).at(-1)!.details.reason, "upstream");
    assert.ok(kept(await p.unlink(ctx())).ok);
  });

  test("rotating GITHUB_APP_ENCRYPTION_KEY: one command re-encrypts the stored key, given the old and the new", async () => {
    assert.equal((await create()).created, "created");
    const app = await appRecord();
    const before = (await setting("github_app_key"))!;
    assert.ok(opens(before, KEY_1));

    const result = await p.rekeyStoredKey(KEY_1, KEY_2);
    assert.equal(result.outcome, "reencrypted");
    if (result.outcome === "reencrypted") assert.equal(result.fingerprint, app.keyFingerprint);
    const after = (await setting("github_app_key"))!;
    assert.equal(opens(after, KEY_1), null);
    assert.equal(opens(after, KEY_2), opens(before, KEY_1));
    assert.equal((await p.rekeyStoredKey(KEY_1, KEY_2)).outcome, "already");
    await assert.rejects(p.rekeyStoredKey(randomBytes(32), randomBytes(32)), p.RekeyError);
    await assert.rejects(p.rekeyStoredKey(KEY_2, KEY_2), p.RekeyError);

    // The instance still on the old key: the page says the key can't be read.
    assert.equal((await p.readPageState()).app?.keyReadable, false);
    process.env.GITHUB_APP_ENCRYPTION_KEY = KEY_2.toString("hex");
    assert.equal((await p.readPageState()).app?.keyReadable, true);

    // And as the command, back to the first key.
    const cli = spawnSync(process.execPath, ["--import", "tsx", path.join(REPO, "scripts", "rekey-github-app.ts")], {
      cwd: REPO,
      encoding: "utf8",
      env: {
        PATH: process.env.PATH ?? "",
        DATABASE_URL: process.env.DATABASE_URL,
        PGSSLMODE: process.env.PGSSLMODE,
        GITHUB_APP_ENCRYPTION_KEY_OLD: KEY_2.toString("hex"),
        GITHUB_APP_ENCRYPTION_KEY_NEW: KEY_1.toString("base64"),
      } as unknown as NodeJS.ProcessEnv,
    });
    logs.push(cli.stdout, cli.stderr);
    assert.equal(cli.status, 0, cli.stderr);
    assert.match(cli.stdout, /Re-encrypted the GitHub App's private key/);
    assert.ok(opens((await setting("github_app_key"))!, KEY_1));
    const row = (await audited("github.app.key.reencrypt"))[0];
    assert.match(row.actor_email as string, /^cli:/);
    assert.equal((row.details as { fingerprint: string }).fingerprint, app.keyFingerprint);
    process.env.GITHUB_APP_ENCRYPTION_KEY = KEY_1.toString("hex");

    const usage = spawnSync(process.execPath, ["--import", "tsx", path.join(REPO, "scripts", "rekey-github-app.ts")], {
      cwd: REPO,
      encoding: "utf8",
      env: { PATH: process.env.PATH ?? "", DATABASE_URL: process.env.DATABASE_URL } as unknown as NodeJS.ProcessEnv,
    });
    assert.equal(usage.status, 1);
    assert.match(usage.stderr, /Set both the old and the new key/);
  });

  test("no token, JWT or key reaches the logs, the audit log, the stored settings or an answer", async () => {
    const secrets = new Set<string>(fake.secrets);
    for (const key of [KEY_1, KEY_2]) {
      secrets.add(key.toString("hex"));
      secrets.add(key.toString("base64"));
    }
    // A key's PEM body, line by line: a stored copy in another format still shares none.
    const needles: string[] = [];
    for (const secret of secrets) {
      if (secret.includes("PRIVATE KEY")) {
        needles.push(...secret.split(/\r?\n/).filter((l) => /^[A-Za-z0-9+/=]{40,}$/.test(l)));
      } else {
        needles.push(secret);
      }
    }
    assert.ok(needles.length > 20, `${needles.length} secrets to look for`);
    assert.ok([...fake.tokens.keys()].length > 10, "tokens were minted");

    const audit = JSON.stringify(await sql`select * from public.admin_audit_log`);
    const settings = JSON.stringify(await sql`select * from public.platform_settings`);
    const haystacks = { logs: logs.join("\n"), audit, settings, answers: JSON.stringify(answers) };
    for (const [where, text] of Object.entries(haystacks)) {
      for (const needle of needles) assert.ok(!text.includes(needle), `${where} holds a secret (${needle.slice(0, 12)}…)`);
    }
    // The round trips' states live in cookies and URLs, never in the database.
    for (const state of states) assert.ok(!settings.includes(state));
  });
});
