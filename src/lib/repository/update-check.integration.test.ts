/* This Source Code Form is subject to the terms of the Mozilla Public
 * License, v. 2.0. If a copy of the MPL was not distributed with this
 * file, You can obtain one at https://mozilla.org/MPL/2.0/. */

/**
 * The update check against a real Postgres and a catalogue on this machine
 * that answers `POST /api/v1/updates` as mixos.org does: the switch, the
 * instance ID, what is sent, the stored answer, the schedule, a failure with
 * Retry-After, and the lock.
 *
 * Skipped unless MIXOS_TEST_DATABASE_URL names a server this may create and
 * drop a database on. The database's name ends in this run's own suffix, and
 * it is dropped when the run finishes:
 *
 *   docker run -d --name updates -e POSTGRES_PASSWORD=pw -p 127.0.0.1:55432:5432 postgres:17
 *   MIXOS_TEST_DATABASE_URL=postgres://postgres:pw@127.0.0.1:55432/postgres \
 *     npx tsx --test src/lib/repository/update-check.integration.test.ts
 */

import { after, before, describe, test } from "node:test";
import assert from "node:assert/strict";
import { randomBytes } from "node:crypto";
import http from "node:http";
import type net from "node:net";
import path from "node:path";
import postgres, { type Sql } from "postgres";
import { migratePlatform } from "../../../scripts/platform-migrations";
import type { RegistryInstall } from "./install-record";
import type { ExtensionKind } from "./types";

const REPO = path.resolve(__dirname, "../../..");
const serverUrl = process.env.MIXOS_TEST_DATABASE_URL;
const skip = serverUrl ? false : "set MIXOS_TEST_DATABASE_URL to run against a real Postgres";

const run = randomBytes(3).toString("hex");
const database = `mixos_update_check_${run}`;
const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;
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

/** What the catalogue on this machine knows: each listing's state, by kind/slug. */
interface Listing {
  status: string;
  latest: string | null;
  yanked: Record<string, string | null>;
}

/**
 * `POST /api/v1/updates` as mixos.org answers it (src/pages/api/v1/updates.ts
 * and check_updates, migration 0013, on mixos.org): an instance ID that is a
 * UUID, items as an array, malformed items dropped, and an entry for each
 * listing it knows.
 */
function mixosOrg(listings: Record<string, Listing>) {
  const requests: { body: unknown }[] = [];
  let fail: { status: number; headers: Record<string, string> } | null = null;
  const server = http.createServer((req, res) => {
    let raw = "";
    req.on("data", (c: Buffer) => (raw += c.toString("utf8")));
    req.on("end", () => {
      const send = (status: number, body: unknown, headers: Record<string, string> = {}) => {
        res.writeHead(status, { "content-type": "application/json", ...headers });
        res.end(JSON.stringify(body));
      };
      if (req.method !== "POST" || req.url !== "/api/v1/updates") return send(404, { error: { code: "not_found" } });
      let body: { instanceId?: unknown; items?: unknown };
      try {
        body = JSON.parse(raw);
      } catch {
        return send(400, { error: { code: "bad_request", message: "Body must be valid JSON." } });
      }
      requests.push({ body });
      if (fail) return send(fail.status, { error: { code: "service_unavailable" } }, fail.headers);
      if (typeof body.instanceId !== "string" || !UUID.test(body.instanceId)) {
        return send(400, { error: { code: "bad_request", message: "instanceId must be a UUID." } });
      }
      if (!Array.isArray(body.items)) return send(400, { error: { code: "bad_request" } });
      const items = (body.items as { kind?: string; slug?: string; version?: string }[])
        .filter((i) => ["app", "connector", "theme"].includes(i?.kind ?? "") && i.slug && i.version)
        .flatMap((i) => {
          const listing = listings[`${i.kind}/${i.slug}`];
          if (!listing) return [];
          const yanked = Object.hasOwn(listing.yanked, i.version!);
          return [
            {
              kind: i.kind,
              slug: i.slug,
              listingStatus: listing.status,
              installedVersion: i.version,
              installedYanked: yanked,
              installedYankedReason: yanked ? listing.yanked[i.version!] : null,
              latestVersion: listing.latest,
              latestGitTag: listing.latest ? `v${listing.latest}` : null,
              latestCommitSha: listing.latest ? "9f2b4c1d8e7b6a5f4e3d2c1b0a9f8e7d6c5b4a39" : null,
              latestContentHash: null,
              latestReleasedAt: listing.latest ? "2026-10-02T12:00:00+00:00" : null,
              latestRequiresMixOS: null,
              differsFromInstalled: listing.latest !== null && listing.latest !== i.version,
              tarballUrl: null,
            },
          ];
        });
      send(200, { checkedAt: new Date().toISOString(), items });
    });
  });
  return {
    server,
    requests,
    failWith(status: number, headers: Record<string, string> = {}) {
      fail = { status, headers };
    },
    recover() {
      fail = null;
    },
  };
}

