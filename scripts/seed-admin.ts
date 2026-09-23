/* This Source Code Form is subject to the terms of the Mozilla Public
 * License, v. 2.0. If a copy of the MPL was not distributed with this
 * file, You can obtain one at https://mozilla.org/MPL/2.0/. */

import bcrypt from "bcryptjs";
import { createPgClient } from "../src/lib/db/pg-options";
import { loadEnv } from "./load-env";

loadEnv();

async function main() {
  const email = process.env.INITIAL_ADMIN_EMAIL;
  const password = process.env.INITIAL_ADMIN_PASSWORD;

  if (!email || !password) {
    console.error(
      "Missing INITIAL_ADMIN_EMAIL or INITIAL_ADMIN_PASSWORD in environment."
    );
    process.exit(1);
  }

  const sql = createPgClient({ max: 1 });
  try {
    const existing = await sql<{ id: string }[]>`
      SELECT id FROM public.users WHERE email = ${email} LIMIT 1
    `;

    const passwordHash = await bcrypt.hash(password, 12);
    const displayName = email.split("@")[0];

    if (existing.length > 0) {
      await sql`
        UPDATE public.users
        SET password_hash = ${passwordHash},
            is_admin = true,
            updated_at = now()
        WHERE id = ${existing[0].id}
      `;
      console.log(`Updated ${email} (is_admin=true, password reset).`);
      return;
    }

    await sql`
      INSERT INTO public.users (email, display_name, password_hash, is_admin)
      VALUES (${email}, ${displayName}, ${passwordHash}, true)
    `;
    console.log(`Created admin user ${email}.`);
  } finally {
    await sql.end();
  }
}

main().catch((err) => {
  console.error("Seed failed:", err);
  process.exit(1);
});
