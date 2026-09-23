/* This Source Code Form is subject to the terms of the Mozilla Public
 * License, v. 2.0. If a copy of the MPL was not distributed with this
 * file, You can obtain one at https://mozilla.org/MPL/2.0/. */

import { promises as fs } from "node:fs";
import path from "node:path";
import { type GuideTabDef } from "@/components/guide-tabs-shell";
import { splitGuideSections } from "@/lib/guides/sections";

const TABS: Array<{ id: string; label: string; file: string }> = [
  { id: "architecture", label: "Architecture", file: "architecture.md" },
  { id: "implementation", label: "Implementation", file: "implementation.md" },
  { id: "usage", label: "Usage in Apps", file: "usage-in-apps.md" },
  { id: "failures", label: "Failure Handling", file: "failure-handling.md" },
  { id: "credentials", label: "Credentials", file: "credentials.md" },
  { id: "scopes", label: "Scopes", file: "scopes.md" },
  { id: "registry-ux", label: "Registry UX", file: "registry-ux.md" },
  { id: "webhooks", label: "Webhooks", file: "webhooks.md" },
  { id: "telemetry", label: "Telemetry", file: "telemetry.md" },
];

async function readDoc(file: string): Promise<string> {
  const filePath = path.join(process.cwd(), "docs", "connectors", file);
  return fs.readFile(filePath, "utf8");
}

export async function loadConnectorGuideTabs(): Promise<GuideTabDef[]> {
  return Promise.all(
    TABS.map(async (t) => {
      return {
        id: t.id,
        label: t.label,
        ...splitGuideSections(await readDoc(t.file)),
      };
    }),
  );
}
