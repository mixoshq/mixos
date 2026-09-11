/* This Source Code Form is subject to the terms of the Mozilla Public
 * License, v. 2.0. If a copy of the MPL was not distributed with this
 * file, You can obtain one at https://mozilla.org/MPL/2.0/. */

import { requireReadOnlySession } from "@/lib/auth/session";
import { requireAdmin } from "@/lib/apps/access";
import GuidePage from "@/components/guide-page";
import { loadAppGuideTabs } from "@/components/apps/guide-tabs";

export default async function AppGuidePage() {
  // Gated like the registry it sits beside: authoring an app is an admin act,
  // and the guide is reached from /admin/apps.
  const session = await requireReadOnlySession();
  await requireAdmin(session);

  return (
    <GuidePage
      title="How to Create an App"
      back={{ href: "/admin/apps", label: "Apps" }}
      intro={
        <>
          Apps are self-contained plugins that live in the{" "}
          <code className="rounded bg-muted px-1.5 py-0.5 text-sm">/apps</code>{" "}
          directory. Each app gets its own folder with a manifest, pages,
          widgets, and optional hooks.
        </>
      }
      command="/mix-app"
      usage="/mix-app create my-app-slug optional notes about the app"
      tabs={await loadAppGuideTabs()}
    />
  );
}
