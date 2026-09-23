/* This Source Code Form is subject to the terms of the Mozilla Public
 * License, v. 2.0. If a copy of the MPL was not distributed with this
 * file, You can obtain one at https://mozilla.org/MPL/2.0/. */

import { promises as fs } from "node:fs";
import path from "node:path";
import { type GuideTabDef } from "@/components/guide-tabs-shell";
import { splitGuideSections } from "@/lib/guides/sections";

const TABS: Array<{ id: string; label: string; file: string }> = [
  { id: "architecture", label: "Architecture", file: "architecture.md" },
  { id: "authoring", label: "Authoring", file: "authoring.md" },
  { id: "tokens", label: "Tokens", file: "tokens.md" },
  { id: "contrast", label: "Contrast", file: "contrast.md" },
  { id: "assets", label: "Assets", file: "assets.md" },
];

async function readDoc(file: string): Promise<string> {
  const filePath = path.join(process.cwd(), "docs", "themes", file);
  return fs.readFile(filePath, "utf8");
}

export async function loadThemeGuideTabs(): Promise<GuideTabDef[]> {
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
