/* This Source Code Form is subject to the terms of the Mozilla Public
 * License, v. 2.0. If a copy of the MPL was not distributed with this
 * file, You can obtain one at https://mozilla.org/MPL/2.0/. */

/**
 * The release check against a real Postgres and a catalogue on this machine
 * that answers `GET /api/v1/mixos/releases` as mixos.org does: the switch, what
 * is sent, the stored answer, that it writes nothing else, the channel, the
 * schedule, a failure with Retry-After, and the lock.
 *
 * Skipped unless MIXOS_TEST_DATABASE_URL names a server this may create and
 * drop a database on. The database's name ends in this run's own suffix, and
 * it is dropped when the run finishes:
 *
 *   docker run -d --name releases -e POSTGRES_PASSWORD=pw -p 127.0.0.1:55432:5432 postgres:17
 *   MIXOS_TEST_DATABASE_URL=postgres://postgres:pw@127.0.0.1:55432/postgres \
 *     npx tsx --test src/lib/platform/release-check.integration.test.ts
 */

import { after, before, describe, test } from "node:test";
import assert from "node:assert/strict";
import { randomBytes } from "node:crypto";
import http from "node:http";
import type net from "node:net";
import path from "node:path";
import postgres, { type Sql } from "postgres";
import { migratePlatform } from "../../../scripts/platform-migrations";
import { mixosVersion } from "./version";

const REPO = path.resolve(__dirname, "../../..");
const serverUrl = process.env.MIXOS_TEST_DATABASE_URL;
const skip = serverUrl ? false : "set MIXOS_TEST_DATABASE_URL to run against a real Postgres";

const run = randomBytes(3).toString("hex");
const database = `mixos_release_check_${run}`;
const HOUR = 3_600_000;
const T0 = new Date("2026-10-05T12:00:00Z");
const at = (ms: number) => () => new Date(T0.getTime() + ms);

/** The runner reports every migration; the tests read the database instead. */
async function quietly<T>(fn: () => Promise<T>): Promise<T> {
  const log = console.log;
  console.log = () => {};
  try {
    return await fn();
  } finally {
    console.log = log;
  }
}

/** Run `fn` with console.warn and console.log silenced, returning what they were given. */
async function hushed<T>(fn: () => Promise<T>): Promise<{ result: T; lines: string[] }> {
  const lines: string[] = [];
  const warn = console.warn;
  const log = console.log;
  console.warn = (...args: unknown[]) => void lines.push(args.join(" "));
  console.log = (...args: unknown[]) => void lines.push(args.join(" "));
  try {
    return { result: await fn(), lines };
  } finally {
    console.warn = warn;
    console.log = log;
  }
}

const release = (tag: string, over: Record<string, unknown> = {}) => ({
  tag,
  commitSha: "9f2b4c1d8e7b6a5f4e3d2c1b0a9f8e7d6c5b4a39",
  publishedAt: "2026-10-01T09:00:00Z",
  prerelease: tag.includes("-"),
  notes: `### Fixes\n\n- the notes for ${tag}`,
  ...over,
});

/** `GET /api/v1/mixos/releases` as mixos.org answers it, with the list it is given. */
function mixosOrg() {
  const requests: { method: string; url: string; headers: http.IncomingHttpHeaders; body: string }[] = [];
  let list: unknown[] = [];
  let fail: { status: number; headers: Record<string, string> } | null = null;
  const server = http.createServer((req, res) => {
    let body = "";
    req.on("data", (c: Buffer) => (body += c.toString("utf8")));
    req.on("end", () => {
      const send = (status: number, payload: unknown, headers: Record<string, string> = {}) => {
        res.writeHead(status, { "content-type": "application/json", ...headers });
        res.end(JSON.stringify(payload));
      };
      requests.push({ method: req.method ?? "", url: req.url ?? "", headers: req.headers, body });
      if (req.url !== "/api/v1/mixos/releases") return send(404, { error: { code: "not_found" } });
      if (fail) return send(fail.status, { error: { code: "service_unavailable" } }, fail.headers);
      send(200, { releases: list });
    });
  });
  return {
    server,
    requests,
    serve(releases: unknown[]) {
      list = releases;
    },
    failWith(status: number, headers: Record<string, string> = {}) {
      fail = { status, headers };
    },
    recover() {
      fail = null;
    },
  };
}

