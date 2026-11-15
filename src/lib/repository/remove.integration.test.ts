/* This Source Code Form is subject to the terms of the Mozilla Public
 * License, v. 2.0. If a copy of the MPL was not distributed with this
 * file, You can obtain one at https://mozilla.org/MPL/2.0/. */

/**
 * `npm run remove` against a real Postgres: the register lock is a real row in
 * `_platform_locks`, held with the checkout lock for the whole of a removal;
 * the applied theme is read from `platform_settings`; every row it audits names
 * the CLI, with no user id; and removing an extension's code changes nothing
 * in the database but the audit log, so an app's row, its identity included,
 * is kept for the release step to mark.
 *
 * Skipped unless MIXOS_TEST_DATABASE_URL names a server this may create and
 * drop a database on, as register.integration.test.ts is:
 *
 *   docker run -d --name remove -e POSTGRES_PASSWORD=pw -p 127.0.0.1:55432:5432 postgres:17
 *   MIXOS_TEST_DATABASE_URL=postgres://postgres:pw@127.0.0.1:55432/postgres \
 *     npx tsx --test src/lib/repository/remove.integration.test.ts
 *
 * The checkout is a temporary folder, and the registry generator a stand-in
 * that can be held mid-run.
 */

import { after, before, beforeEach, describe, test } from "node:test";
import assert from "node:assert/strict";
import { randomBytes } from "node:crypto";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import postgres, { type Sql } from "postgres";
import { migratePlatform } from "../../../scripts/platform-migrations";
import { backupLocation, writeBackupRecord } from "./backup";

const REPO = path.resolve(__dirname, "../../..");
const serverUrl = process.env.MIXOS_TEST_DATABASE_URL;
const skip = serverUrl ? false : "set MIXOS_TEST_DATABASE_URL to run against a real Postgres";

const run = randomBytes(3).toString("hex");
const database = `mixos_remove_${run}`;

const tmp = fs.realpathSync(fs.mkdtempSync(path.join(os.tmpdir(), "mixos-remove-db-")));

/**
 * The stand-in generator. While a file named `gate` is in the checkout it says
 * what it sees, in `waiting`, and waits; then it registers every folder in
 * apps/, connectors/ and themes/ but the one it is told to leave out,
 * `--without <kind>/<slug>`.
 */
const STAND_IN = path.join(tmp, "stand-in.mjs");
fs.writeFileSync(
  STAND_IN,
  `import fs from "node:fs";
const cell = new Int32Array(new SharedArrayBuffer(4));
const args = process.argv.slice(2);
const without = args.includes("--without") ? args[args.indexOf("--without") + 1] : null;
const list = (dir) => (fs.existsSync(dir) ? fs.readdirSync(dir).filter((n) => !n.startsWith(".") && !n.endsWith(".json")).sort() : []);
const listed = (dir) => list(dir).filter((name) => !(without && without.split("/")[0] + "s" === dir && without.split("/")[1] === name));
if (fs.existsSync("gate")) {
  fs.writeFileSync("waiting", JSON.stringify({ apps: list("apps"), backup: list(".mixos/backup/apps"), without }));
  while (fs.existsSync("gate")) Atomics.wait(cell, 0, 0, 50);
}
fs.mkdirSync("src/generated", { recursive: true });
fs.writeFileSync("src/generated/app-registry.ts", JSON.stringify(listed("apps").map((slug) => ({ slug })), null, 2));
fs.writeFileSync("src/generated/connector-registry.ts", JSON.stringify(listed("connectors").map((name) => ({ name })), null, 2));
fs.writeFileSync("src/generated/theme-registry.ts", JSON.stringify(listed("themes").map((slug) => ({ slug })), null, 2));
`,
);

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

