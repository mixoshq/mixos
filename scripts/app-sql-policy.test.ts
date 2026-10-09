/* This Source Code Form is subject to the terms of the Mozilla Public
 * License, v. 2.0. If a copy of the MPL was not distributed with this
 * file, You can obtain one at https://mozilla.org/MPL/2.0/. */

import { test } from "node:test";
import assert from "node:assert/strict";
import {
  ALLOWED_FUNCTIONS,
  checkAppMigrationSql,
  describeAppTables,
  formatSqlProblems,
  lineAtCharacter,
} from "./app-sql-policy";

const SCHEMA = "app_notes";
const check = (sql: string) => checkAppMigrationSql(sql, SCHEMA);

async function assertAllowed(sql: string): Promise<void> {
  const problems = await check(sql);
  assert.deepEqual(problems, [], `refused:\n${sql}\n${formatSqlProblems("migration.sql", problems)}`);
}

async function assertRefused(sql: string, reason: RegExp): Promise<void> {
  const problems = await check(sql);
  assert.ok(problems.length > 0, `allowed:\n${sql}`);
  assert.ok(
    problems.some((p) => reason.test(p.reason)),
    `refused for another reason:\n${sql}\n${formatSqlProblems("migration.sql", problems)}`,
  );
}

// ── what real apps write ────────────────────────────────────────────────────

// The migrations two apps were written with (careers, key-numbers), statements
// verbatim and most comments dropped. The em dashes are kept: line numbers are
// counted in bytes, and they are three each.
const REAL_MIGRATIONS = [
  `-- Who you are — and the numbers you measure a posting against.
create table if not exists profile (
  user_id uuid primary key,
  name text not null default '',
  headline text not null default '',
  headline_descriptor text not null default '',
  email text not null default '',
  phone text,
  location text not null default '',
  base_city text not null default '',
  base_state text,
  base_country text not null default '',
  links jsonb not null default '[]'::jsonb,
  comp_target integer,
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now()
);

create table if not exists summary_variants (
  user_id uuid not null,
  variant_key text not null,
  body text not null,
  updated_at timestamptz not null default now(),
  primary key (user_id, variant_key)
);`,
  `create table if not exists roles (
  id uuid primary key default gen_random_uuid(),
  user_id uuid not null,
  org text not null,
  title text not null,
  location text,
  start_month date not null,
  end_month date,
  context text,
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now()
);

create index if not exists idx_roles_user on roles(user_id, start_month desc);

create table if not exists accomplishments (
  id uuid primary key default gen_random_uuid(),
  user_id uuid not null,
  role_id uuid not null references roles(id) on delete cascade,
  claim text not null,
  how text,
  metrics jsonb not null default '[]'::jsonb,
  tech jsonb not null default '[]'::jsonb,
  themes jsonb not null default '[]'::jsonb,
  evidence text not null default '',
  scope text not null default 'resume'
    check (scope in ('resume', 'page', 'both')),
  case_study jsonb,
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now()
);

create index if not exists idx_accomplishments_user on accomplishments(user_id);
create index if not exists idx_accomplishments_role on accomplishments(role_id);

create table if not exists skill_groups (
  id uuid primary key default gen_random_uuid(),
  user_id uuid not null,
  label text not null,
  items jsonb not null default '[]'::jsonb,
  sort_order integer not null default 0,
  created_at timestamptz not null default now()
);

create index if not exists idx_skill_groups_user on skill_groups(user_id, sort_order);`,
  `create table if not exists applications (
  id uuid primary key default gen_random_uuid(),
  user_id uuid not null,
  company text not null,
  role_title text not null,
  job_url text,
  jd_raw text not null,
  jd_analysis jsonb,
  cover_letter_draft text not null default '',
  provenance jsonb,
  status text not null default 'draft'
    check (status in ('draft', 'applied', 'screen', 'interview', 'offer', 'rejected', 'ghosted')),
  location text,
  comp_min integer,
  comp_max integer,
  comp_currency text
    check (comp_currency is null or char_length(comp_currency) = 3),
  comp_basis text,
  comp_posted text,
  comp_target integer,
  notes text not null default '',
  contact_name text,
  contact_email text,
  created_at timestamptz not null default now(),
  applied_at timestamptz,
  last_activity_at timestamptz not null default now()
);

create index if not exists idx_applications_user_activity
  on applications(user_id, last_activity_at desc);

create table if not exists documents (
  id uuid primary key default gen_random_uuid(),
  application_id uuid not null references applications(id) on delete cascade,
  user_id uuid not null,
  kind text not null check (kind in ('resume', 'cover_letter')),
  revision integer not null,
  markdown text not null,
  source text not null check (source in ('generated', 'edited', 'restored')),
  created_at timestamptz not null default now(),
  unique (application_id, kind, revision)
);`,
  `-- Key Numbers — initial schema.
create table if not exists swr_cache (
  cache_key  text primary key,
  payload    jsonb not null,
  fetched_at timestamptz not null default now()
);

create table if not exists settings (
  id             int primary key default 1,
  spreadsheet_id text,
  updated_by     uuid,
  updated_at     timestamptz not null default now(),
  constraint settings_single_row check (id = 1)
);

create table if not exists audience (
  user_id      uuid primary key,
  last_seen_at timestamptz not null default now()
);`,
];

