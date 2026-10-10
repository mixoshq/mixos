/* This Source Code Form is subject to the terms of the Mozilla Public
 * License, v. 2.0. If a copy of the MPL was not distributed with this
 * file, You can obtain one at https://mozilla.org/MPL/2.0/. */

import { test } from "node:test";
import assert from "node:assert/strict";
import type { Sql } from "postgres";
import { DbClient } from "./query";

// ── fixtures ────────────────────────────────────────────────────────────────

interface Call {
  text: string;
  params: unknown[];
}

/**
 * A stand-in for the postgres.js pool that records every statement and answers
 * from `respond`. Enough to pin the SQL the builder emits and how it treats
 * results and errors, with no database. Behaviour against a real Postgres is
 * the job of query.integration.test.ts.
 */
function fakeSql(respond: (call: Call) => unknown[] | Error = () => []) {
  const calls: Call[] = [];
  const stats = { began: 0, rolledBack: 0 };
  const unsafe = async (text: string, params: unknown[] = []) => {
    const call = { text, params };
    calls.push(call);
    const out = respond(call);
    if (out instanceof Error) throw out;
    return out;
  };
  const sql = {
    unsafe,
    async begin(fn: (tx: unknown) => Promise<unknown>) {
      stats.began++;
      try {
        return await fn({ unsafe });
      } catch (err) {
        stats.rolledBack++;
        throw err;
      }
    },
  };
  return { db: new DbClient(sql as unknown as Sql), calls, stats };
}

const rows = (...values: object[]) => values.map((v) => ({ _r: v }));

// ── reads ───────────────────────────────────────────────────────────────────

test("a filtered read is one statement, with each value typed by its column", async () => {
  const { db, calls } = fakeSql(() => rows({ id: "u1" }));
  const { data, error } = await db.from("users").select("id").eq("email", "a@example.com");

  assert.equal(error, null);
  assert.deepEqual(data, [{ id: "u1" }]);
  assert.equal(calls.length, 1);
  assert.equal(
    calls[0].text,
    `select (select to_json(_p) from (select _t."id" as "id") as _p) as _r ` +
      `from "public"."users" as _t where _t."email" = ` +
      `(select _f."email" from json_populate_record(null::"public"."users", $1::json) as _f)`,
  );
  // An object, not a JSON string: postgres.js serializes a ::json parameter
  // itself, and a pre-stringified one would be encoded twice.
  assert.deepEqual(calls[0].params, [{ email: "a@example.com" }]);
});

test("select * serializes the whole row, and order/limit/range compile in place", async () => {
  const { db, calls } = fakeSql();
  await db
    .from("apps")
    .select("*")
    .order("position", { ascending: true })
    .order("slug", { ascending: false, nullsFirst: true })
    .range(10, 19);

  assert.equal(
    calls[0].text,
    `select to_json(_t) as _r from "public"."apps" as _t ` +
      `order by _t."position" asc, _t."slug" desc nulls first limit 10 offset 10`,
  );
});

test("aliases and a star can be mixed in a select list", async () => {
  const { db, calls } = fakeSql();
  await db.from("items").select("*, label:name");
  assert.match(calls[0].text, /\(select _t\.\*, _t\."name" as "label"\) as _p/);
});

test("Dates and bigints are bound as JSON can carry them", async () => {
  const { db, calls } = fakeSql();
  const at = new Date("2026-05-06T07:08:09.123Z");
  await db.from("events").select("id").gte("at", at).eq("big", BigInt("9007199254740993"));
  assert.deepEqual(calls[0].params, [{ at: "2026-05-06T07:08:09.123Z" }, { big: "9007199254740993" }]);
});

test("in() binds one JSON array and keeps an index usable; an empty list matches nothing", async () => {
  const { db, calls } = fakeSql();
  await db.from("apps").select("slug").in("slug", ["a", "b"]);
  assert.match(
    calls[0].text,
    /where _t\."slug" = any\(array\(select _f\."slug" from json_populate_recordset\(null::"public"\."apps", \$1::json\) as _f\)\)$/,
  );
  assert.deepEqual(calls[0].params, [[{ slug: "a" }, { slug: "b" }]]);

  await db.from("apps").select("slug").in("slug", []);
  assert.match(calls[1].text, / where false$/);
  assert.deepEqual(calls[1].params, []);
});

test("like() takes PostgREST's * wildcard, and is() needs no parameter", async () => {
  const { db, calls } = fakeSql();
  await db.from("users").select("id").ilike("email", "*@example.com").is("deleted_at", null);
  assert.match(calls[0].text, /_t\."email" ilike \$1::text and _t\."deleted_at" is null$/);
  assert.deepEqual(calls[0].params, ["%@example.com"]);
});