describe("npm run remove, against a real Postgres", { skip }, () => {
  let admin: Sql;
  let sql: Sql;
  let root: string;
  let n = 0;
  let cli: typeof import("../../../scripts/remove-cli");
  let register: typeof import("../../../scripts/register-cli");
  let audit: typeof import("../apps/admin-audit");
  let platformSql: Sql;

  const write = (rel: string, data: string) => {
    fs.mkdirSync(path.dirname(path.join(root, rel)), { recursive: true });
    fs.writeFileSync(path.join(root, rel), data);
  };

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

  /** `npm run remove -- <args>` in the test's checkout, answering yes, as this machine's OS user. */
  const remove = (args: string[], t = terminal([true, true])) => cli.runCli(args, { root, io: t.io, generator: STAND_IN });

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

    // The platform's own pool, which the register lock, the applied theme and
    // the audit use, reads these on its first query.
    process.env.DATABASE_URL = u.toString();
    process.env.PGSSLMODE = u.searchParams.get("sslmode") ?? "disable";
    cli = await import("../../../scripts/remove-cli");
    register = await import("../../../scripts/register-cli");
    audit = await import("../apps/admin-audit");
    platformSql = (await import("@/lib/db/client")).sql;
  });

  beforeEach(() => {
    root = path.join(tmp, `checkout-${n++}`);
    for (const dir of ["apps", "connectors", "themes"]) fs.mkdirSync(path.join(root, dir), { recursive: true });
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

  test("a removal holds both locks while the generator runs without it, its folder still in place, and releases both", async () => {
    write("apps/acme/app.json", '{"name":"Acme"}');
    write("apps/other/app.json", '{"name":"Other"}');
    fs.writeFileSync(path.join(root, "gate"), "");
    const t = terminal([true]);
    const removing = remove(["app/acme"], t);

    const deadline = Date.now() + 60_000;
    while (!fs.existsSync(path.join(root, "waiting"))) {
      assert.ok(Date.now() < deadline, `the generator never started: ${t.err.join("\n")}`);
      await new Promise((resolve) => setTimeout(resolve, 50));
    }
    assert.deepEqual(JSON.parse(fs.readFileSync(path.join(root, "waiting"), "utf8")), {
      apps: ["acme", "other"],
      backup: [],
      without: "app/acme",
    });
    assert.equal(await registerLockRows(), 1, "the register lock is not held while the generator runs");
    const lock = JSON.parse(fs.readFileSync(path.join(root, ".mixos", "lock"), "utf8")) as { purpose: string; pid: number };
    assert.match(lock.purpose, /a removal of app\/acme \(npm run remove\)/);

    // Another removal meanwhile is refused by the register lock.
    const second = terminal([true]);
    assert.equal(await quietly(() => remove(["app/other"], second)), 1);
    assert.match(second.err.join("\n"), /holds the register lock/);

    fs.rmSync(path.join(root, "gate"));
    assert.equal(await removing, 0, t.err.join("\n"));
    assert.equal(await registerLockRows(), 0);
    assert.equal(fs.existsSync(path.join(root, ".mixos", "lock")), false);
    assert.equal(fs.existsSync(path.join(root, "apps", "acme")), false);
    assert.equal(fs.existsSync(path.join(root, ".mixos", "backup", "apps", "acme")), false);

    const [refused] = await rows("app.remove.rejected", "other");
    assert.equal(refused.details.reason, "locked");
  });

  test("its rows name the CLI, with no user id, and read back as unverified", async () => {
    write("apps/acme/app.json", '{"name":"Acme"}');
    assert.equal(await remove(["app/acme"]), 0);
    const [row] = await rows("app.remove", "acme");
    assert.equal(row.actor_id, null);
    assert.equal(row.actor_email, register.cliActor().email);
    assert.equal(row.target_type, "app");
    assert.equal(row.details.via, "cli");
    assert.equal(row.details.path, "apps/acme");
    assert.equal(row.details.local, true);
    const read = (await audit.readAdminAuditLog(100)).find((r) => r.action === "app.remove" && r.targetId === "acme");
    assert.equal(read?.actorVerified, false);
  });

  test("changes nothing in the database but the audit log: the app's row and its identity are kept", async () => {
    await sql`
      insert into public.apps (slug, name, is_active, identity, code_hash)
      values ('kept', 'Kept', true, 'local', 'sha256-before')
    `;
    const before = await sql`select * from public.apps where slug = 'kept'`;
    write("apps/kept/app.json", '{"name":"Kept"}');
    assert.equal(await remove(["app/kept"]), 0);
    assert.deepEqual(await sql`select * from public.apps where slug = 'kept'`, before);
  });

  test("the applied theme is read from platform_settings, and the refusals are audited", async () => {
    write("themes/aurora/theme.json", '{"name":"Aurora"}');
    write("themes/dusk/theme.json", '{"name":"Dusk"}');
    await sql`
      insert into public.platform_settings (key, value) values ('theme', 'dusk')
      on conflict (key) do update set value = excluded.value
    `;
    const t = terminal([true]);
    assert.equal(await remove(["theme/dusk"], t), 0, t.err.join("\n"));
    assert.match(t.out.join("\n"), /Note: It is the applied theme in this checkout's database, so pages here use Aurora/);
    const [row] = await rows("theme.remove", "dusk");
    assert.equal(row.details.appliedTheme, true);

    // The last theme.
    assert.equal(await quietly(() => remove(["theme/aurora"])), 1);
    // A connector an app requires, asked for by the button's path.
    write("connectors/probe/connector.json", '{"name":"probe","displayName":"Probe"}');
    write("apps/mailer/app.json", '{"name":"Mailer","connectors":[{"name":"probe","version":"1.0.0"}]}');
    const removal = await import("./remove");
    await assert.rejects(
      removal.removeExtension("connector", "probe", { actor: register.cliActor(), via: "cli", root, generator: STAND_IN }),
      (err: unknown) => err instanceof removal.RemoveError && err.code === "depended-on",
    );
    const [refused] = await rows("connector.remove.rejected", "probe");
    assert.equal(refused.details.reason, "depended-on");
  });

  test("recovering a removal that stopped midway is audited as the removal's", async () => {
    write("apps/acme/app.json", '{"name":"Acme"}');
    const where = backupLocation(root, "app", "acme");
    writeBackupRecord(where.record, {
      operation: "remove",
      kind: "app",
      slug: "acme",
      token: "a-removal-that-stopped-0001",
      pid: 999999,
      hostname: os.hostname(),
      startedAt: "2026-10-11T09:00:00.000Z",
    });
    fs.renameSync(path.join(root, "apps", "acme"), where.folder);
    assert.equal(await remove(["--recover"]), 0);
    assert.ok(fs.existsSync(path.join(root, "apps", "acme", "app.json")));
    const [recovered] = await rows("app.remove.recover", "acme");
    assert.equal(recovered.actor_id, null);
    assert.equal(recovered.details.action, "restore-backup");
  });
});