describe("the update check", { skip }, () => {
  let admin: Sql;
  let sql: Sql;
  let platformSql: Sql;
  let check: typeof import("./update-check");
  let origin: string;
  const site = mixosOrg({
    "app/files": { status: "published", latest: "1.2.1", yanked: { "1.2.0": "Data loss\non upgrade from 1.0.x" } },
    "connector/relay": { status: "published", latest: "2.1.0", yanked: {} },
    "theme/dusk": { status: "archived", latest: "1.0.0", yanked: {} },
  });

  const install = (kind: ExtensionKind, slug: string, version: string, source = origin): RegistryInstall => ({
    kind,
    slug,
    version,
    gitTag: null,
    commitSha: "a".repeat(40),
    source,
    repository: { owner: "acme", name: `mixos-${slug}`, subpath: null },
    requiresMixOS: null,
    modified: false,
  });

  async function setting(key: string): Promise<string | null> {
    const [row] = await sql`select value from public.platform_settings where key = ${key}`;
    return (row?.value as string | undefined) ?? null;
  }

  before(async () => {
    admin = postgres(serverUrl!, { max: 1, onnotice: () => {} });
    await admin.unsafe(`create database ${database}`);
    const u = new URL(serverUrl!);
    u.pathname = `/${database}`;
    sql = postgres(u.toString(), { max: 2, onnotice: () => {} });
    await quietly(() => migratePlatform(sql, path.join(REPO, "supabase", "migrations")));

    await new Promise<void>((resolve) => site.server.listen(0, "127.0.0.1", resolve));
    origin = `http://127.0.0.1:${(site.server.address() as net.AddressInfo).port}`;

    // The platform's own pool reads these on its first query.
    process.env.DATABASE_URL = u.toString();
    process.env.PGSSLMODE = u.searchParams.get("sslmode") ?? "disable";
    process.env.MIXOS_REPOSITORY_URL = origin;
    delete process.env.MIXOS_UPDATE_CHECK;
    check = await import("./update-check");
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

  test("off: nothing is sent, and no instance ID is created", async () => {
    process.env.MIXOS_UPDATE_CHECK = "false";
    try {
      const outcome = await check.runUpdateCheck({ installs: [install("app", "files", "1.2.0")], now: at(0) });
      assert.equal(outcome, "off");
    } finally {
      delete process.env.MIXOS_UPDATE_CHECK;
    }
    assert.equal(site.requests.length, 0);
    assert.equal(await setting(check.INSTANCE_ID_KEY), null);
    assert.equal(await setting(check.UPDATE_CHECK_KEY), null);
  });

  test("nothing from this catalogue: nothing is sent, and no instance ID is created", async () => {
    for (const installs of [[], [install("app", "notes", "1.0.0", "http://localhost:4321")]]) {
      assert.equal(await check.runUpdateCheck({ installs, now: at(0) }), "nothing-installed");
    }
    assert.equal(site.requests.length, 0);
    assert.equal(await setting(check.INSTANCE_ID_KEY), null);
  });

  const installs = () => [
    install("app", "files", "1.2.0"),
    install("connector", "relay", "2.0.0"),
    install("app", "notes", "1.0.0", "http://localhost:4321"),
  ];

  test("the first check creates the ID, sends exactly the items from this catalogue, and keeps the answer", async () => {
    const outcome = await check.runUpdateCheck({ installs: installs(), now: at(0), random: () => 0 });
    assert.equal(outcome, "checked");

    assert.equal(site.requests.length, 1);
    const id = await setting(check.INSTANCE_ID_KEY);
    assert.match(id ?? "", UUID);
    assert.deepEqual(site.requests[0].body, {
      instanceId: id,
      items: [
        { kind: "app", slug: "files", version: "1.2.0" },
        { kind: "connector", slug: "relay", version: "2.0.0" },
      ],
    });

    const state = JSON.parse((await setting(check.UPDATE_CHECK_KEY)) ?? "null");
    assert.deepEqual(state.sent, [
      { kind: "app", slug: "files", version: "1.2.0" },
      { kind: "connector", slug: "relay", version: "2.0.0" },
    ]);
    assert.deepEqual(
      state.results.map((r: { slug: string; withdrawn: boolean; reason: string | null; latest: string | null }) => [
        r.slug,
        r.withdrawn,
        r.reason,
        r.latest,
      ]),
      [
        ["files", true, "Data loss on upgrade from 1.0.x", "1.2.1"],
        ["relay", false, null, "2.1.0"],
      ],
    );
    assert.equal(state.lastSuccessAt, T0.toISOString());
    assert.equal(state.lastAttemptAt, T0.toISOString());
    assert.equal(state.lastError, null);
    assert.equal(state.nextCheckAt, new Date(T0.getTime() + 21 * HOUR).toISOString());
    assert.deepEqual(await check.readUpdateCheckState(), state);
  });

  test("not due: nothing is sent", async () => {
    assert.equal(await check.runUpdateCheck({ installs: installs(), now: at(5 * 60_000) }), "not-due");
    assert.equal(await check.runUpdateCheck({ installs: installs(), now: at(20 * HOUR) }), "not-due");
    assert.equal(site.requests.length, 1);
  });

  test("a changed installed set is checked at once, with the same ID", async () => {
    const id = await setting(check.INSTANCE_ID_KEY);
    const changed = [...installs(), install("theme", "dusk", "1.0.0")];
    assert.equal(await check.runUpdateCheck({ installs: changed, now: at(HOUR), random: () => 0 }), "checked");
    assert.equal(site.requests.length, 2);
    assert.deepEqual(site.requests[1].body, {
      instanceId: id,
      items: [
        { kind: "app", slug: "files", version: "1.2.0" },
        { kind: "connector", slug: "relay", version: "2.0.0" },
        { kind: "theme", slug: "dusk", version: "1.0.0" },
      ],
    });
    const state = await check.readUpdateCheckState();
    assert.equal(state?.results.find((r) => r.slug === "dusk")?.listing, "archived");
  });

  test("a failure keeps the last answer, and waits for Retry-After", async () => {
    const changed = [...installs(), install("theme", "dusk", "1.0.0")];
    const before = await check.readUpdateCheckState();
    site.failWith(503, { "retry-after": "7200" });
    const warn = console.warn;
    console.warn = () => {};
    try {
      // Due 21 hours after the last success, at T0 + 1 hour.
      assert.equal(await check.runUpdateCheck({ installs: changed, now: at(23 * HOUR) }), "failed");
    } finally {
      console.warn = warn;
    }
    assert.equal(site.requests.length, 3);
    const failed = await check.readUpdateCheckState();
    assert.deepEqual(failed?.results, before?.results);
    assert.deepEqual(failed?.sent, before?.sent);
    assert.equal(failed?.lastSuccessAt, before?.lastSuccessAt);
    assert.equal(failed?.lastAttemptAt, new Date(T0.getTime() + 23 * HOUR).toISOString());
    assert.match(failed?.lastError ?? "", /answered 503/);
    assert.equal(failed?.nextCheckAt, new Date(T0.getTime() + 25 * HOUR).toISOString());

    // Not before the catalogue said, even with the set changed.
    site.recover();
    const shrunk = [install("app", "files", "1.2.0")];
    assert.equal(await check.runUpdateCheck({ installs: shrunk, now: at(24 * HOUR) }), "not-due");
    assert.equal(site.requests.length, 3);
    assert.equal(await check.runUpdateCheck({ installs: shrunk, now: at(25 * HOUR), random: () => 0 }), "checked");
    assert.equal(site.requests.length, 4);
    const recovered = await check.readUpdateCheckState();
    assert.equal(recovered?.lastError, null);
    assert.deepEqual(recovered?.sent, [{ kind: "app", slug: "files", version: "1.2.0" }]);
  });

  test("another tick holding the lock: busy, and nothing is sent", async () => {
    await sql`
      insert into public._platform_locks (name, holder, acquired_at)
      values ('repository.update-check', 'another-tick', now())
    `;
    try {
      assert.equal(
        await check.runUpdateCheck({ installs: installs(), now: at(30 * HOUR) }),
        "busy",
      );
    } finally {
      await sql`delete from public._platform_locks where name = 'repository.update-check'`;
    }
    assert.equal(site.requests.length, 4);
  });

  test("an instance ID that isn't a UUID is replaced, and the new one sent", async () => {
    await sql`update public.platform_settings set value = 'not-a-uuid' where key = ${check.INSTANCE_ID_KEY}`;
    assert.equal(await check.runUpdateCheck({ installs: installs(), now: at(30 * HOUR) }), "checked");
    const id = await setting(check.INSTANCE_ID_KEY);
    assert.match(id ?? "", UUID);
    assert.equal((site.requests.at(-1)?.body as { instanceId: string }).instanceId, id);
  });
});