test("a head count fetches no rows", async () => {
  const { db, calls } = fakeSql(() => [{ count: "3" }]);
  const { data, count, error } = await db
    .from("users")
    .select("id", { count: "exact", head: true })
    .eq("is_admin", true);

  assert.equal(error, null);
  assert.equal(data, null);
  assert.equal(count, 3);
  assert.equal(calls.length, 1);
  assert.match(calls[0].text, /^select count\(\*\) as count from "public"\."users" as _t where /);
});

// ── single / maybeSingle ────────────────────────────────────────────────────

test("single() unwraps one row and reports PGRST116 for zero or several", async () => {
  let answer = rows({ id: 1 });
  const { db } = fakeSql(() => answer);

  const one = await db.from("t").select("id").single();
  assert.deepEqual(one.data, { id: 1 });

  answer = [];
  const none = await db.from("t").select("id").single();
  assert.equal(none.data, null);
  assert.equal(none.error?.code, "PGRST116");
  assert.equal(none.status, 406);

  answer = rows({ id: 1 }, { id: 2 });
  const many = await db.from("t").select("id").single();
  assert.equal(many.error?.code, "PGRST116");
  assert.equal(many.error?.details, "The result contains 2 rows");
});

test("maybeSingle() resolves no row as null, but several as an error", async () => {
  let answer: object[] = [];
  const { db } = fakeSql(() => answer);

  const none = await db.from("t").select("id").maybeSingle();
  assert.equal(none.error, null);
  assert.equal(none.data, null);

  answer = rows({ id: 1 }, { id: 2 });
  const many = await db.from("t").select("id").maybeSingle();
  assert.equal(many.error?.code, "PGRST116");
});

test("a write that breaks single() is rolled back, not merely reported", async () => {
  const { db, stats } = fakeSql(() => rows({ id: 1 }, { id: 2 }));
  const { error } = await db.from("t").update({ x: 1 }).eq("group", "g").select("id").single();

  assert.equal(error?.code, "PGRST116");
  assert.deepEqual(stats, { began: 1, rolledBack: 1 });
});

// ── writes ──────────────────────────────────────────────────────────────────

test("insert goes through json_populate_recordset, and only returns rows when asked", async () => {
  const { db, calls } = fakeSql(() => []);
  const plain = await db.from("orders").insert({ total: 5, note: undefined });

  assert.equal(plain.error, null);
  assert.equal(plain.data, null);
  assert.equal(plain.status, 201);
  // An undefined field is left out entirely, so its column takes its default.
  assert.equal(
    calls[0].text,
    `insert into "public"."orders" as _t ("total") select "total" ` +
      `from json_populate_recordset(null::"public"."orders", $1::json)`,
  );
  assert.deepEqual(calls[0].params, [[{ total: 5 }]]);

  await db.from("orders").insert({ total: 5 }).select("id");
  assert.match(calls[1].text, /^with _w as \(insert into .* returning _t\."id" as "id"\) select to_json\(_w\) as _r from _w$/);
});

test("a ragged batch insert covers the union of keys", async () => {
  const { db, calls } = fakeSql();
  await db.from("t").insert([{ a: 1 }, { b: 2, a: undefined }]);
  assert.match(calls[0].text, /^insert into "public"\."t" as _t \("a", "b"\) select "a", "b" from /);
  assert.deepEqual(calls[0].params, [[{ a: 1 }, { b: 2 }]]);
});

test("inserting an empty array runs nothing", async () => {
  const { db, calls } = fakeSql();
  const plain = await db.from("t").insert([]);
  const selected = await db.from("t").insert([]).select("*");

  assert.equal(calls.length, 0);
  assert.equal(plain.data, null);
  assert.deepEqual(selected.data, []);
});

test("upsert overwrites only the columns it names", async () => {
  const { db, calls } = fakeSql();
  await db.from("sync_state").upsert({ id: 1, synced_through: "2026-01-01" }, { onConflict: "id" });
  assert.match(
    calls[0].text,
    / on conflict \("id"\) do update set "id" = excluded\."id", "synced_through" = excluded\."synced_through"$/,
  );

  await db.from("user_apps").upsert([{ user_id: "u", app_slug: "a" }], {
    onConflict: "user_id, app_slug",
    ignoreDuplicates: true,
  });
  assert.match(calls[1].text, / on conflict \("user_id", "app_slug"\) do nothing$/);
});

test("upsert without onConflict targets the primary key, as PostgREST does", async () => {
  const { db, calls } = fakeSql(({ text }) =>
    text.includes("pg_index") ? [{ name: "user_id" }, { name: "app_slug" }] : [],
  );
  const { error } = await db.from("user_app_grants").upsert({ user_id: "u", app_slug: "a", role: null });

  assert.equal(error, null);
  assert.deepEqual(calls[0].params, ['"public"."user_app_grants"']);
  assert.match(calls[1].text, / on conflict \("user_id", "app_slug"\) do update set /);
});

