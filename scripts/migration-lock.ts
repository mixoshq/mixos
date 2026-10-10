/* This Source Code Form is subject to the terms of the Mozilla Public
 * License, v. 2.0. If a copy of the MPL was not distributed with this
 * file, You can obtain one at https://mozilla.org/MPL/2.0/. */

// The lock every step of the release step that writes to the database takes:
// each platform migration, the app registry mirror, each app migration, the
// row-level security sweep and the first-admin seed.
//
// One key for all of them, so two runners started together — two instances
// booting, a deploy overlapping a manual run — take turns at every step rather
// than racing at any. Each step re-reads what it is about to change once the
// lock is held, which is what makes taking turns enough: the second runner
// finds the work done and moves on, where it would otherwise have failed on a
// duplicate table or a duplicate row.
//
// Transaction-scoped, so the commit or rollback that ends a step releases it,
// and it survives a transaction pooler. A session-scoped lock would not (see
// 0007's notes on _platform_locks). The key's text dates from when only the
// platform migrations took it, and stays, so a release step from an older image
// still excludes one from a newer image.
//
// Library only.

import type { TransactionSql } from "postgres";

export async function takeMigrationLock(tx: TransactionSql): Promise<void> {
  await tx`select pg_advisory_xact_lock(hashtext('mixos:platform-migrations'))`;
}
