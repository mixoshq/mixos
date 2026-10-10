/* This Source Code Form is subject to the terms of the Mozilla Public
 * License, v. 2.0. If a copy of the MPL was not distributed with this
 * file, You can obtain one at https://mozilla.org/MPL/2.0/. */

// Makes public.apps a mirror of the generated app registry.
//
// WHY THIS EXISTS AT ALL. `public.apps` used to be a decision: an admin flipped
// a toggle and a row appeared. That decision is gone — an app in the registry
// was validated at build time, so it is valid, full stop — but the TABLE has to
// stay, because four tables hang off it by foreign key:
//
//   user_app_grants · user_apps · app_passwords · dashboard_widgets
//
// all `on delete cascade`. Those constraints are the only thing at the database
// level that stops a grant, an install, a password or a dashboard widget
// referring to an app that does not exist. Dropping the table to remove the
// toggle would have taken that guarantee with it and left nothing in its place.
//
// So the row is no longer something a person creates. It is derived state, and
// this is what derives it:
//
//   - a NEWLY seen app arrives INACTIVE: its code is present but it serves
//     nothing until an admin activates it on the Apps page. `is_active` is
//     absent from the conflict clause on purpose — a redeploy must never
//     re-decide a switch an admin has already thrown, in either direction.
//   - every app in the registry is upserted, so its name and description in the
//     database track the manifest rather than whatever they were on the day
//     someone first registered it;
//   - every row whose slug is NOT in the registry is deleted, and the cascade
//     removes that app's grants, installs, password and widgets with it.
//
// That deletion is the whole point and it is destructive by design. It is what
// used to happen when an admin deregistered an app, and it is the only thing
// that cleans up after an app is removed from the repo. Because it is
// destructive, this reports what it is about to do before it does it.
//
// One transaction under the release step's lock (scripts/migration-lock.ts), so
// the mirror is replaced whole or not at all, and two runners take turns.

import type { Sql } from "postgres";
import type { AppManifest } from "../src/lib/apps/types";
import { appRegistry as builtRegistry } from "../src/generated/app-registry";
import { takeMigrationLock } from "./migration-lock";

export interface AppRegistrySyncResult {
  upserted: number;
  removed: string[];
}

/** What the mirror records of each app. */
export type MirroredApp = Pick<AppManifest, "slug" | "name" | "description" | "icon">;

/**
 * `appRegistry` is this build's registry. A test passes its own, the way it
 * passes the app migration runner its own apps.
 */
export async function syncAppRegistry(
  sql: Sql,
  appRegistry: readonly MirroredApp[] = builtRegistry,
): Promise<AppRegistrySyncResult> {
  const slugs = appRegistry.map((a) => a.slug);

  return sql.begin(async (tx) => {
    await takeMigrationLock(tx);

    for (const app of appRegistry) {
      await tx`
        insert into public.apps (slug, name, description, icon, is_active)
        values (${app.slug}, ${app.name}, ${app.description}, ${app.icon}, false)
        on conflict (slug) do update set
          name        = excluded.name,
          description = excluded.description,
          icon        = excluded.icon
      `;
    }

    // `= any(...)` rather than `not in (...)`: an empty registry would make
    // `not in ()` a syntax error, and this has to behave sanely for a repo with
    // no apps in it rather than blowing up on the edge case.
    const stale = await tx<{ slug: string }[]>`
      select slug from public.apps where not (slug = any(${slugs}))
    `;
    if (stale.length > 0) {
      await tx`
        delete from public.apps where not (slug = any(${slugs}))
      `;
    }

    return { upserted: appRegistry.length, removed: stale.map((r) => r.slug) };
  });
}
