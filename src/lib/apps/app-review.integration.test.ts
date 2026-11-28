/* This Source Code Form is subject to the terms of the Mozilla Public
 * License, v. 2.0. If a copy of the MPL was not distributed with this
 * file, You can obtain one at https://mozilla.org/MPL/2.0/. */

/**
 * Trust tiers, against a real Postgres: a Registry app runs only once an admin
 * here has reviewed the exact code it runs.
 *
 *   - a local app activates as before;
 *   - Activate refuses a Registry app with no review of its code, and allows
 *     it with one, recorded and audited as `app.review`;
 *   - an update switches it off at the release step, flags it and audits
 *     `app.update.unreviewed`, and a review of the new code lets it back on;
 *   - the first release step after this shipped switches off an active
 *     Registry app that nobody reviewed (`app.review.required`): nothing is
 *     grandfathered;
 *   - a local edit to its files is new code: the review of the release
 *     doesn't count for it.
 *
 * Skipped unless MIXOS_TEST_DATABASE_URL names a server this may create and
 * drop a database on:
 *
 *   docker run -d --name review -e POSTGRES_PASSWORD=pw -p 127.0.0.1:55432:5432 postgres:17
 *   MIXOS_TEST_DATABASE_URL=postgres://postgres:pw@127.0.0.1:55432/postgres \
 *     npx tsx --test src/lib/apps/app-review.integration.test.ts
 *
 * The apps are folders in a temporary directory and entries in this process's
 * registry; the Registry app has an install record only in this process's
 * `registryInstalls`.
 */

import { after, before, describe, test } from "node:test";
import assert from "node:assert/strict";
import { randomBytes } from "node:crypto";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import postgres, { type Sql } from "postgres";
import { migratePlatform } from "../../../scripts/platform-migrations";
import type { AppManifest } from "@/lib/apps/types";
import type { RegistryInstall } from "@/lib/repository/install-record";

const REPO = path.resolve(__dirname, "../../..");
const serverUrl = process.env.MIXOS_TEST_DATABASE_URL;
const skip = serverUrl ? false : "set MIXOS_TEST_DATABASE_URL to run against a real Postgres";

const run = randomBytes(3).toString("hex");
const database = `mixos_review_${run}`;
const LOCAL = `local-${run}`;
const THIRD = `third-${run}`;
const COMMIT = "a".repeat(40);

async function loadPlatform() {
  return {
    ...(await import("@/generated/app-registry")),
    ...(await import("@/generated/registry-installs")),
    ...(await import("./access")),
    ...(await import("./app-review")),
    ...(await import("../../../scripts/sync-app-registry")),
    platformSql: (await import("@/lib/db/client")).sql,
  };
}

async function quietly<T>(fn: () => Promise<T>): Promise<T> {
  const { log, warn, error } = console;
  console.log = console.warn = console.error = () => {};
  try {
    return await fn();
  } finally {
    Object.assign(console, { log, warn, error });
  }
}

