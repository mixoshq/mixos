/* This Source Code Form is subject to the terms of the Mozilla Public
 * License, v. 2.0. If a copy of the MPL was not distributed with this
 * file, You can obtain one at https://mozilla.org/MPL/2.0/. */

import type { ComponentType } from "react";
import { pageLoaders } from "@/generated/app-page-loaders";

function pageKey(slug: string, pathSegments: string[]): string {
  const pagePath = pathSegments.length > 0 ? pathSegments.join("/") + "/" : "";
  return `${slug}/pages/${pagePath}Main`;
}

/** Whether the app has a page at this path, without loading it. */
export function hasAppPage(slug: string, pathSegments: string[]): boolean {
  return pageLoaders[pageKey(slug, pathSegments)] !== undefined;
}

export async function loadAppPage(
  slug: string,
  pathSegments: string[]
): Promise<ComponentType | null> {
  const key = pageKey(slug, pathSegments);

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
