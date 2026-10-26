-- This Source Code Form is subject to the terms of the Mozilla Public
-- License, v. 2.0. If a copy of the MPL was not distributed with this
-- file, You can obtain one at https://mozilla.org/MPL/2.0/.

-- ============================================================================
-- The release notes each person has seen.
--
-- The menu bar shows the release notes of the last 14 days, MixOS's and those
-- of the extensions on in a person's workspace, with a dot on each one they
-- haven't seen (src/lib/release-notes/). A row is one person having seen one
-- note.
--
--   note_id    The note's id in the build (src/generated/release-notes.ts):
--              whose note, its day and a hash of its text, so a note whose
--              text is edited is new again.
--   note_date  The note's day. Marking deletes the person's rows for notes
--              older than the window, so the table holds at most a window's
--              notes per person.
-- ============================================================================

create table public.release_notes_seen (
  user_id   uuid not null references public.users(id) on delete cascade,
  note_id   text not null,
  note_date date not null,
  seen_at   timestamptz not null default now(),
  primary key (user_id, note_id)
);

-- On, with no policies, as for every table in `public` (0001_platform_schema.sql).
alter table public.release_notes_seen enable row level security;

insert into public.platform_settings (key, value)
values ('platform_schema_version', '2')
on conflict (key) do update
  set value = excluded.value,
      updated_at = now();
