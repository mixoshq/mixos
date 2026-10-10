/* This Source Code Form is subject to the terms of the Mozilla Public
 * License, v. 2.0. If a copy of the MPL was not distributed with this
 * file, You can obtain one at https://mozilla.org/MPL/2.0/. */

/**
 * The builder against a real Postgres. Skipped unless MIXOS_TEST_DATABASE_URL
 * names a database it may create and drop `_qbit_*` tables in — never point it
 * at one that matters:
 *
 *   docker run -d --name qbit -e POSTGRES_PASSWORD=pw -p 127.0.0.1:55432:5432 postgres:17
 *   MIXOS_TEST_DATABASE_URL=postgres://postgres:pw@127.0.0.1:55432/postgres \
 *     npx tsx --test src/lib/db/query.integration.test.ts
 *
 * The expected values are what PostgREST returned for the same queries when
 * this builder replaced it, so a failure here is a behaviour change apps would
 * see — not just a different SQL string.
 */

import { after, before, test } from "node:test";
import assert from "node:assert/strict";
import postgres, { type Sql } from "postgres";
import { DbClient } from "./query";

const url = process.env.MIXOS_TEST_DATABASE_URL;
const skip = url ? false : "set MIXOS_TEST_DATABASE_URL to run against a real Postgres";

let sql: Sql;
let db: DbClient;

const U = (n: number) => `00000000-0000-0000-0000-${String(n).padStart(12, "0")}`;
const UA = "00000000-0000-0000-0000-0000000000aa";

before(async () => {
  if (!url) return;
  sql = postgres(url, { prepare: false, max: 2, onnotice: () => {} });
  db = new DbClient(sql);
  await sql.unsafe(`
    drop table if exists _qbit_items, _qbit_pairs;
    create table _qbit_items (
      id          uuid primary key default gen_random_uuid(),
      name        text not null unique,
      qty         integer,
      big         bigint,
      price       numeric(10,2),
      active      boolean not null default true,
      tags        text[],
      meta        jsonb,
      day         date,
      created_at  timestamptz not null default '2026-01-02T03:04:05.678Z',
      note        text default 'dflt'
    );
    create table _qbit_pairs (
      user_id  uuid not null,
      slug     text not null,
      position integer not null default 0,
      pinned   boolean not null default false,
      primary key (user_id, slug)
    );
    insert into _qbit_items (id, name, qty, big, price, active, tags, meta, day, created_at) values
      ('${U(1)}', 'alpha', 1, 9007199254740993, 10.50, true, '{x,y}', '{"k": 1}', '2026-03-04', '2026-05-06T07:08:09.123456Z'),
      ('${U(2)}', 'beta', 2, 2, 0.10, false, '{}', '[1, "two", null]', null, '2026-05-06T07:08:10Z'),
      ('${U(3)}', 'gamma', null, null, null, true, null, null, '2026-12-31', '2026-05-06T07:08:11Z');
    insert into _qbit_pairs (user_id, slug, position) values ('${UA}', 'one', 0), ('${UA}', 'two', 1);
  `);
});

after(async () => {
  if (!url) return;
  await sql.unsafe(`drop table if exists _qbit_items, _qbit_pairs`);
  await sql.end();
});

test("rows arrive with PostgREST's JSON types", { skip }, async () => {
  const { data, error } = await db
    .from("_qbit_items")
    .select("big, price, active, tags, meta, day, created_at")
    .eq("id", U(1))
    .single();

  assert.equal(error, null);
  assert.deepEqual(data, {
    // bigint and numeric are JSON numbers, with JSON's precision — not strings.
    big: 9007199254740992,
    price: 10.5,
    active: true,
    tags: ["x", "y"],
    meta: { k: 1 },
    day: "2026-03-04",
    // An ISO string at full precision, not a Date.
    created_at: "2026-05-06T07:08:09.123456+00:00",
  });
});

