import type { ComponentType } from "react";
import { pageLoaders } from "@/generated/app-registry";

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
