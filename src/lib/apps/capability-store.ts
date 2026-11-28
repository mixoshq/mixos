/* This Source Code Form is subject to the terms of the Mozilla Public
 * License, v. 2.0. If a copy of the MPL was not distributed with this
 * file, You can obtain one at https://mozilla.org/MPL/2.0/. */

/**
 * The approved-capabilities queries the server and the release step share
 * (./capability-approvals.ts, scripts/sync-capabilities.ts). Given a handle,
 * so the release step's bundle carries no request pool.
 */

import type { Sql, TransactionSql } from "postgres";
import { capabilityKey, type Capability } from "./capabilities";

type Db = Sql | TransactionSql;

/** The capabilities an app is approved for, as keys. */
export async function getApprovedKeys(db: Db, slug: string): Promise<Set<string>> {
  const rows = await db<{ kind: string; capability: string }[]>`
    select kind, capability from public.app_capability_approvals where app_slug = ${slug}
  `;
  return new Set(rows.map((r) => `${r.kind}:${r.capability}`));
}

/**
 * Make `caps` the app's approved set: add what is new and drop what it no
 * longer asks for, so asking for it again later prompts again. Clears the
 * "asks for more" flag.
 */
export async function replaceApproved(db: Db, slug: string, caps: readonly Capability[], by: string | null): Promise<void> {
  const keep = caps.map(capabilityKey);
  await db`
    delete from public.app_capability_approvals
     where app_slug = ${slug} and not ((kind || ':' || capability) = any(${keep}::text[]))
  `;
  for (const c of caps) {
    await db`
      insert into public.app_capability_approvals (app_slug, kind, capability, approved_by)
      values (${slug}, ${c.kind}, ${c.capability}, ${by})
      on conflict (app_slug, kind, capability) do nothing
    `;
  }
  await db`update public.apps set capabilities_pending_since = null where slug = ${slug}`;
}