test("the migrations real apps ship are allowed", async () => {
  for (const sql of REAL_MIGRATIONS) await assertAllowed(sql);
});

test("what an app migration ordinarily does is allowed", async () => {
  for (const sql of [
    // Tables, with every kind of constraint an app uses.
    `create table orders (
       id bigint generated always as identity primary key,
       ref uuid not null default gen_random_uuid() unique,
       status text not null default 'pending' check (status in ('pending', 'paid')),
       total numeric(10, 2) not null default 0 check (total >= 0),
       code text check (code similar to '[A-Z]{3}'),
       email text collate "C",
       placed_at timestamptz not null default current_timestamp,
       day date default current_date,
       doubled bigint generated always as (id * 2) stored,
       tags text[] not null default '{}',
       meta jsonb not null default jsonb_build_object('v', 1)
     );`,
    "create table if not exists line_items (id serial primary key, order_id bigint not null references orders(id) on delete cascade, unique (order_id, id));",
    "create unlogged table cache (k text primary key, v jsonb) with (fillfactor = 70);",
    "create table app_notes.qualified (id int primary key);",
    "create table copy_of_orders (like orders including all);",
    // Indexes, including the expressions and predicates they are for.
    "create unique index orders_email on orders (lower(email));",
    "create index orders_open on orders (placed_at desc nulls last) where status = 'pending';",
    "create index orders_meta on orders using gin (meta jsonb_path_ops);",
    // Views over the app's own tables.
    `create view daily_totals as
       select date_trunc('day', placed_at) as day, count(*) as orders, sum(total) as total
       from orders
       where status = 'paid'
       group by 1;`,
    "create or replace view totals_text with (security_barrier = true) as select id, total::text as total from orders;",
    "create view paid as select o.* from orders o join line_items l on l.order_id = o.id where exists (select 1 from line_items x where x.order_id = o.id);",
    // Types and sequences.
    "create type mood as enum ('happy', 'sad'); alter type mood add value if not exists 'meh' after 'happy';",
    "create sequence invoice_no as bigint start with 1000 increment by 1 owned by orders.id; alter sequence invoice_no restart with 2000;",
    // Changing tables.
    "alter table orders add column if not exists note text, alter column note set default '', alter column note set not null;",
    "alter table orders alter column total type numeric(12, 2) using total::numeric(12, 2);",
    "alter table orders add constraint positive check (total >= 0) not valid; alter table orders validate constraint positive;",
    "alter table orders drop column if exists note, drop constraint if exists positive;",
    "alter table orders rename column status to state; alter table orders rename to purchases; alter index orders_email rename to purchases_email;",
    "comment on table orders is 'One row per order.'; comment on column orders.total is 'In the shop currency.';",
    "drop view if exists daily_totals; drop index if exists orders_open; drop table if exists cache cascade; drop type if exists mood;",
    // Data.
    "insert into orders (status, total) values ('paid', 10), ('pending', default);",
    "insert into orders (status) select lower(status) from orders where char_length(status) > 3;",
    "update orders set total = round(total, 2) where status = 'paid';",
    "delete from line_items using orders o where o.id = line_items.order_id and o.status = 'pending';",
    "with recursive n(i) as (select 1 union all select i + 1 from n where i < 10) insert into line_items (order_id) select i from n;",
    "truncate cache restart identity;",
  ]) {
    await assertAllowed(sql);
  }
});

