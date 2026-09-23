/* This Source Code Form is subject to the terms of the Mozilla Public
 * License, v. 2.0. If a copy of the MPL was not distributed with this
 * file, You can obtain one at https://mozilla.org/MPL/2.0/. */

import { connectorRegistry } from "@/generated/connector-registry";
import BrowsePage from "@/components/admin/browse/browse-page";

export const metadata = { title: "Browse Connectors" };

/** Browse connectors published to mixos.org. See the apps variant for why
 *  each kind gets its own route. */
export default async function BrowseConnectorsPage() {
  return (
    <BrowsePage
      kind="connector"
      // A connector is identified by `name` on disk and in the registry, which
      // is the value a repository slug becomes when it is installed.
      installedSlugs={connectorRegistry.map((c) => c.name)}
      backHref="/admin/connectors"
    />
  );
}
