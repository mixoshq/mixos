/* This Source Code Form is subject to the terms of the Mozilla Public
 * License, v. 2.0. If a copy of the MPL was not distributed with this
 * file, You can obtain one at https://mozilla.org/MPL/2.0/. */

// The release step's capability check (Item 8, src/lib/apps/capability-approvals.ts).
//
// After the registry sync, each app in this build has its capabilities read
// from its manifest (src/lib/apps/capabilities.ts) and compared with what an
// admin approved:
//
//   - None approved yet, and a local app: its current set is recorded as
//     approved, silently. The "apps you write" tier, and the upgrade path:
//     nothing switches off when this ships.
//   - Asks for something not approved: flagged (`capabilities_pending_since`)
//     and audited `app.capabilities.grew` with what was added. A Registry app
//     is also switched off until an admin approves it (fail closed); a local
//     app stays on.
//   - Asks for less: what it dropped leaves the approved set, so asking for it
//     again prompts again. Back within its approvals: the flag clears.
//
// Library only.

import type { Sql } from "postgres";
import type { AppManifest } from "../src/lib/apps/types";
import type { RegistryInstall } from "../src/lib/repository/install-record";
import { RELEASE_STEP_ACTOR } from "../src/lib/apps/audit-actors";
import { addedCapabilities, appCapabilities, capabilityKey } from "../src/lib/apps/capabilities";
import { getApprovedKeys, replaceApproved } from "../src/lib/apps/capability-store";
import { takeMigrationLock } from "./migration-lock";

export interface GrownApp {
  slug: string;
  added: string[];
  /** A Registry app this run switched off for it. */
  deactivated: boolean;
}

export interface CapabilitySyncResult {
  grew: GrownApp[];
  /** Local apps whose current set this run recorded as approved, the first time it saw them. */
  baselined: string[];
}

export async function syncCapabilities(
  sql: Sql,
  apps: readonly (Partial<AppManifest> & { slug: string })[],
  installs: readonly RegistryInstall[],
): Promise<CapabilitySyncResult> {
  return sql.begin(async (tx) => {
    await takeMigrationLock(tx);
    const grew: GrownApp[] = [];
    const baselined: string[] = [];
    for (const app of apps) {
      const [row] = await tx<{ is_active: boolean; capabilities_pending_since: Date | null }[]>`
        select is_active, capabilities_pending_since from public.apps where slug = ${app.slug}
      `;
      if (!row) continue;
      const caps = appCapabilities(app);
      const third = installs.some((i) => i.kind === "app" && i.slug === app.slug);
      const approved = await getApprovedKeys(tx, app.slug);

      if (approved.size === 0) {
        if (!third) {
          await replaceApproved(tx, app.slug, caps, null);
          baselined.push(app.slug);
          continue;
        }
        // A Registry app nobody approved: nothing to compare until it is
        // activated, which approves it, unless it is somehow on.
        if (!row.is_active) continue;
      }

      const added = addedCapabilities(caps, approved);
      const keys = new Set(caps.map(capabilityKey));
      const dropped = [...approved].filter((k) => !keys.has(k));
      if (dropped.length > 0) {
        await tx`
          delete from public.app_capability_approvals
           where app_slug = ${app.slug} and (kind || ':' || capability) = any(${dropped}::text[])
        `;
      }

      if (added.length === 0) {
        if (row.capabilities_pending_since) {
          await tx`update public.apps set capabilities_pending_since = null where slug = ${app.slug}`;
        }
        continue;
      }

      const deactivated = third && row.is_active;
      await tx`
        update public.apps
           set capabilities_pending_since = coalesce(capabilities_pending_since, now()),
               is_active = case when ${third} then false else is_active end
         where slug = ${app.slug}
      `;
      const list = added.map(capabilityKey);
      await tx`
        insert into public.admin_audit_log (actor_id, actor_email, action, target_type, target_id, details)
        values (null, ${RELEASE_STEP_ACTOR}, 'app.capabilities.grew', 'app', ${app.slug},
                ${tx.json({ added: list, deactivated } as never)})
      `;
      grew.push({ slug: app.slug, added: list, deactivated });
    }
    return { grew, baselined };
  });
}
