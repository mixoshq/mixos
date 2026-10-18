/* This Source Code Form is subject to the terms of the Mozilla Public
 * License, v. 2.0. If a copy of the MPL was not distributed with this
 * file, You can obtain one at https://mozilla.org/MPL/2.0/. */

import { cache } from "react";
import { createServiceClient } from "@/lib/db/server";

/**
 * Which MCP tools an admin has switched on: table `app_mcp_tool_settings`.
 *
 * A tool with no row is DISABLED. That is the whole default (a new install, a
 * new tool and a renamed tool all start off), so every reader here treats
 * "missing" and "false" identically, and only an explicit `true` lets a tool
 * through.
 *
 * Read from the database on every MCP request, never kept between requests:
 * switching a tool off must stop the next call, as revoking a grant does.
 * Within one request the answer is memoised (`cache`, React's request-scoped
 * memo, as `isAppActive` uses), so a render that asks twice reads once.
 */

/**
 * Enabled tool names per app, for the given apps. Apps with none are absent.
 *
 * FAILS CLOSED. An unreadable switch is an off switch: the cost is tools that
 * briefly disappear, and the alternative is tools an admin turned off
 * answering anyway. The admin screen reads with `readToolSwitches`, which
 * throws instead, so it never shows "all off" for a read that failed.
 */
export async function enabledToolsBySlug(
  slugs: readonly string[],
): Promise<Map<string, Set<string>>> {
  const bySlug = new Map<string, Set<string>>();
  if (slugs.length === 0) return bySlug;

  const { data, error } = await createServiceClient()
    .from("app_mcp_tool_settings")
    .select("app_slug, tool_name")
    .in("app_slug", [...slugs])
    .eq("enabled", true);
  if (error) {
    console.error("[mcp] tool switches unreadable, treating every tool as off:", error.message);
    return bySlug;
  }

  for (const row of data as { app_slug: string; tool_name: string }[]) {
    const set = bySlug.get(row.app_slug) ?? new Set<string>();
    set.add(row.tool_name);
    bySlug.set(row.app_slug, set);
  }
  return bySlug;
}

/** One app's enabled tool names, read once per request. Fails closed. */
export const enabledTools = cache(async (slug: string): Promise<ReadonlySet<string>> => {
  return (await enabledToolsBySlug([slug])).get(slug) ?? new Set<string>();
});

/**
 * One app's switches as stored, for the admin screen: tool name to enabled.
 * Throws when the table can't be read, rather than reporting every tool off.
 */
export async function readToolSwitches(slug: string): Promise<Map<string, boolean>> {
  const { data, error } = await createServiceClient()
    .from("app_mcp_tool_settings")
    .select("tool_name, enabled")
    .eq("app_slug", slug);
  if (error) throw new Error("Could not read the tool switches.");
  return new Map(
    (data as { tool_name: string; enabled: boolean }[]).map((r) => [r.tool_name, r.enabled]),
  );
}

export async function setToolEnabled(opts: {
  slug: string;
  toolName: string;
  enabled: boolean;
  updatedBy: string;
}): Promise<void> {
  const { error } = await createServiceClient()
    .from("app_mcp_tool_settings")
    .upsert({
      app_slug: opts.slug,
      tool_name: opts.toolName,
      enabled: opts.enabled,
      updated_by: opts.updatedBy,
      updated_at: new Date().toISOString(),
    });
  if (error) throw new Error("Could not save the tool switch.");
}