test("a client for another schema qualifies every table with it, and nothing else changes", async () => {
  const { db, calls } = fakeSql(({ text }) => (text.includes("pg_index") ? [{ name: "id" }] : []));
  const app = db.schema("app_sales_tracker");
  await app.from("orders").select("id").eq("status", "open");
  await app.from("orders").upsert({ id: 1, status: "open" });
  await db.from("users").select("id");

  assert.equal(
    calls[0].text,
    `select (select to_json(_p) from (select _t."id" as "id") as _p) as _r from "app_sales_tracker"."orders" as _t ` +
      `where _t."status" = (select _f."status" from json_populate_record(null::"app_sales_tracker"."orders", $1::json) as _f)`,
  );
  // The default upsert target is looked up in the same schema.
  assert.deepEqual(calls[1].params, ['"app_sales_tracker"."orders"']);
  assert.match(calls[2].text, /^insert into "app_sales_tracker"\."orders" as _t /);
  // The client it came from still reaches public.
  assert.match(calls[3].text, / from "public"\."users" as _t$/);
});

test("a schema that is not a plain identifier is refused before any SQL is written", async () => {
  const { db, calls } = fakeSql();
  for (const schema of ['app_x"; drop table users; --', "public.users", "app x", ""]) {
    const { error } = await db.schema(schema).from("orders").select("id");
    assert.equal(error?.code, "MIXOS_QUERY", schema);
    assert.match(error?.message ?? "", /Invalid schema name/);
  }
  assert.equal(calls.length, 0);
});

test("update sets only the given columns, from the payload's own types", async () => {
  const { db, calls } = fakeSql();
  await db.from("users").update({ display_name: "A", updated_at: null }).eq("id", "u1");
  assert.equal(
    calls[0].text,
    `update "public"."users" as _t set "display_name" = _v."display_name", "updated_at" = _v."updated_at" ` +
      `from json_populate_record(null::"public"."users", $1::json) as _v where _t."id" = ` +
      `(select _f."id" from json_populate_record(null::"public"."users", $2::json) as _f)`,
  );
  assert.deepEqual(calls[0].params, [{ display_name: "A", updated_at: null }, { id: "u1" }]);
});

test("update and delete refuse to run without a filter", async () => {
  const { db, calls } = fakeSql();
  const update = await db.from("users").update({ is_admin: true });
  const remove = await db.from("users").delete();

  assert.equal(update.error?.code, "MIXOS_QUERY");
  assert.equal(remove.error?.code, "MIXOS_QUERY");
  assert.equal(calls.length, 0);
});

// ── identifiers: the boundary that keeps context.db inside its app ──────────

test("names that are not plain identifiers never reach SQL", async () => {
  const { db, calls } = fakeSql();
  const attempts = [
    db.from('users"; drop table users; --').select("*"),
    db.from("other_schema.secrets").select("*"),
    db.from("users").select("password_hash::text"),
    db.from("users").select("id, apps(name)"),
    db.from("users").select("x:(select 1)"),
    db.from("users").select("id,"),
    db.from("users").select("id").eq('id" = $1 or "1', "x"),
    db.from("users").select("id").order("id desc, (select 1)"),
    db.from("users").upsert({ id: 1 }, { onConflict: "id) do nothing; --" }),
    db.from("users").insert({ 'a"b': 1 }),
    db.from("t".repeat(64)).select("*"),
  ];

  for (const attempt of attempts) {
    const { data, error } = await attempt;
    assert.equal(data, null);
    assert.equal(error?.code, "MIXOS_QUERY", error?.message);
  }
  assert.equal(calls.length, 0);
});

// ── results ─────────────────────────────────────────────────────────────────

test("a database error resolves as { error } with PostgREST's fields; it never rejects", async () => {
  const { db } = fakeSql(() =>
    Object.assign(new Error('duplicate key value violates unique constraint "users_email_key"'), {
      code: "23505",
      detail: "Key (email)=(a@example.com) already exists.",
    }),
  );
  const { data, error, status } = await db.from("users").insert({ email: "a@example.com" });

  assert.equal(data, null);
  assert.equal(error?.code, "23505");
  assert.equal(error?.details, "Key (email)=(a@example.com) already exists.");
  assert.equal(error?.hint, null);
  assert.equal(status, 409);
});

test("a query runs once however many times it is awaited", async () => {
  const { db, calls } = fakeSql();
  const query = db.from("t").insert({ a: 1 });
  await query;
  await query;
  await Promise.all([query, query]);
  assert.equal(calls.length, 1);
});
