/* This Source Code Form is subject to the terms of the Mozilla Public
 * License, v. 2.0. If a copy of the MPL was not distributed with this
 * file, You can obtain one at https://mozilla.org/MPL/2.0/. */

// `npm run seed-admin` — create the INITIAL_ADMIN_EMAIL account, or reset its
// password and re-grant admin when it already exists. See scripts/admin-seed.ts
// for why a deploy uses a gentler mode than this.

import { createPgClient } from "../src/lib/db/pg-options";
import { seedAdmin } from "./admin-seed";
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
    const outcome = await seedAdmin(sql, { email, password, mode: "reset" });
    console.log(
      outcome === "created"
        ? `Created admin user ${email}.`
        : `Updated ${email} (is_admin=true, password reset).`,
    );
  } finally {
    await sql.end();
  }
}

main().catch((err) => {
  console.error("Seed failed:", err);
  process.exit(1);
});
