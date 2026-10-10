-- An app that leaves the build keeps its data.
--
-- The release step mirrors the app registry into public.apps
-- (scripts/sync-app-registry.ts). It used to delete the row of every slug the
-- build no longer carried, and the foreign keys took the app's grants, user
-- installs, password and dashboard widgets with it. A folder removed on purpose
-- and an app the registry generator skipped looked the same to it, and so did a
-- rollback to a build from before the app was added.
--
-- The sync now marks the row and keeps everything:
--
--   missing_since        When a release step first ran without the app. Null
--                        while the app is in the build.
--   code_hash            A hash of the files under apps/<slug>/
--                        (scripts/app-code-hash.ts), recorded by every release
--                        step whose build carries the app.
--   returned_changed_at  Set when the app came back into the build with files
--                        that differ from the recorded hash. The sync switches
--                        such an app off; activating it clears this.
--
-- A returning app with the recorded hash comes back as it left. One with
-- different files comes back inactive and flagged, so keeping the row doesn't
-- hand the old activation, and with it the old grants, to different code. An
-- admin activates it again once they have looked.

alter table public.apps
  add column if not exists missing_since timestamptz,
  add column if not exists code_hash text,
  add column if not exists returned_changed_at timestamptz;

-- The schema version this file brings the database to. See 0007 and OS-UPDATES.md.
insert into public.platform_settings (key, value)
values ('platform_schema_version', '10')
on conflict (key) do update
  set value = excluded.value,
      updated_at = now();
