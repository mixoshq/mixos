/* This Source Code Form is subject to the terms of the Mozilla Public
 * License, v. 2.0. If a copy of the MPL was not distributed with this
 * file, You can obtain one at https://mozilla.org/MPL/2.0/. */

"use server";

import { revalidatePath } from "next/cache";
import { z } from "zod";
import { appRegistry } from "@/generated/app-registry";
import { requireReadOnlySession } from "@/lib/auth/session";
import { requireAdmin } from "@/lib/apps/access";
import { recordAdminAction } from "@/lib/apps/admin-audit";
import { readToolSwitches, setToolEnabled } from "./tool-settings";

/**
 * The MCP tab's switches, one per tool an app declares.
 *
 * Each export is a directly invocable POST endpoint, so each checks
 * `requireAdmin()` itself before it reads anything else, and a change is
 * audited as `app.mcp.tool.enable` or `app.mcp.tool.disable`. A refusal comes
 * back as a value, since a thrown error reaches the browser as an opaque digest
 * in production.
 */

export type ToolSwitchResult = { ok: true } | { ok: false; message: string };

async function admin() {
  return requireAdmin(await requireReadOnlySession());
}

const SlugInput = z.string().min(1).max(100);
const SwitchInput = z.object({
  slug: SlugInput,
  toolName: z.string().min(1).max(100),
  enabled: z.boolean(),
});

/** Each declared tool's switch, in manifest order. A tool with no row is off. */
export async function getMcpToolSettings(slug: string): Promise<Record<string, boolean>> {
  await admin();
  const parsed = SlugInput.safeParse(slug);
  const app = parsed.success ? appRegistry.find((a) => a.slug === parsed.data) : undefined;
  if (!app) throw new Error("App not found in registry.");

  const stored = await readToolSwitches(app.slug);
  return Object.fromEntries(app.mcp.map((t) => [t.name, stored.get(t.name) === true]));
}

export async function setMcpToolEnabledAction(
  slug: string,
  toolName: string,
  enabled: boolean,
): Promise<ToolSwitchResult> {
  const actor = await admin();
  const input = SwitchInput.safeParse({ slug, toolName, enabled });
  if (!input.success) return { ok: false, message: "That request isn't valid." };

  const app = appRegistry.find((a) => a.slug === input.data.slug);
  if (!app) return { ok: false, message: "That app isn't in this build." };
  // Only a tool the manifest declares. A row for any other name would be inert,
  // and accepting one would put a switch in the audit trail that does nothing.
  if (!app.mcp.some((t) => t.name === input.data.toolName)) {
    return { ok: false, message: `${app.name} declares no MCP tool "${input.data.toolName}".` };
  }

  await setToolEnabled({
    slug: app.slug,
    toolName: input.data.toolName,
    enabled: input.data.enabled,
    updatedBy: actor.id,
  });
  await recordAdminAction(
    { id: actor.id, email: actor.email },
    {
      action: input.data.enabled ? "app.mcp.tool.enable" : "app.mcp.tool.disable",
      targetType: "app",
      targetId: app.slug,
      details: { tool: input.data.toolName },
    },
  );
  revalidatePath("/admin/apps");
  revalidatePath("/account/mcp");
  return { ok: true };
}
