/* This Source Code Form is subject to the terms of the Mozilla Public
 * License, v. 2.0. If a copy of the MPL was not distributed with this
 * file, You can obtain one at https://mozilla.org/MPL/2.0/. */

import type { ComponentType } from "react";
import { pageLoaders } from "@/generated/app-page-loaders";

export async function loadAppPage(
  slug: string,
  pathSegments: string[]
): Promise<ComponentType | null> {
  const pagePath = pathSegments.length > 0 ? pathSegments.join("/") + "/" : "";
  const key = `${slug}/pages/${pagePath}Main`;

  const loader = pageLoaders[key];
  if (!loader) return null;

  try {
    const mod = await loader();
    return mod.default;
  } catch (err) {
    console.error(`[loadAppPage] Failed to load ${key}:`, err);
    return null;
  }
}
