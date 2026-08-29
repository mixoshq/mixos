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

  // The grant is the only gate now. Registration used to be a second one —
  // every app had to be switched on by an admin before anyone could be given
  // it — but an app in the registry passed build-time validation, which is what
  // that switch was standing in for.
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
        Toggle each on to install it on your dashboard.
      </p>

      <div className="mt-6">
        {/*
          Always empty: user-scoped (per-user OAuth) connectors were removed
          from the platform — see docs/connectors/architecture.md, "One
          credential set per connector". Every connector is tenant-scoped now,
          and that gate is enforced upstream: an app whose declared connectors
          an admin has not configured cannot be GRANTED
          (src/lib/apps/connector-gates.ts, applied in
          src/app/(main)/admin/users/page.tsx), so it never reaches this list.
          There is nothing left for this prop to carry, and nothing is lost by
          passing {}.

          The prop itself is dead weight that AppManagerList and AppToggleList
          still declare, along with a "Connect →" link to /account/connections —
          a route that no longer exists. Deleting the prop chain in those two
          components is the real fix; this file cannot reach them.
        */}
        <AppManagerList
          apps={availableApps}
          installedSlugs={installedSlugs}
          missingUserConnectorsBySlug={{}}
        />
      </div>
    </SettingsShell>
  );
}
