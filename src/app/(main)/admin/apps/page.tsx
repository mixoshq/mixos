/* This Source Code Form is subject to the terms of the Mozilla Public
 * License, v. 2.0. If a copy of the MPL was not distributed with this
 * file, You can obtain one at https://mozilla.org/MPL/2.0/. */

import Link from "next/link";
import { appRegistry } from "@/generated/app-registry";
import { requireReadOnlySession } from "@/lib/auth/session";
import { requireAdmin } from "@/lib/apps/access";
import { getAppGrantCounts, getAppTableCounts } from "@/lib/apps/admin-actions";
import { getMissingTenantConfigConnectors } from "@/lib/apps/connector-gates";
import AppRegistryList from "@/components/admin/app-registry-list";

export default async function AppsAdminPage() {
  const session = await requireReadOnlySession();
  await requireAdmin(session);

  // Who actually holds each app. One scan for the whole page — see
  // getAppGrantCounts.
  const grantCountsBySlug = await getAppGrantCounts();
  // Live table counts for the tile pills. One RPC for the registry — see
  // getAppTableCounts.
  const tableCountsBySlug = await getAppTableCounts();

  // Precompute the missing-connector map once per page load. Shown here as a
  // warning only — it is not a gate on this page any more. An app that needs an
  // unconfigured connector still exists and is still valid; what it cannot do
  // is be granted to anyone, which is enforced in /admin/users.
  const missingEntries = await Promise.all(
    appRegistry.map(
      async (app) =>
        [app.slug, await getMissingTenantConfigConnectors(app.slug)] as const,
    ),
  );
  const missingConnectorsBySlug = Object.fromEntries(missingEntries);

  return (
    <div>
      <div className="mb-6 flex items-start justify-between">
        <div>
          <h1 className="text-2xl font-bold text-foreground">App Registry</h1>
          <p className="mt-1 text-sm text-muted-foreground">
            Every app in this repository, validated at build time. Grant an app
            to a user in{" "}
            <Link href="/admin/users" className="underline underline-offset-2">
              Users
            </Link>{" "}
            to make it available to them.
          </p>
        </div>
        <Link
          href="/apps/guide"
          className="shrink-0 inline-flex items-center gap-2 rounded-lg bg-brand px-4 py-2 text-sm font-medium text-brand-foreground shadow-sm hover:bg-brand/90"
        >
          How to create an app
        </Link>
      </div>
      <AppRegistryList
        apps={appRegistry}
        missingConnectorsBySlug={missingConnectorsBySlug}
        grantCountsBySlug={grantCountsBySlug}
        tableCountsBySlug={tableCountsBySlug}
      />
    </div>
  );
}
