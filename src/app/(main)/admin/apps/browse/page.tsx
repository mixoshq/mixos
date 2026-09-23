/* This Source Code Form is subject to the terms of the Mozilla Public
 * License, v. 2.0. If a copy of the MPL was not distributed with this
 * file, You can obtain one at https://mozilla.org/MPL/2.0/. */

import { appRegistry } from "@/generated/app-registry";
import BrowsePage from "@/components/admin/browse/browse-page";

export const metadata = { title: "Browse Apps" };

/**
 * Browse apps published to mixos.org.
 *
 * A route under `/admin/apps` rather than a shared `/admin/browse` with tabs:
 * the admin nav already resolves the active section by longest matching href,
 * so this lights up "Apps" with no alias needed, and the button that reaches it
 * is on the Apps page. Three kinds, three pages, each next to the registry it
 * adds to.
 */
export default async function BrowseAppsPage() {
  return (
    <BrowsePage
      kind="app"
      installedSlugs={appRegistry.map((a) => a.slug)}
      backHref="/admin/apps"
    />
  );
}
