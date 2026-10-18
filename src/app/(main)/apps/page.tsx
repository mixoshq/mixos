/* This Source Code Form is subject to the terms of the Mozilla Public
 * License, v. 2.0. If a copy of the MPL was not distributed with this
 * file, You can obtain one at https://mozilla.org/MPL/2.0/. */

import { requireReadOnlySession } from "@/lib/auth/session";
import {
  ensureUser,
  getUserApps,
  getUserGrantedSlugs,
} from "@/lib/apps/access";
import { appRegistry } from "@/generated/app-registry";
import AppManagerList from "@/components/apps/app-manager-list";
import SettingsShell from "@/components/settings/settings-shell";

export default async function AppsPage() {
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
      <h1 className="text-2xl font-bold text-foreground">App Manager</h1>
      <p className="mt-1 text-sm text-muted-foreground">
        Toggle each one on to use it and put its widgets on your dashboard.
      </p>

      <div className="mt-6">
        {/*
          No connector gate here: granting is the gate. An app whose tenant
          connectors aren't ready can't be granted (src/lib/apps/connector-gates.ts),
          so it never reaches this list, and a user-scoped connector the user
          hasn't connected is simply absent from the app's context, which the
          app handles (docs/apps/connectors.md).
        */}
        <AppManagerList apps={availableApps} installedSlugs={installedSlugs} />
      </div>
    </SettingsShell>
  );
}