describe("the release check", { skip }, () => {
  let admin: Sql;
  let sql: Sql;
  let platformSql: Sql;
  let check: typeof import("./release-check");
  const site = mixosOrg();

  async function stored(): Promise<Record<string, unknown> | null> {
    const [row] = await sql`select value from public.platform_settings where key = 'mixos_release_check'`;
    return row ? (JSON.parse(row.value as string) as Record<string, unknown>) : null;
  }

  /**
   * Every row of every table in the database, as text, by table: what "writes
   * nothing else" is checked against. The schemas Postgres keeps for itself
   * are left out.
   */
  async function everything(): Promise<Map<string, string[]>> {
    const tables = await sql<{ schema: string; name: string }[]>`
      select table_schema as schema, table_name as name
      from information_schema.tables
      where table_type = 'BASE TABLE'
        and table_schema not in ('pg_catalog', 'information_schema')
        and table_schema not like 'pg_toast%'
      order by 1, 2`;
    const out = new Map<string, string[]>();
    for (const { schema, name } of tables) {
      const rows = await sql.unsafe(`select t::text as row from "${schema}"."${name}" t order by 1`);
      out.set(`${schema}.${name}`, rows.map((r) => r.row as string));
    }
    return out;
  }

  before(async () => {
    admin = postgres(serverUrl!, { max: 1, onnotice: () => {} });
    await admin.unsafe(`create database ${database}`);
    const u = new URL(serverUrl!);
    u.pathname = `/${database}`;
    sql = postgres(u.toString(), { max: 2, onnotice: () => {} });
    await quietly(() => migratePlatform(sql, path.join(REPO, "supabase", "migrations")));

    await new Promise<void>((resolve) => site.server.listen(0, "127.0.0.1", resolve));
    const origin = `http://127.0.0.1:${(site.server.address() as net.AddressInfo).port}`;

    // The platform's own pool reads these on its first query.
    process.env.DATABASE_URL = u.toString();
    process.env.PGSSLMODE = u.searchParams.get("sslmode") ?? "disable";
    process.env.MIXOS_REPOSITORY_URL = origin;
    delete process.env.MIXOS_UPDATE_CHECK;
    delete process.env.MIXOS_RELEASE_CHANNEL;
    check = await import("./release-check");
    platformSql = (await import("@/lib/db/client")).sql;
  });

  after(async () => {
    site.server.closeAllConnections();
    site.server.close();
    await platformSql?.end();
    await sql?.end();
    if (admin) {
      await admin.unsafe(`drop database if exists ${database} with (force)`);
      await admin.end();
    }
  });

  const LIST = [
    release("v999.1.0-rc.1"),
    release("v999.0.0"),
    release("v0.1.0"),
    // Malformed, each a different way: left out, and the rest kept.
    release("v1000.0.0 "),
    release("v1001.0.0", { commitSha: "nope" }),
    release("v1002.0.0", { notes: "x".repeat(20 * 1024 + 1) }),
    { tag: "v1003.0.0" },
  ];

  test("off: nothing is sent, and nothing is written", async () => {
    site.serve(LIST);
    process.env.MIXOS_UPDATE_CHECK = "false";
    try {
      assert.equal(await check.runReleaseCheck({ now: at(0) }), "off");
    } finally {
      delete process.env.MIXOS_UPDATE_CHECK;
    }
    assert.equal(site.requests.length, 0);
    assert.equal(await stored(), null);
  });

  test("the first check: one anonymous GET, the newest stable release kept, and nothing else written", async () => {
    const before = await everything();
    const { result, lines } = await hushed(() => check.runReleaseCheck({ now: at(0), random: () => 0 }));
    assert.equal(result, "checked");
    const afterwards = await everything();

    assert.equal(site.requests.length, 1);
    const [request] = site.requests;
    assert.equal(request.method, "GET");
    assert.equal(request.url, "/api/v1/mixos/releases");
    assert.equal(request.headers["user-agent"], "MixOS");
    assert.equal(request.body, "");
    assert.equal(request.headers.cookie, undefined);

    const state = await stored();
    assert.equal(state?.channel, "stable");
    assert.equal((state?.latest as { tag: string } | null)?.tag, "v999.0.0");
    assert.equal(state?.lastSuccessAt, T0.toISOString());
    assert.equal(state?.lastError, null);
    assert.equal(state?.nextCheckAt, new Date(T0.getTime() + 21 * HOUR).toISOString());
    assert.deepEqual(await check.readReleaseCheckState(), state);

    // Its own row, and nothing else: no other setting, no other table, no lock left.
    for (const [table, rows] of afterwards) {
      const was = before.get(table) ?? [];
      if (table !== "public.platform_settings") {
        assert.deepEqual(rows, was, `${table} changed`);
        continue;
      }
      const added = rows.filter((r) => !was.includes(r));
      const removed = was.filter((r) => !rows.includes(r));
      assert.deepEqual(removed, [], "no setting removed");
      assert.equal(added.length, 1, "one setting written");
      assert.match(added[0], /^\(mixos_release_check,/);
    }
    assert.deepEqual([...afterwards.keys()], [...before.keys()], "no table created or dropped");
    assert.deepEqual(afterwards.get("public._platform_locks"), []);

    // The malformed entries were counted, and a newer release logged.
    assert.ok(lines.some((l) => /Left out 4 of the 7 releases on the list/.test(l)), lines.join("\n"));
    assert.ok(
      lines.some((l) => l === `[release-check] MixOS 999.0.0 is available (this instance runs ${mixosVersion()}). A major release: it may need changes.`),
      lines.join("\n"),
    );
  });

  test("not due: nothing is sent", async () => {
    assert.equal(await check.runReleaseCheck({ now: at(5 * 60_000) }), "not-due");
    assert.equal(await check.runReleaseCheck({ now: at(20 * HOUR) }), "not-due");
    assert.equal(site.requests.length, 1);
  });

  test("what the admin pages show: the notice against this build, and the line", async () => {
    const view = await check.releaseCheckView(new Date(T0.getTime() + 3 * HOUR));
    assert.equal(view.notice?.text, `MixOS 999.0.0 is available (this instance runs ${mixosVersion()}). A major release: it may need changes.`);
    assert.equal(view.notice?.releaseUrl, "https://mixos.org/docs/releases/v999.0.0");
    assert.match(view.status ?? "", /^Checked 127\.0\.0\.1:\d+ for new releases 3 hours ago\.$/);

    process.env.MIXOS_UPDATE_CHECK = "false";
    try {
      const off = await check.releaseCheckView(new Date(T0.getTime() + 3 * HOUR));
      assert.deepEqual(off, { notice: null, status: "Release checks are off (MIXOS_UPDATE_CHECK)." });
    } finally {
      delete process.env.MIXOS_UPDATE_CHECK;
    }
  });

  test("a changed channel is checked at once, and the prerelease kept", async () => {
    process.env.MIXOS_RELEASE_CHANNEL = "prerelease";
    try {
      assert.equal(await hushed(() => check.runReleaseCheck({ now: at(HOUR), random: () => 0 })).then((r) => r.result), "checked");
      assert.equal(site.requests.length, 2);
      const state = await stored();
      assert.equal(state?.channel, "prerelease");
      assert.equal((state?.latest as { tag: string }).tag, "v999.1.0-rc.1");
      const view = await check.releaseCheckView(new Date(T0.getTime() + HOUR));
      assert.match(view.notice?.text ?? "", /^MixOS 999\.1\.0-rc\.1 is available .* It's a prerelease, for trying it before it's final\.$/);
    } finally {
      delete process.env.MIXOS_RELEASE_CHANNEL;
    }
    // Back on stable, the prerelease kept from that check isn't shown…
    assert.equal((await check.releaseCheckView(new Date(T0.getTime() + HOUR))).notice, null);
    // …and the next tick checks again.
    assert.equal(await hushed(() => check.runReleaseCheck({ now: at(2 * HOUR), random: () => 0 })).then((r) => r.result), "checked");
    assert.equal(site.requests.length, 3);
    assert.equal(((await stored())?.latest as { tag: string }).tag, "v999.0.0");
  });

  test("a failure keeps the last answer, and waits for Retry-After", async () => {
    const before = await stored();
    site.failWith(429, { "retry-after": "7200" });
    // Due 21 hours after the last success, at T0 + 2 hours.
    const { result } = await hushed(() => check.runReleaseCheck({ now: at(24 * HOUR) }));
    assert.equal(result, "failed");
    assert.equal(site.requests.length, 4);
    const failed = await stored();
    assert.deepEqual(failed?.latest, before?.latest);
    assert.equal(failed?.channel, before?.channel);
    assert.equal(failed?.lastSuccessAt, before?.lastSuccessAt);
    assert.equal(failed?.lastAttemptAt, new Date(T0.getTime() + 24 * HOUR).toISOString());
    assert.equal(failed?.lastError, "The repository answered 429 for /api/v1/mixos/releases.");
    assert.equal(failed?.nextCheckAt, new Date(T0.getTime() + 26 * HOUR).toISOString());

    // The notice stays, and the line says since when.
    const view = await check.releaseCheckView(new Date(T0.getTime() + 25 * HOUR));
    assert.equal(view.notice?.tag, "v999.0.0");
    const since = new Date(String(failed?.lastSuccessAt)).toLocaleDateString("en-GB", { day: "numeric", month: "short" });
    assert.match(view.status ?? "", new RegExp(`^Couldn't reach 127\\.0\\.0\\.1:\\d+ for new releases since ${since}\\.$`));

    // Not before the catalogue said, even with the channel changed.
    site.recover();
    process.env.MIXOS_RELEASE_CHANNEL = "prerelease";
    try {
      assert.equal(await check.runReleaseCheck({ now: at(25 * HOUR) }), "not-due");
    } finally {
      delete process.env.MIXOS_RELEASE_CHANNEL;
    }
    assert.equal(site.requests.length, 4);
    assert.equal(await hushed(() => check.runReleaseCheck({ now: at(26 * HOUR), random: () => 0 })).then((r) => r.result), "checked");
    assert.equal(site.requests.length, 5);
    assert.equal((await stored())?.lastError, null);
  });

  test("a list that isn't one fails the check, and keeps the last answer", async () => {
    const before = await stored();
    site.serve("not a list" as unknown as unknown[]);
    try {
      const { result } = await hushed(() => check.runReleaseCheck({ now: at(48 * HOUR) }));
      assert.equal(result, "failed");
    } finally {
      site.serve(LIST);
    }
    const failed = await stored();
    assert.deepEqual(failed?.latest, before?.latest);
    assert.match(String(failed?.lastError), /did not match the expected shape/);
  });

  test("another tick holding the lock: busy, and nothing is sent", async () => {
    const sent = site.requests.length;
    await sql`
      insert into public._platform_locks (name, holder, acquired_at)
      values ('platform.release-check', 'another-tick', now())
    `;
    try {
      assert.equal(await check.runReleaseCheck({ now: at(72 * HOUR) }), "busy");
    } finally {
      await sql`delete from public._platform_locks where name = 'platform.release-check'`;
    }
    assert.equal(site.requests.length, sent);
  });
});
