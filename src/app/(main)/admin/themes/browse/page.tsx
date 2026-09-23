/* This Source Code Form is subject to the terms of the Mozilla Public
 * License, v. 2.0. If a copy of the MPL was not distributed with this
 * file, You can obtain one at https://mozilla.org/MPL/2.0/. */

import { themeRegistry } from "@/generated/theme-registry";
import BrowsePage from "@/components/admin/browse/browse-page";

export const metadata = { title: "Browse Themes" };

/** Browse themes published to mixos.org. See the apps variant for why each
 *  kind gets its own route. */
export default async function BrowseThemesPage() {
  return (
    <BrowsePage
      kind="theme"
      installedSlugs={themeRegistry.map((t) => t.slug)}
      backHref="/admin/themes"
    />
  );
}