test("RA-40: a seed insert with ON CONFLICT is allowed, and nothing rewrites it", async () => {
  // The prefix rewriter turned `on conflict (id)` into `on _app_<slug>_conflict (id)`.
  // Nothing rewrites app SQL now; the statement runs as written.
  await assertAllowed(`
    create table if not exists settings (id int primary key default 1, value text);
    insert into settings (id, value) values (1, 'x') on conflict (id) do nothing;
    insert into settings (id, value) values (1, 'y')
      on conflict (id) do update set value = excluded.value where settings.value is null;
    insert into settings (id) values (1) on conflict on constraint settings_pkey do nothing;
  `);
});

// ── the escalations the plan reproduced ─────────────────────────────────────

test("a trigger that updates public.users is refused, function and all", async () => {
  const problems = await check(`
create table notes (id int primary key, body text);
create function promote() returns trigger language plpgsql as $$
begin
  update public.users set is_admin = true;
  return new;
end $$;
create trigger promote after insert on notes for each row execute function promote();
`);
  assert.deepEqual(
    problems.map((p) => p.line),
    [3, 8],
  );
  assert.match(problems[0].reason, /CREATE FUNCTION and CREATE PROCEDURE are not allowed/);
  assert.match(problems[1].reason, /CREATE TRIGGER is not allowed/);
  assert.match(problems[1].reason, /"updatedAt" in app\.json/);
});

test("a column default that selects password_hash is refused", async () => {
  await assertRefused(
    `create table leak (
       id int primary key,
       x xml default query_to_xml('select email, password_hash from public.users', true, true, '')
     );`,
    /query_to_xml\(\) is not allowed/,
  );
  await assertRefused(
    "create table leak (x text default (select password_hash from public.users limit 1));",
    /subquery is not allowed in a column default|"public\.users" is outside/,
  );
  await assertRefused(
    "alter table notes alter column body set default current_setting('app.settings.jwt_secret', true);",
    /current_setting\(\) is not allowed/,
  );
});

