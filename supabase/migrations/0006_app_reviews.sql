-- This Source Code Form is subject to the terms of the Mozilla Public
-- License, v. 2.0. If a copy of the MPL was not distributed with this
-- file, You can obtain one at https://mozilla.org/MPL/2.0/.

-- ============================================================================
-- Reviews of Registry apps (src/lib/apps/app-review.ts).
--
-- An app installed from a Registry is someone else's code. It runs only after
-- an admin of THIS instance has recorded a review of the exact code it runs:
-- a row here whose code_hash is the hash of the app's folder as deployed
-- (scripts/app-code-hash.ts), local edits included. Activate refuses a
-- Registry app with no such row (setAppActive, src/lib/apps/access.ts), and
-- the release step switches off an active one whose code no longer matches a
-- review (scripts/sync-app-registry.ts), setting review_needed_since. Apps
-- written here, with no install record, are unaffected.
--
-- No row is written for an app that is already active when this ships: there
-- were no Registry apps installed to grandfather, so the first release step
-- after it switches off any active Registry app until an admin reviews it.
--
-- Keyed by the hash, so a review of one build's code never counts for
-- another's, whichever build wrote it to a shared database. Deleted with the
-- app's row; a rename moves them (scripts/sync-renames.ts); a different
-- extension arriving under the slug has them deleted by the release step.
-- ============================================================================

create table public.app_reviews (
  app_slug     text not null references public.apps(slug) on delete cascade,
  code_hash    text not null,
  -- What the install record said it was, when it was reviewed.
  version      text,
  commit_sha   text,
  source       text,
  -- Whether its files had changed since it was installed.
  modified     boolean not null default false,
  reviewed_by  uuid references public.users(id) on delete set null,
  reviewed_at  timestamptz not null default now(),
  primary key (app_slug, code_hash)
);

-- On, with no policies, as for every table in `public` (0001_platform_schema.sql).
alter table public.app_reviews enable row level security;

-- When the release step switched a Registry app off because no review here
-- matches the code it now runs. Cleared when one is recorded.
alter table public.apps add column review_needed_since timestamptz;

insert into public.platform_settings (key, value)
values ('platform_schema_version', '6')
on conflict (key) do update
  set value = excluded.value,
      updated_at = now();