test("filter values are cast to the column's type, whatever their JS type", { skip }, async () => {
  const names = async (q: PromiseLike<{ data: { name: string }[] | null }>) =>
    ((await q).data ?? []).map((r) => r.name);

  assert.deepEqual(await names(db.from("_qbit_items").select("name").eq("qty", "2")), ["beta"]);
  assert.deepEqual(await names(db.from("_qbit_items").select("name").eq("qty", 2)), ["beta"]);
  assert.deepEqual(await names(db.from("_qbit_items").select("name").eq("active", false)), ["beta"]);
  assert.deepEqual(await names(db.from("_qbit_items").select("name").eq("active", "false")), ["beta"]);
  assert.deepEqual(
    await names(db.from("_qbit_items").select("name").in("qty", [1, "2", 99]).order("name")),
    ["alpha", "beta"],
  );

  // A timestamp read back out of the database matches itself — microseconds
  // and all, which a JS Date would have truncated.
  const { data } = await db.from("_qbit_items").select("created_at").eq("name", "alpha").single();
  assert.deepEqual(await names(db.from("_qbit_items").select("name").eq("created_at", data.created_at)), [
    "alpha",
  ]);
});

test("ordering, ranges and counts", { skip }, async () => {
  const page = await db
    .from("_qbit_items")
    .select("name", { count: "exact" })
    .order("qty", { ascending: false, nullsFirst: true })
    .range(0, 1);
  assert.deepEqual(page.data, [{ name: "gamma" }, { name: "beta" }]);
  assert.equal(page.count, 3);
});

test("a single object's undefined field takes the default; a batch's missing key is NULL", { skip }, async () => {
  const one = await db
    .from("_qbit_items")
    .insert({ id: U(10), name: "ten", note: undefined })
    .select("note")
    .single();
  assert.deepEqual(one.data, { note: "dflt" });

  const batch = await db
    .from("_qbit_items")
    .insert([
      { id: U(11), name: "eleven", note: "n" },
      { id: U(12), name: "twelve", qty: 12 },
    ])
    .select("name, qty, note");
  assert.deepEqual(batch.data, [
    { name: "eleven", qty: null, note: "n" },
    { name: "twelve", qty: 12, note: null },
  ]);
});

test("upsert merges only the named columns; ignoreDuplicates keeps the stored row", { skip }, async () => {
  const merged = await db
    .from("_qbit_items")
    .upsert({ name: "beta", qty: 22 }, { onConflict: "name" })
    .select("name, qty, price, active");
  assert.deepEqual(merged.data, [{ name: "beta", qty: 22, price: 0.1, active: false }]);

  const kept = await db
    .from("_qbit_pairs")
    .upsert(
      [
        { user_id: UA, slug: "one", position: 9 },
        { user_id: UA, slug: "three", position: 3 },
      ],
      { onConflict: "user_id,slug", ignoreDuplicates: true },
    )
    .select("slug, position");
  assert.deepEqual(kept.data, [{ slug: "three", position: 3 }]);

  // No onConflict: the primary key is the target.
  const byKey = await db
    .from("_qbit_pairs")
    .upsert({ user_id: UA, slug: "two", pinned: true })
    .select("slug, position, pinned");
  assert.deepEqual(byKey.data, [{ slug: "two", position: 1, pinned: true }]);
});

test("a write that breaks single() leaves the table as it was", { skip }, async () => {
  const { error } = await db
    .from("_qbit_pairs")
    .update({ position: 42 })
    .eq("user_id", UA)
    .select("slug")
    .single();
  assert.equal(error?.code, "PGRST116");

  const { data } = await db.from("_qbit_pairs").select("position").eq("position", 42);
  assert.deepEqual(data, []);
});

test("database errors keep their SQLSTATE", { skip }, async () => {
  const duplicate = await db.from("_qbit_items").insert({ name: "alpha" });
  assert.equal(duplicate.error?.code, "23505");

  const badUuid = await db.from("_qbit_items").select("name").eq("id", "not-a-uuid");
  assert.equal(badUuid.error?.code, "22P02");

  const missing = await db.from("_qbit_nope").select("*");
  assert.equal(missing.error?.code, "42P01");
});

test("text round-trips exactly, quotes and all", { skip }, async () => {
  const awkward = "O'Brien \\ \"q\" é 😀 $1 -- ;drop";
  await db.from("_qbit_items").insert({ id: U(20), name: awkward });
  const { data } = await db.from("_qbit_items").select("name").eq("name", awkward).single();
  assert.equal(data.name, awkward);
});
