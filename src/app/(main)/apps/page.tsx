/* This Source Code Form is subject to the terms of the Mozilla Public
 * License, v. 2.0. If a copy of the MPL was not distributed with this
 * file, You can obtain one at https://mozilla.org/MPL/2.0/. */

import Link from "next/link";
import { Gift } from "lucide-react";
import { requireReadOnlySession } from "@/lib/auth/session";
import {
  ensureUser,
  getUserApps,
  getUserGrantedSlugs,
} from "@/lib/apps/access";
import { appRegistry } from "@/generated/app-registry";
import AppManagerList from "@/components/apps/app-manager-list";
import { WIDGETS_PARAM } from "@/lib/apps/app-manager-url";
import SettingsShell from "@/components/settings/settings-shell";

export default async function AppsPage({
  searchParams,
}: {
  searchParams: Promise<Record<string, string | string[] | undefined>>;
}) {
  // `?widgets=1` opens the list with its Widgets filter on: the empty
  // dashboard's "Install Apps with widgets" links here that way.
  const widgetsOnly = (await searchParams)[WIDGETS_PARAM] === "1";
  const session = await requireReadOnlySession();
  const userId = await ensureUser(session.user);
  const [installedSlugs, grantedSlugs] = await Promise.all([
    getUserApps(userId),
    getUserGrantedSlugs(userId),
  ]);

  // What the user holds is what they can turn on: their grants and the global
  // apps, less any app that is switched off. An app in the registry passed
  // build-time validation, so nothing else stands between it and a grant.
  const granted = new Set(grantedSlugs);
  const availableApps = appRegistry.filter((a) => granted.has(a.slug));

  return (
    // App Manager is a settings page, so it gets the settings shell — the same
    // sidebar as Administration and the account pages, which link to it.
    // Applied here rather than as apps/layout.tsx, which would also wrap
    // /apps/[appSlug] and put a settings sidebar around every installed app.
    <SettingsShell>
      <div className="flex flex-col gap-4 sm:flex-row sm:items-start sm:justify-between">
        <div>
          <h1 className="text-2xl font-bold text-foreground">
            App Manager
          </h1>
          <p className="mt-1 text-sm text-muted-foreground">
            Toggle each one on to use it and put its widgets on your dashboard.
          </p>
        </div>
        {/* What changed in MixOS and in what's on here: /apps/release-notes,
            which the menu bar's gift opens too. */}
        <Link
          href="/apps/release-notes"
          className="inline-flex shrink-0 items-center gap-2 self-start rounded-lg border border-border px-4 py-2 text-sm font-medium text-foreground shadow-sm hover:bg-muted"
        >
          <Gift className="h-4 w-4" aria-hidden />
          Release Notes
        </Link>
      </div>

      <div className="mt-6">
        {/*
          No connector gate here: granting is the gate. An app whose tenant
          connectors aren't ready can't be granted (src/lib/apps/connector-gates.ts),
          so it never reaches this list, and a user-scoped connector the user
          hasn't connected is simply absent from the app's context, which the
          app handles (docs/apps/connectors.md).
        */}
        {/* Keyed on the filter, so following the link while already here
            sets it rather than keeping whatever the list had. */}
        <AppManagerList
          key={widgetsOnly ? "widgets" : "all"}
          apps={availableApps}
          installedSlugs={installedSlugs}
          initialWidgetsOnly={widgetsOnly}
        />
      </div>
    </SettingsShell>
  );
}
