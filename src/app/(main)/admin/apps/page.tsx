/* This Source Code Form is subject to the terms of the Mozilla Public
 * License, v. 2.0. If a copy of the MPL was not distributed with this
 * file, You can obtain one at https://mozilla.org/MPL/2.0/. */

import Link from "next/link";
import { ExternalLink, Store } from "lucide-react";
import { appRegistry } from "@/generated/app-registry";
import { requireReadOnlySession } from "@/lib/auth/session";
import { docsUrl } from "@/lib/docs";
import { requireAdmin } from "@/lib/apps/access";
import { installEnabled } from "@/lib/repository/policy";
import { getAppGrantCounts, getAppTableCounts } from "@/lib/apps/admin-actions";
import { getAppActiveMap, getAppBuildStatus } from "@/lib/apps/access";
import { getMissingTenantConfigConnectors } from "@/lib/apps/connector-gates";
import AppRegistryList from "@/components/admin/app-registry-list";
import AppsNotInBuild from "@/components/admin/apps-not-in-build";
import BrandConflicts from "@/components/admin/brand-conflicts";
import PendingInstalls from "@/components/admin/pending/pending-installs";
import { getActiveTheme } from "@/lib/themes/active";

export default async function AppsAdminPage() {
  const session = await requireReadOnlySession();
  await requireAdmin(session);

  // Who actually holds each app. One scan for the whole page — see
  // getAppGrantCounts.
  const grantCountsBySlug = await getAppGrantCounts();
  // Live table counts for the tile pills. One RPC for the registry — see
  // getAppTableCounts.
  const tableCountsBySlug = await getAppTableCounts();
  const activeBySlug = await getAppActiveMap();
  // Apps the release step kept after they left the build, and apps it brought
  // back with different code. See getAppBuildStatus.
  const buildStatus = await getAppBuildStatus();
  const { theme } = await getActiveTheme();

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
          <h1 className="text-2xl font-bold text-foreground">Apps</h1>
          <p className="mt-1 text-sm text-muted-foreground">
            Every app in this repository, validated at build time. Grant an app
            to a user in{" "}
            <Link href="/admin/users" className="underline underline-offset-2">
              Users
            </Link>{" "}
            to make it available to them.
          </p>
        </div>
        {/*
          Two actions, and the order is the point: Browse reaches the mixos.org
          repository, which is where an admin who wants a app they do not
          have goes first. The docs are for the case where nobody has built it
          yet, so they keep the brand fill and the second position rather than
          competing with the action most visits to this page want. They open on
          mixos.org in a new tab: the in-app copy at /apps/guide still exists but
          is no longer linked, so the site is the one place the guide is current.

          Browse is absent when installing this kind is turned off
          (lib/repository/policy.ts); the page it leads to is a 404 then anyway.
        */}
        <div className="flex shrink-0 items-center gap-2">
          {installEnabled("app") && (
            <Link
              href="/admin/apps/browse"
              className="inline-flex items-center gap-2 rounded-lg border border-border px-4 py-2 text-sm font-medium text-foreground shadow-sm hover:bg-muted"
            >
              <Store className="h-4 w-4" aria-hidden />
              Browse Apps
            </Link>
          )}
          <a
            href={docsUrl("extending/apps")}
            target="_blank"
            rel="noreferrer noopener"
            className="inline-flex items-center gap-2 rounded-lg bg-brand px-4 py-2 text-sm font-medium text-brand-foreground shadow-sm hover:bg-brand/90"
          >
            How to create an app
            <ExternalLink className="h-4 w-4" aria-hidden />
            <span className="sr-only"> (opens in a new tab)</span>
          </a>
        </div>
      </div>
      <PendingInstalls kind="app" />
      <BrandConflicts
        apps={appRegistry}
        activeBySlug={activeBySlug}
        themeBranding={theme.branding}
      />
      <AppRegistryList
        apps={appRegistry}
        missingConnectorsBySlug={missingConnectorsBySlug}
        grantCountsBySlug={grantCountsBySlug}
        tableCountsBySlug={tableCountsBySlug}
        activeBySlug={activeBySlug}
        returnedChangedBySlug={buildStatus.returnedChanged}
      />
      <AppsNotInBuild
        apps={buildStatus.notInBuild}
        grantCountsBySlug={grantCountsBySlug}
      />
    </div>
  );
}