describe("reviews of Registry apps", { skip }, () => {
  let admin: Sql;
  let sql: Sql;
  let p: Awaited<ReturnType<typeof loadPlatform>>;
  let actor: { id: string; email: string };
  let root: string;
  let appsDir: string;
  const install: RegistryInstall = {
    kind: "app",
    slug: THIRD,
    version: "1.2.0",
    gitTag: "v1.2.0",
    commitSha: COMMIT,
    source: "https://mixos.org",
    repository: { owner: "acme", name: "mixos-notes", subpath: null },
    requiresMixOS: null,
    modified: false,
  };

  const mirrored = () =>
    [LOCAL, THIRD].map((slug) => ({ slug, name: slug, description: "An app.", icon: "box" }));
  const release = () => quietly(() => p.syncAppRegistry(sql, mirrored(), appsDir, [install]));
  const write = (slug: string, body: string) => fs.writeFileSync(path.join(appsDir, slug, "api.ts"), body);
  const active = async (slug: string) =>
    (await sql`select is_active, review_needed_since from public.apps where slug = ${slug}`)[0];
  async function audited(action: string) {
    const rows = await sql`select target_id, details from public.admin_audit_log where action = ${action} order by created_at`;
    return rows.map((r) => ({ target: r.target_id as string, details: r.details as Record<string, unknown> }));
  }

  before(async () => {
    admin = postgres(serverUrl!, { max: 1, onnotice: () => {} });
    await admin.unsafe(`create database ${database}`);
    const u = new URL(serverUrl!);
    u.pathname = `/${database}`;
    sql = postgres(u.toString(), { max: 1, onnotice: () => {} });
    await quietly(() => migratePlatform(sql, path.join(REPO, "supabase", "migrations")));
    process.env.DATABASE_URL = u.toString();
    process.env.PGSSLMODE = u.searchParams.get("sslmode") ?? "disable";
    p = await loadPlatform();

    root = fs.mkdtempSync(path.join(os.tmpdir(), "mixos-review-"));
    appsDir = path.join(root, "apps");
    for (const slug of [LOCAL, THIRD]) {
      fs.mkdirSync(path.join(appsDir, slug), { recursive: true });
      write(slug, `export const v = 1;\n`);
    }
    const base = p.appRegistry[0];
    assert.ok(base, "the registry needs one app to copy a manifest shape from");
    for (const slug of [LOCAL, THIRD]) {
      p.appRegistry.push({ ...base, slug, name: slug, connectors: [], optionalConnectors: [], connectorRequirements: [] } as AppManifest);
    }
    p.registryInstalls.push(install);

    const [user] = await sql`
      insert into public.users (email, display_name, is_admin)
      values (${`admin-${run}@mixos.test`}, 'Admin', true) returning id, email
    `;
    actor = { id: user.id, email: user.email };
    await release();
  });

  after(async () => {
    await p?.platformSql.end();
    await sql?.end();
    if (root) fs.rmSync(root, { recursive: true, force: true });
    if (admin) {
      await admin.unsafe(`drop database if exists ${database} with (force)`);
      await admin.end();
    }
  });

  test("a local app activates as before, with no review", async () => {
    await p.setAppActive(LOCAL, true);
    assert.equal((await active(LOCAL)).is_active, true);
    assert.equal(await p.getAppTrust([LOCAL]).then((t) => t[LOCAL]), undefined);
  });

  test("a Registry app is refused until an admin reviews its code, then activates", async () => {
    await assert.rejects(
      p.setAppActive(THIRD, true),
      (err: Error) =>
        err instanceof p.UnreviewedAppError &&
        /is from mixos\.org · acme\/mixos-notes · 1\.2\.0, and nobody here has reviewed the code it runs/.test(err.message),
    );
    assert.equal((await active(THIRD)).is_active, false);
    const before = (await p.getAppTrust([THIRD]))[THIRD];
    assert.equal(before.reviewed, false);
    assert.equal(before.previouslyReviewed, false);
    assert.equal(before.sourceUrl, `https://github.com/acme/mixos-notes/tree/${COMMIT}`);

    const trust = await p.recordAppReview(actor, THIRD);
    assert.equal(trust.reviewed, true);
    const [review] = await audited("app.review");
    assert.equal(review.target, THIRD);
    assert.equal(review.details.version, "1.2.0");
    assert.equal(review.details.commitSha, COMMIT);
    assert.equal(review.details.repository, "acme/mixos-notes");
    assert.match(String(review.details.codeHash), /^sha256-/);

    await p.setAppActive(THIRD, true);
    assert.equal((await active(THIRD)).is_active, true);
  });

  test("a release step with the same code leaves both apps on", async () => {
    const result = await release();
    assert.deepEqual(result.unreviewed, []);
    assert.equal((await active(THIRD)).is_active, true);
    assert.equal((await active(LOCAL)).is_active, true);
  });

  test("an update switches it off, flags it and audits it; a review of the new code lets it back on", async () => {
    write(THIRD, `export const v = 2;\n`);
    const result = await release();
    assert.deepEqual(result.unreviewed.map((u) => [u.slug, u.previouslyReviewed]), [[THIRD, true]]);
    const row = await active(THIRD);
    assert.equal(row.is_active, false);
    assert.ok(row.review_needed_since instanceof Date);
    const [updated] = await audited("app.update.unreviewed");
    assert.equal(updated.target, THIRD);
    // The local app, with no install record, is untouched.
    assert.equal((await active(LOCAL)).is_active, true);

    const trust = (await p.getAppTrust([THIRD]))[THIRD];
    assert.equal(trust.reviewed, false);
    assert.equal(trust.previouslyReviewed, true);
    assert.ok(trust.reviewNeededSince);
    await assert.rejects(p.setAppActive(THIRD, true), p.UnreviewedAppError);

    await p.recordAppReview(actor, THIRD);
    assert.equal((await active(THIRD)).review_needed_since, null);
    await p.setAppActive(THIRD, true);
    assert.equal((await active(THIRD)).is_active, true);
  });

  test("nothing is grandfathered: an active Registry app nobody reviewed is switched off", async () => {
    await sql`delete from public.app_reviews where app_slug = ${THIRD}`;
    await sql`update public.apps set is_active = true, review_needed_since = null where slug = ${THIRD}`;
    const result = await release();
    assert.deepEqual(result.unreviewed.map((u) => [u.slug, u.previouslyReviewed]), [[THIRD, false]]);
    assert.equal((await active(THIRD)).is_active, false);
    assert.deepEqual((await audited("app.review.required")).map((r) => r.target), [THIRD]);
  });

  test("the recorded identity counts too: a server that hasn't reloaded its install records still refuses", async () => {
    // As just after Register in a dev server: the app's folder and its row are
    // there, its identity says mixos.org, and this process's build has no record of it.
    const FRESH = `fresh-${run}`;
    fs.mkdirSync(path.join(appsDir, FRESH), { recursive: true });
    write(FRESH, `export const v = 1;\n`);
    p.appRegistry.push({ ...p.appRegistry.find((a) => a.slug === LOCAL)!, slug: FRESH, name: FRESH });
    await sql`
      insert into public.apps (slug, name, is_active, identity)
      values (${FRESH}, ${FRESH}, false, ${`https://mixos.org app/${FRESH} acme/mixos-fresh`})
    `;
    await assert.rejects(
      p.setAppActive(FRESH, true),
      (err: Error) => err instanceof p.UnreviewedAppError && /is from mixos\.org, acme\/mixos-fresh/.test(err.message),
    );
    // Register's own review, of the folder it put in place, lets it on.
    const cwd = process.cwd();
    process.chdir(root);
    try {
      await p.recordRegisteredReview(actor, { slug: FRESH, root, source: "https://mixos.org", version: "0.1.0", commitSha: COMMIT });
      await p.setAppActive(FRESH, true);
    } finally {
      process.chdir(cwd);
    }
    const reviews = await audited("app.review");
    assert.equal(reviews.at(-1)?.target, FRESH);
    assert.equal(reviews.at(-1)?.details.via, "register");
  });

  test("a local edit is new code: the review of what was installed doesn't count for it", async () => {
    await p.recordAppReview(actor, THIRD);
    const cwd = process.cwd();
    // Activate reads the folder as deployed, from the project root.
    process.chdir(root);
    try {
      await p.setAppActive(THIRD, true);
      write(THIRD, `export const v = 3; // edited here\n`);
      await p.setAppActive(THIRD, false);
      await assert.rejects(p.setAppActive(THIRD, true), p.UnreviewedAppError);
      assert.equal((await p.getAppTrust([THIRD]))[THIRD].reviewed, false);
      await p.recordAppReview(actor, THIRD);
      await p.setAppActive(THIRD, true);
    } finally {
      process.chdir(cwd);
    }
  });
});
