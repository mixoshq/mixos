-- Widen the app-schema RPC: nullability, defaults, and keys.
--
-- The admin app-database viewer showed a column's name and its type, which is
-- enough to know a column exists and not enough to know anything about it. The
-- three facts it was missing are the three an admin actually asks: can this be
-- empty, what arrives when nobody sets it, and what is this joined to.
--
-- The return type changes, so this DROPS and recreates rather than
-- `create or replace` — Postgres refuses to replace a function whose OUT
-- columns differ. Every security property of the original is restored below and
-- is the reason this is not a one-line ALTER: EXECUTE stays revoked from
-- `anon`/`authenticated` (PostgREST publishes public-schema functions to them by
-- default) and granted only to `service_role`, `security invoker` is preserved,
-- and `search_path` stays pinned so the body cannot be redirected by a
-- caller-set path.
drop function if exists public.get_app_schema(text);

create function public.get_app_schema(prefix text)
returns table (
  table_name       text,
  column_name      text,
  data_type        text,
  ordinal_position int,
  is_nullable      boolean,
  column_default   text,
  is_primary_key   boolean,
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
  -- Keys come from pg_catalog rather than information_schema.key_column_usage
  -- joined to constraint_column_usage. That join is the standard recipe and it
  -- is wrong for a composite foreign key: the two views carry no shared
  -- ordinal, so joining on constraint name alone yields the cross product of
  -- referencing and referenced columns. `unnest(conkey, confkey) with
  -- ordinality` pairs them positionally, which is the actual relationship.
  pk as (
    select rel.relname::text as tbl, att.attname::text as col
    from pg_constraint con
    join pg_class rel on rel.oid = con.conrelid
    join pg_namespace ns on ns.oid = rel.relnamespace
    join lateral unnest(con.conkey) as k(attnum) on true
    join pg_attribute att
      on att.attrelid = con.conrelid and att.attnum = k.attnum
    where con.contype = 'p'
      and ns.nspname = 'public'
      and rel.relname like prefix || '%'
  ),
  fk as (
    select
      rel.relname::text  as tbl,
      att.attname::text  as col,
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
    join pg_attribute fatt
      on fatt.attrelid = con.confrelid and fatt.attnum = k.fattnum
    where con.contype = 'f'
      and ns.nspname = 'public'
      and rel.relname like prefix || '%'
  )
  select
    c.table_name::text,
    c.column_name::text,
    c.data_type::text,
    c.ordinal_position::int,
    (c.is_nullable = 'YES'),
    c.column_default::text,
    (pk.col is not null),
    fk.ftbl,
    fk.fcol
  from information_schema.columns c
  left join pk on pk.tbl = c.table_name and pk.col = c.column_name
  left join fk on fk.tbl = c.table_name and fk.col = c.column_name
  where c.table_schema = 'public'
    and c.table_name like prefix || '%'
  order by c.table_name, c.ordinal_position
$$;

-- `anon`, `authenticated` and `service_role` are Supabase's API roles. They
-- exist only where Supabase (or a hand-run PostgREST) created them, so the
-- grants below are made only where the roles are. On a plain Postgres there is
-- no API to publish the function through, and the owner — the role MixOS
-- connects as — keeps EXECUTE either way.
revoke all on function public.get_app_schema(text) from public;
do $$
declare
  api_role text;
begin
  foreach api_role in array array['anon', 'authenticated'] loop
    if exists (select 1 from pg_roles where rolname = api_role) then
      execute format('revoke all on function public.get_app_schema(text) from %I', api_role);
    end if;
  end loop;
  if exists (select 1 from pg_roles where rolname = 'service_role') then
    grant execute on function public.get_app_schema(text) to service_role;
  end if;
end
$$;

-- The schema version this file brings the database to. See 0007 and OS-UPDATES.md.
insert into public.platform_settings (key, value)
values ('platform_schema_version', '5')
on conflict (key) do update
  set value = excluded.value,
      updated_at = now();
