/* This Source Code Form is subject to the terms of the Mozilla Public
 * License, v. 2.0. If a copy of the MPL was not distributed with this
 * file, You can obtain one at https://mozilla.org/MPL/2.0/. */

/**
 * `npm run register` against a real Postgres: the register lock is a real row
 * in `_platform_locks`, held with the checkout lock for the whole of a
 * registration, and every row it audits names the CLI, with no user id, and
 * reads back as unverified.
 *
 * Skipped unless MIXOS_TEST_DATABASE_URL names a server this may create and
 * drop a database on. The database's name ends in this run's own suffix, and
 * it is dropped when the run finishes:
 *
 *   docker run -d --name register -e POSTGRES_PASSWORD=pw -p 127.0.0.1:55432:5432 postgres:17
 *   MIXOS_TEST_DATABASE_URL=postgres://postgres:pw@127.0.0.1:55432/postgres \
 *     npx tsx --test src/lib/repository/register.integration.test.ts
 *
 * The checkout is a temporary folder, and the registry generator a stand-in
 * that can be held mid-run, as register.test.ts's is.
 */

import { after, before, beforeEach, describe, test } from "node:test";
import assert from "node:assert/strict";
import { randomBytes } from "node:crypto";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import postgres, { type Sql } from "postgres";
import { migratePlatform } from "../../../scripts/platform-migrations";
import { filesHash, hashFileTree } from "./content-hash";
import { INSTALL_RECORD_FILE, serializeInstallRecord } from "./install-record";
import { pendingLocation, writeSidecar, type PendingKind } from "./pending";
import type { TarEntry } from "./tar";

const REPO = path.resolve(__dirname, "../../..");
const serverUrl = process.env.MIXOS_TEST_DATABASE_URL;
const skip = serverUrl ? false : "set MIXOS_TEST_DATABASE_URL to run against a real Postgres";

const run = randomBytes(3).toString("hex");
const database = `mixos_register_${run}`;

const tmp = fs.realpathSync(fs.mkdtempSync(path.join(os.tmpdir(), "mixos-register-db-")));

/**
 * The stand-in generator. While a file named `gate` is in the checkout it says
 * so, in `waiting`, and waits; then it registers every folder in apps/ and
 * connectors/.
 */
const STAND_IN = path.join(tmp, "stand-in.mjs");
fs.writeFileSync(
  STAND_IN,
  `import fs from "node:fs";
const cell = new Int32Array(new SharedArrayBuffer(4));
if (fs.existsSync("gate")) {
  fs.writeFileSync("waiting", "");
  while (fs.existsSync("gate")) Atomics.wait(cell, 0, 0, 50);
}
const list = (dir) => (fs.existsSync(dir) ? fs.readdirSync(dir).filter((n) => !n.startsWith(".")) : []);
fs.mkdirSync("src/generated", { recursive: true });
fs.writeFileSync("src/generated/app-registry.ts", JSON.stringify(list("apps").map((slug) => ({ slug })), null, 2));
fs.writeFileSync("src/generated/connector-registry.ts", JSON.stringify(list("connectors").map((name) => ({ name })), null, 2));
`,
);

const TREE: TarEntry[] = [{ path: "app.json", mode: 0o644, data: Buffer.from('{"name":"Acme"}\n') }];

/** Silence the logs a refusal writes on purpose, for the length of `fn`. */
async function quietly<T>(fn: () => Promise<T>): Promise<T> {
  const { log, warn, error } = console;
  console.log = console.warn = console.error = () => {};
  try {
    return await fn();
  } finally {
    Object.assign(console, { log, warn, error });
  }
}

