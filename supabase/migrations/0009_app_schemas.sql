-- App schemas: the admin viewer reads them, and the one trigger the platform
-- puts on an app's table.
--
-- An app with `"database": true` used to keep its tables in `public` under an
-- `_app_<slug>_` name prefix. Each now has a schema, app_<slug>, owned by a role
-- of its own, mixos_app_<slug>. The release step creates both and runs the
-- app's migrations as that role (scripts/app-migrations.ts). Two things in the
-- platform schema follow.

-- ── get_app_schema, by schema ───────────────────────────────────────────────
--
-- The admin app-database viewer (src/lib/apps/admin-actions.ts) found an app's
-- tables by name prefix; it now names the schemas. The argument's type changes,
-- so this drops and recreates, and restores every property 0005 gave the
-- function: `security invoker`, a pinned search_path, and EXECUTE revoked from
-- `anon`/`authenticated` and granted to `service_role` where those roles exist.
drop function if exists public.get_app_schema(text);

create function public.get_app_schema(app_schemas text[])
returns table (
  table_schema     text,
  table_name       text,
  column_name      text,
  data_type        text,
  ordinal_position int,
  is_nullable      boolean,
  column_default   text,
  is_primary_key   boolean,
  foreign_schema   text,
  foreign_table    text,
  foreign_column   text
)
language sql
stable
security invoker
-- Pin search_path so the body can't be redirected by a caller-set path.
set search_path = pg_catalog, public
as $$
  with
  -- From pg_catalog rather than information_schema, for the reason 0005 gives:
  -- `unnest(conkey, confkey) with ordinality` pairs a composite foreign key's
  -- columns positionally, which the information_schema join cannot.
  pk as (
    select ns.nspname::text as sch, rel.relname::text as tbl, att.attname::text as col
    from pg_constraint con
    join pg_class rel on rel.oid = con.conrelid
    join pg_namespace ns on ns.oid = rel.relnamespace
    join lateral unnest(con.conkey) as k(attnum) on true
    join pg_attribute att
      on att.attrelid = con.conrelid and att.attnum = k.attnum
    where con.contype = 'p'
      and ns.nspname = any(app_schemas)
  ),
  fk as (
    select
      ns.nspname::text   as sch,
      rel.relname::text  as tbl,
      att.attname::text  as col,
      fns.nspname::text  as fsch,
      fref.relname::text as ftbl,
      fatt.attname::text as fcol
    from pg_constraint con
    join pg_class rel on rel.oid = con.conrelid
    join pg_namespace ns on ns.oid = rel.relnamespace
    join lateral unnest(con.conkey, con.confkey)
      with ordinality as k(attnum, fattnum, ord) on true
    join pg_attribute att
      on att.attrelid = con.conrelid and att.attnum = k.attnum
    join pg_class fref on fref.oid = con.confrelid
    join pg_namespace fns on fns.oid = fref.relnamespace
    join pg_attribute fatt
      on fatt.attrelid = con.confrelid and fatt.attnum = k.fattnum
    where con.contype = 'f'
      and ns.nspname = any(app_schemas)
  )
  select
    c.table_schema::text,
    c.table_name::text,
    c.column_name::text,
    c.data_type::text,
    c.ordinal_position::int,
    (c.is_nullable = 'YES'),
    c.column_default::text,
    (pk.col is not null),
    fk.fsch,
    fk.ftbl,
    fk.fcol
  from information_schema.columns c
  left join pk
    on pk.sch = c.table_schema and pk.tbl = c.table_name and pk.col = c.column_name
  left join fk
    on fk.sch = c.table_schema and fk.tbl = c.table_name and fk.col = c.column_name
  where c.table_schema = any(app_schemas)
  order by c.table_schema, c.table_name, c.ordinal_position
$$;

revoke all on function public.get_app_schema(text[]) from public;
do $$
declare
  api_role text;
begin
  foreach api_role in array array['anon', 'authenticated'] loop
    if exists (select 1 from pg_roles where rolname = api_role) then
      execute format('revoke all on function public.get_app_schema(text[]) from %I', api_role);
    end if;
  end loop;
  if exists (select 1 from pg_roles where rolname = 'service_role') then
    grant execute on function public.get_app_schema(text[]) to service_role;
  end if;
end
$$;

-- ── mixos_touch_updated_at ──────────────────────────────────────────────────
--
-- App migrations may not create triggers (scripts/app-sql-policy.ts): a trigger
-- on an app's table runs as the platform's role whenever the platform writes the
-- table. The one trigger apps asked for keeps an `updated_at` column current, so
-- the platform provides it. An app lists the column under `updatedAt` in
-- app.json, and the release step installs this function on the table as a
-- BEFORE UPDATE trigger, passing the column's name.
--
-- It sets that column of the new row to now() and returns the row. It reads
-- nothing else, runs as whoever is writing, and resolves every name in
-- pg_catalog. The column is named at runtime, so the value goes through
-- jsonb_populate_record, which converts it to the column's own type.
create or replace function public.mixos_touch_updated_at()
returns trigger
language plpgsql
security invoker
set search_path = pg_catalog
as $$
begin
  new := jsonb_populate_record(new, jsonb_build_object(tg_argv[0], now()));
  return new;
end
$$;

-- Nobody calls it directly. Postgres checks EXECUTE when a trigger is created,
-- which only this function's owner does, and not when the trigger fires.
revoke all on function public.mixos_touch_updated_at() from public;
do $$
declare
  api_role text;
begin
  foreach api_role in array array['anon', 'authenticated', 'service_role'] loop
    if exists (select 1 from pg_roles where rolname = api_role) then
      execute format('revoke all on function public.mixos_touch_updated_at() from %I', api_role);
    end if;
  end loop;
end
$$;

-- The schema version this file brings the database to. See 0007 and OS-UPDATES.md.
insert into public.platform_settings (key, value)
values ('platform_schema_version', '9')
on conflict (key) do update
  set value = excluded.value,
      updated_at = now();
