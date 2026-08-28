/* This Source Code Form is subject to the terms of the Mozilla Public
 * License, v. 2.0. If a copy of the MPL was not distributed with this
 * file, You can obtain one at https://mozilla.org/MPL/2.0/. */

import Link from "next/link";
import { appRegistry } from "@/generated/app-registry";
import { requireReadOnlySession } from "@/lib/auth/session";
import { requireAdmin } from "@/lib/apps/access";
import { getRegisteredSlugs } from "@/lib/apps/admin-actions";
import { getMissingTenantConfigConnectors } from "@/lib/apps/connector-gates";
import AppRegistryList from "@/components/admin/app-registry-list";

export default async function AppsAdminPage() {
  const session = await requireReadOnlySession();
  await requireAdmin(session);

  const registeredSlugs = await getRegisteredSlugs();

  // Precompute the missing-connector map once per page load. Surfaced in the
  // toggle UI as a disabled state + inline warning so admins can't try to
  // register an app whose connectors aren't configured.
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
            Register apps to make them available for users. Deregistering
            removes access for all users.
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
        registeredSlugs={registeredSlugs}
        missingConnectorsBySlug={missingConnectorsBySlug}
      />
    </div>
  );
}