test("update public.users is refused, however it is written", async () => {
  for (const sql of [
    "update public.users set is_admin = true;",
    "UPDATE public.users SET is_admin = TRUE WHERE email = 'me@example.com';",
    'update "public"."users" set is_admin = true;',
    "with x as (update public.users set is_admin = true returning id) insert into notes (id) select 1;",
    "update notes set body = (select password_hash from public.users limit 1);",
    "insert into public.users (id, email, display_name, is_admin) values (gen_random_uuid(), 'x', 'x', true);",
    "delete from public.users;",
  ]) {
    await assertRefused(sql, /"public\.users" is outside this app's schema, app_notes/);
  }
});

test("a view over public.users is refused, as is one over the catalogs", async () => {
  await assertRefused("create view v as select email, password_hash from public.users;", /"public\.users" is outside/);
  await assertRefused("create view v as select * from pg_catalog.pg_authid;", /outside this app's schema/);
  await assertRefused("create view v as select * from pg_authid;", /names beginning with pg_ belong to Postgres/);
  await assertRefused("create view v as select * from information_schema.tables;", /outside this app's schema/);
  await assertRefused(
    "create view v as select n.id from notes n join public.users u on u.id = n.id;",
    /"public\.users" is outside/,
  );
  await assertRefused("create view v as select public.users.email from notes;", /outside this app's schema/);
});

// ── everything else that is not the app's to do ─────────────────────────────

test("policies, code, grants, roles, settings and extensions are refused", async () => {
  for (const [sql, reason] of [
    ["create policy p on public.users using (true);", /policies are not allowed/],
    ["alter policy p on notes using (true);", /policies are not allowed/],
    ["create rule r as on insert to notes do also update public.users set is_admin = true;", /CREATE RULE is not allowed/],
    ["create or replace function f() returns int language sql as 'select 1';", /CREATE FUNCTION/],
    ["create procedure p() language sql as $$ select 1 $$;", /CREATE FUNCTION and CREATE PROCEDURE/],
    ["alter function mixos_apply_migration(text) security invoker;", /ALTER FUNCTION is not allowed/],
    ["do $$ begin update public.users set is_admin = true; end $$;", /DO blocks are not allowed/],
    ["do language plpgsql $body$ begin perform 1; end $body$;", /DO blocks are not allowed/],
    ["call p();", /CALL is not allowed/],
    ["grant select on notes to public;", /GRANT and REVOKE are not allowed/],
    ["revoke all on notes from public;", /GRANT and REVOKE are not allowed/],
    ["grant postgres to current_user;", /GRANT and REVOKE are not allowed/],
    ["alter default privileges grant all on tables to public;", /GRANT and REVOKE/],
    ["create role sneaky login superuser;", /Roles are the platform's to manage/],
    ["alter role current_user superuser;", /Roles are the platform's to manage/],
    ["alter table notes owner to postgres;", /Ownership is the platform's to manage/],
    ["alter type mood owner to postgres;", /Ownership is the platform's to manage/],
    ["set role postgres;", /SET, RESET and SHOW are not allowed/],
    ["reset role;", /SET, RESET and SHOW are not allowed/],
    ["set session authorization postgres;", /SET, RESET and SHOW are not allowed/],
    ["set local search_path = public;", /SET, RESET and SHOW are not allowed/],
    ["insert into notes (body) values (set_config('role', 'postgres', true));", /set_config\(\) is not allowed/],
    ["select set_config('search_path', 'public', false);", /A bare SELECT or VALUES is not allowed/],
    ["select pg_sleep(1);", /A bare SELECT or VALUES is not allowed/],
    ["create extension pgcrypto;", /Extensions are not allowed/],
    ["create schema other;", /exactly one schema/],
    ["drop schema app_notes cascade;", /DROP SCHEMA is not allowed/],
    ["alter table notes set schema public;", /SET SCHEMA is not allowed/],
    ["alter table notes disable row level security;", /Row-level security on an app's tables/],
    ["alter table notes disable trigger all;", /triggers is not allowed/],
    ["drop trigger mixos_updated_at_updated_at on notes;", /DROP TRIGGER is not allowed/],
    ["copy notes from program 'id';", /COPY is not allowed/],
    ["begin; commit;", /Transaction control is not allowed/],
    ["create temp table scratch (x int);", /Temporary tables/],
    ["create materialized view mv as select 1;", /materialized views are not supported/],
    ["create domain short as text check (length(value) < 10);", /Domains are not supported/],
    ["create table child () inherits (notes);", /INHERITS/],
    ["create table t (x int) partition by range (x);", /Partitioned tables/],
    ["create table t (x int) tablespace pg_default;", /Tablespaces/],
    ["notify chan;", /NOTIFY is not allowed/],
    ["vacuum notes;", /VACUUM and ANALYZE is not allowed/],
  ] as const) {
    await assertRefused(sql, reason);
  }
});

test("a reference outside the app's schema is refused wherever it appears", async () => {
  for (const sql of [
    "create table public.evil (x int);",
    "create table other_db.app_notes.t (x int);",
    "create table t (u uuid references public.users(id));",
    "alter table notes add constraint fk foreign key (id) references public.users(id);",
    "create table t (like public.users including all);",
    "create index on public.users (email);",
    "create table t (x int generated always as identity (sequence name public.seq));",
    "alter sequence s owned by public.users.id;",
    "comment on column public.users.email is 'x';",
    "drop table public.users;",
    "alter table public.users add column x int;",
    "truncate public.users;",
    "create table t (x public.citext);",
    "create type public.mood as enum ('a');",
    "create table t (x text collate public.c);",
    "create index on notes (body public.text_ops);",
    "insert into notes (id) select 1 from public.users;",
    "create view v as select * from notes, lateral (select * from public.users) u;",
    "create view v as select * from notes where id in (select 1 from public.users);",
    "create view v as select 1 as x from notes where 1 operator(public.=) 1;",
  ]) {
    await assertRefused(sql, /outside this app's schema|outside pg_catalog|names another database/);
  }
});

test("expressions call only the listed built-ins, and stored ones take no subquery", async () => {
  for (const [sql, reason] of [
    ["create table t (id int default nextval('public.s'));", /nextval\(\) is not allowed/],
    ["create table t (who text default current_user);", /CURRENT_USER is not allowed/],
    ["create table t (who text default session_user);", /SESSION_USER is not allowed/],
    ["create table t (x int default (select 1));", /subquery is not allowed in a column default/],
    ["create table t (x int check (x > (select 1)));", /subquery is not allowed in a check constraint/],
    ["create table t (x int, y int generated always as ((select 1)) stored);", /subquery is not allowed in a generated column/],
    ["create index on notes ((substring(body from 1 for 3)));", /substring\(\) is not allowed/],
    ["create index on notes (id) where body = (select 'x');", /subquery is not allowed in an index predicate/],
    ["alter table notes alter column id type text using (select 'x');", /subquery is not allowed in a USING expression/],
    ["create view v as select pg_read_file('/etc/passwd') from notes;", /pg_read_file\(\) is not allowed/],
    ["create view v as select dblink('host=x', 'select 1') from notes;", /dblink\(\) is not allowed/],
    ["create view v as select public.lower(body) from notes;", /public\.lower\(\) is outside pg_catalog/],
    ["create view v as select row_number() over () from notes;", /row_number\(\) is not allowed/],
    ["create table t (x regclass default 'public.users');", /regclass looks up other database objects/],
    ["create view v as select 'public.users'::regclass from notes;", /regclass looks up other database objects/],
    ["create view v as select * from notes where id = $1;", /\$n parameter/],
    ["create view v as select xmlelement(name x) from notes;", /XML expression/],
    ["create table t (x int, exclude using gist (x with =));", /EXCLUDE constraints/],
    ["create index on notes using bloom (body);", /index method "bloom"/],
    ["create index concurrently on notes (body);", /CONCURRENTLY cannot run/],
  ] as const) {
    await assertRefused(sql, reason);
  }
});

test("the list of callable functions holds only pure built-ins", () => {
  // A guard on edits to the list: none of these reads or changes anything
  // outside the statement, or runs SQL text. Adding one here is a review.
  for (const name of [
    "query_to_xml",
    "set_config",
    "current_setting",
    "nextval",
    "setval",
    "pg_read_file",
    "lo_import",
    "dblink",
    "pg_sleep",
    "pg_advisory_lock",
    "pg_notify",
    "to_regclass",
    "has_table_privilege",
  ]) {
    assert.ok(!ALLOWED_FUNCTIONS.includes(name), name);
  }
  assert.ok(ALLOWED_FUNCTIONS.includes("now") && ALLOWED_FUNCTIONS.includes("gen_random_uuid"));
});

// ── how problems are reported ───────────────────────────────────────────────

test("a problem is reported on its own line, after multibyte text", async () => {
  const problems = await check(
    [
      "-- Notes — the app's only table. “Quoted” too.",
      "create table notes (",
      "  id int primary key,",
      "  body text default 'é—ü'",
      ");",
      "",
      "-- And then — the problem:",
      "update public.users",
      "   set is_admin = true;",
    ].join("\n"),
  );
  assert.equal(problems.length, 1);
  assert.equal(problems[0].line, 8);
  assert.equal(problems[0].statement, "update public.users");
  assert.equal(
    formatSqlProblems("apps/notes/migrations/001.sql", problems),
    'apps/notes/migrations/001.sql:8: "public.users" is outside this app\'s schema, app_notes. ' +
      "An app migration can reach only its own objects.\n    in: update public.users",
  );
});

test("a file that does not parse is refused at the line where it stops", async () => {
  const problems = await check("-- ——\ncreate table notes (id int primary key);\ncreate table broken (id int;\n");
  assert.equal(problems.length, 1);
  assert.equal(problems[0].line, 3);
  assert.match(problems[0].reason, /does not parse as SQL: syntax error at or near ";"/);
});

test("every statement with a problem is reported, not just the first", async () => {
  const problems = await check("set role postgres;\ncreate table ok (id int);\ngrant all on ok to public;\n");
  assert.deepEqual(
    problems.map((p) => [p.line, p.statement]),
    [
      [1, "set role postgres"],
      [3, "grant all on ok to public"],
    ],
  );
});

test("Postgres's 1-based error positions map to lines, counting characters", () => {
  const text = "create table a (id int);\n-- é — ü\ninsert into missing values (1);\n";
  // Postgres reports the character position, 1-based; this takes the 0-based index.
  assert.equal(lineAtCharacter(text, text.indexOf("missing")), 3);
  assert.equal(lineAtCharacter(text, 0), 1);
});

// ── what the files build ────────────────────────────────────────────────────

test("the tables a set of files leaves behind, with each column's type", async () => {
  const tables = await describeAppTables(
    [
      "create table notes (id int primary key, body text, created timestamptz default now());",
      "alter table notes add column updated_at timestamptz, drop column body; create table scratch (x int);",
      "alter table notes rename column created to created_at; alter table notes rename to entries; drop table scratch;",
      "alter table entries alter column id type bigint; create table public.users_copy (x int);",
    ],
    SCHEMA,
  );
  assert.deepEqual(
    Object.fromEntries([...tables].map(([t, cols]) => [t, Object.fromEntries(cols)])),
    { entries: { id: "int8", created_at: "timestamptz", updated_at: "timestamptz" } },
  );
});
