/* This Source Code Form is subject to the terms of the Mozilla Public
 * License, v. 2.0. If a copy of the MPL was not distributed with this
 * file, You can obtain one at https://mozilla.org/MPL/2.0/. */

// The first admin account, from INITIAL_ADMIN_EMAIL / INITIAL_ADMIN_PASSWORD.
//
// Two modes, because the two callers want different things from the same pair
// of variables:
//
//   reset        `npm run seed-admin`, which the local Docker boot runs on every
//                start. An existing account gets the password back and admin
//                re-granted, so the committed dev credentials always work.
//
//   create-only  scripts/release.ts, on every deploy. The account is created
//                when it does not exist and is otherwise left alone. A deploy
//                must never quietly reset a password the admin has since
//                changed — on a hosting platform these variables stay set long
//                after the first boot.
//
// Library only: scripts/seed-admin.ts and scripts/release.ts are the entry
// points.
//
// The write takes the release step's lock (scripts/migration-lock.ts) and looks
// the account up again once it holds it, so two deploys starting together
// create the account once rather than the second failing on the unique email.

import bcrypt from "bcryptjs";
import type { Sql } from "postgres";
import { takeMigrationLock } from "./migration-lock";

export type AdminSeedOutcome = "created" | "reset" | "exists";

export async function seedAdmin(
  sql: Sql,
  opts: { email: string; password: string; mode: "reset" | "create-only" },
): Promise<AdminSeedOutcome> {
  const existing = await sql<{ id: string }[]>`
    SELECT id FROM public.users WHERE email = ${opts.email} LIMIT 1
  `;

  if (existing.length > 0 && opts.mode === "create-only") return "exists";

  // Before the lock, not under it: a quarter of a second of bcrypt is nothing
  // another runner should have to wait for.
  const passwordHash = await bcrypt.hash(opts.password, 12);

  return sql.begin(async (tx) => {
    await takeMigrationLock(tx);
    const [current] = await tx<{ id: string }[]>`
      SELECT id FROM public.users WHERE email = ${opts.email} LIMIT 1
    `;

    if (current && opts.mode === "create-only") return "exists" as const;

    if (current) {
      await tx`
        UPDATE public.users
        SET password_hash = ${passwordHash},
            is_admin = true,
            updated_at = now()
        WHERE id = ${current.id}
      `;
      return "reset" as const;
    }

    const displayName = opts.email.split("@")[0];
    await tx`
      INSERT INTO public.users (email, display_name, password_hash, is_admin)
      VALUES (${opts.email}, ${displayName}, ${passwordHash}, true)
    `;
    return "created" as const;
  });
}