describe("npm run register, against a real Postgres", { skip }, () => {
  let admin: Sql;
  let sql: Sql;
  let root: string;
  let n = 0;
  let cli: typeof import("../../../scripts/register-cli");
  let audit: typeof import("../apps/admin-audit");
  let platformSql: Sql;

  function pend(kind: PendingKind, slug: string) {
    const where = pendingLocation(root, kind, slug);
    fs.mkdirSync(where.folder, { recursive: true });
    for (const e of TREE) fs.writeFileSync(path.join(where.folder, e.path), e.data);
    fs.writeFileSync(
      path.join(where.folder, INSTALL_RECORD_FILE),
      serializeInstallRecord({
        source: "https://mixos.org",
        kind,
        slug,
        version: "1.2.0",
        gitTag: "v1.2.0",
        commitSha: "e".repeat(40),
        contentHash: hashFileTree(TREE),
        filesHash: filesHash(TREE),
        repository: { owner: "acme", name: slug, subpath: null },
        requiresMixOS: null,
      }),
    );
    writeSidecar(where.sidecar, {
      kind,
      slug,
      yankedAccepted: false,
      installedAt: "2026-10-11T09:00:00.000Z",
      installedBy: "admin@example.com",
      check: { verdict: "accepted", deferred: [] },
    });
  }

  function terminal(answers: boolean[] = []) {
    const out: string[] = [];
    const err: string[] = [];
    return {
      out,
      err,
      io: {
        out: (line: string) => out.push(line),
        err: (line: string) => err.push(line),
        ask: async () => answers.shift() ?? false,
      },
    };
  }

  /** `npm run register -- <args>` in the test's checkout, as this machine's OS user. */
  const register = (args: string[], t = terminal()) =>
    cli.runCli(args, { root, io: t.io, generator: STAND_IN });

  async function rows(action: string, slug: string) {
    return (
      await sql`
        select actor_id, actor_email, target_type, details
        from public.admin_audit_log
        where action = ${action} and target_id = ${slug}
        order by created_at
      `
    ).map((r) => ({ ...r }));
  }

  async function registerLockRows() {
    return (await sql`select holder from public._platform_locks where name = 'repository.register'`).length;
  }

  before(async () => {
    admin = postgres(serverUrl!, { max: 1, onnotice: () => {} });
    await admin.unsafe(`create database ${database}`);
    const u = new URL(serverUrl!);
    u.pathname = `/${database}`;
    sql = postgres(u.toString(), { max: 2, onnotice: () => {} });
    await quietly(() => migratePlatform(sql, path.join(REPO, "supabase", "migrations")));

    // The platform's own pool, which the register lock and the audit use,
    // reads these on its first query.
    process.env.DATABASE_URL = u.toString();
    process.env.PGSSLMODE = u.searchParams.get("sslmode") ?? "disable";
    cli = await import("../../../scripts/register-cli");
    audit = await import("../apps/admin-audit");
    platformSql = (await import("@/lib/db/client")).sql;
  });

  beforeEach(() => {
    root = path.join(tmp, `checkout-${n++}`);
    for (const dir of ["apps", "connectors"]) fs.mkdirSync(path.join(root, dir), { recursive: true });
  });

  after(async () => {
    await platformSql?.end();
    await sql?.end();
    if (admin) {
      await admin.unsafe(`drop database if exists ${database} with (force)`);
      await admin.end();
    }
    fs.rmSync(tmp, { recursive: true, force: true });
  });

  test("Register holds the register lock and the checkout lock while the generator runs, and releases both", async () => {
    pend("app", "acme");
    fs.writeFileSync(path.join(root, "gate"), "");
    const t = terminal();
    const registering = register(["app/acme"], t);

    // Wait for the generator to be running, held at its gate.
    const deadline = Date.now() + 60_000;
    while (!fs.existsSync(path.join(root, "waiting"))) {
      assert.ok(Date.now() < deadline, `the generator never started: ${t.err.join("\n")}`);
      await new Promise((resolve) => setTimeout(resolve, 50));
    }
    assert.equal(await registerLockRows(), 1, "the register lock is not held while the generator runs");
    const lock = JSON.parse(fs.readFileSync(path.join(root, ".mixos", "lock"), "utf8")) as { purpose: string; pid: number };
    assert.match(lock.purpose, /a registration of app\/acme \(npm run register\)/);
    assert.equal(lock.pid, process.pid);

    // A second registration meanwhile is refused by the register lock.
    pend("app", "other");
    const second = terminal();
    assert.equal(await quietly(() => register(["app/other"], second)), 1);
    assert.match(second.err.join("\n"), /holds the register lock/);

    fs.rmSync(path.join(root, "gate"));
    assert.equal(await registering, 0, t.err.join("\n"));
    assert.equal(await registerLockRows(), 0);
    assert.equal(fs.existsSync(path.join(root, ".mixos", "lock")), false);
    assert.ok(fs.existsSync(path.join(root, "apps", "acme", "app.json")));

    const [refused] = await rows("app.register.rejected", "other");
    assert.equal(refused.details.reason, "locked");
  });

  test("its rows name the CLI, with no user id, and read back as unverified", async () => {
    pend("app", "acme");
    assert.equal(await register(["app/acme"]), 0);
    const expected = cli.cliActor().email;
    assert.match(expected, /^cli:[^@]+@[^@]+$/);

    const [row] = await rows("app.register", "acme");
    assert.equal(row.actor_id, null);
    assert.equal(row.actor_email, expected);
    assert.equal(row.target_type, "app");
    assert.equal(row.details.via, "cli");
    assert.equal(row.details.filesHash, filesHash(TREE));
    assert.equal(row.details.installedBy, "admin@example.com");

    const read = (await audit.readAdminAuditLog(50)).find((r) => r.action === "app.register" && r.targetId === "acme");
    assert.equal(read?.actorId, null);
    assert.equal(read?.actorVerified, false);
  });

  test("Discard and recovery are audited the same way", async () => {
    pend("connector", "probe");
    assert.equal(await register(["connector/probe", "--discard"]), 0);
    const [discarded] = await rows("connector.discard", "probe");
    assert.equal(discarded.actor_id, null);
    assert.equal(discarded.actor_email, cli.cliActor().email);

    const where = pendingLocation(root, "app", "orphan");
    fs.mkdirSync(where.folder, { recursive: true });
    assert.equal(await register(["--recover"], terminal([true])), 0);
    const [recovered] = await rows("app.register.recover", "orphan");
    assert.equal(recovered.actor_id, null);
    assert.equal(recovered.details.action, "drop-folder");
  });

  test("an admin's row reads as verified, and the release step's as unverified", async () => {
    const [user] = await sql`
      insert into public.users (email, display_name, is_admin)
      values (${`admin-${run}@mos.test`}, 'Admin', true)
      returning id, email
    `;
    await audit.recordAdminAction({ id: user.id, email: user.email }, { action: "test.admin", targetType: "app", targetId: run });
    await sql`
      insert into public.admin_audit_log (actor_id, actor_email, action, target_type, target_id)
      values (null, 'release-step', 'test.release', 'app', ${run})
    `;
    const read = (await audit.readAdminAuditLog(50)).filter((r) => r.targetId === run);
    assert.deepEqual(
      read.map((r) => [r.action, r.actorVerified]).sort(),
      [
        ["test.admin", true],
        ["test.release", false],
      ],
    );
  });
});
