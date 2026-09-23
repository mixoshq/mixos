-- Session revocation for a JWT session strategy.
--
-- `session: { strategy: "jwt" }` means there is no server-side session row to
-- delete, so signing out clears a cookie and nothing more: an already-issued
-- token stays valid until it expires. Rotating AUTH_SECRET invalidates every
-- session at once, which is the wrong granularity for the case that actually
-- comes up — one person leaves, or one person's laptop is lost.
--
-- This is the standard fix: a counter in the token, compared against the row on
-- every session resolution. Bump the row and every token minted before that
-- moment stops resolving, for that user alone.
--
-- The cost is honest and worth stating: one indexed read per session
-- resolution, where before the token was trusted for its whole lifetime. That
-- read also re-checks `is_admin`, so a demotion now takes effect everywhere
-- rather than only in `requireAdmin()`.
alter table public.users
  add column if not exists session_version integer not null default 0;

-- Atomic increment. A read-modify-write from the application would let two
-- concurrent revocations both read the same value and both write value+1, so
-- the second silently does nothing. `set x = x + 1` is evaluated against the
-- locked row, which makes revocation monotonic: it can never fail to move.
--
-- SECURITY: PostgREST publishes public-schema functions to `anon` and
-- `authenticated` by default, and this one mutates auth state. EXECUTE is
-- revoked from those roles and granted only to `service_role`, the role the
-- application actually connects as — the same treatment the app-schema
-- introspection RPC in 0001 gets.
create or replace function public.bump_session_version(p_user_id uuid)
returns integer
language sql
security invoker
as $$
  update public.users
  set session_version = session_version + 1,
      updated_at = now()
  where id = p_user_id
  returning session_version;
$$;

revoke all on function public.bump_session_version(uuid) from public, anon, authenticated;
grant execute on function public.bump_session_version(uuid) to service_role;

-- The schema version this file brings the database to. See 0007 and OS-UPDATES.md.
insert into public.platform_settings (key, value)
values ('platform_schema_version', '6')
on conflict (key) do update
  set value = excluded.value,
      updated_at = now();
