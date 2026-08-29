/* This Source Code Form is subject to the terms of the Mozilla Public
 * License, v. 2.0. If a copy of the MPL was not distributed with this
 * file, You can obtain one at https://mozilla.org/MPL/2.0/. */

import { requireReadOnlySession } from "@/lib/auth/session";
import { requireAdmin } from "@/lib/apps/access";
import GuidePage from "@/components/guide-page";
import { loadConnectorGuideTabs } from "@/components/connectors/connector-guide-tabs";

export default async function ConnectorGuidePage() {
  const session = await requireReadOnlySession();
  await requireAdmin(session);

  return (
    <GuidePage
      title="How to Create a Connector"
      back={{ href: "/admin/connectors", label: "Connectors" }}
      intro={
        <>
          Connectors are reusable integrations with external services. They live
          in the{" "}
          <code className="rounded bg-muted px-1.5 py-0.5 text-sm">
            /connectors
          </code>{" "}
          directory and can be shared across any app in the platform.
        </>
      }
      command="/mix-connector"
      usage="/mix-connector create my-connector optional notes"
      tabs={await loadConnectorGuideTabs()}
    />
  );
}
