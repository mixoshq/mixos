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

import bcrypt from "bcryptjs";
import type { Sql } from "postgres";

export type AdminSeedOutcome = "created" | "reset" | "exists";

export async function seedAdmin(
  sql: Sql,
  opts: { email: string; password: string; mode: "reset" | "create-only" },
): Promise<AdminSeedOutcome> {
  const existing = await sql<{ id: string }[]>`
    SELECT id FROM public.users WHERE email = ${opts.email} LIMIT 1
  `;

  if (existing.length > 0 && opts.mode === "create-only") return "exists";

  const passwordHash = await bcrypt.hash(opts.password, 12);

  if (existing.length > 0) {
    await sql`
      UPDATE public.users
      SET password_hash = ${passwordHash},
          is_admin = true,
          updated_at = now()
      WHERE id = ${existing[0].id}
    `;
    return "reset";
  }

  const displayName = opts.email.split("@")[0];
  await sql`
    INSERT INTO public.users (email, display_name, password_hash, is_admin)
    VALUES (${opts.email}, ${displayName}, ${passwordHash}, true)
  `;
  return "created";
}
