/* This Source Code Form is subject to the terms of the Mozilla Public
 * License, v. 2.0. If a copy of the MPL was not distributed with this
 * file, You can obtain one at https://mozilla.org/MPL/2.0/. */

import { z } from "zod";
import { appRegistry } from "@/generated/app-registry";
import { connectorRegistry } from "@/generated/connector-registry";
import type { AppManifest, McpToolDefinition } from "@/lib/apps/types";
import { MIXOS_SOURCE } from "@/lib/apps/types";
import type { McpToolContext } from "@/lib/hooks/types";
import { hasAppGrant } from "@/lib/apps/access";
import { checkAppGate } from "@/lib/apps/app-gate";

/**
 * Tool discovery and naming for the MixOS MCP server.
 *
 * A tool is reachable only at the intersection of three independent gates:
 *
 *   1. the app DECLARES it (`mcp` in app.json, handler on disk, build-validated);
 *   2. the user CONSENTED to the app for this client (token's `granted_apps`);
 *   3. the user still HAS the app (`hasAppGrant`, re-checked live on every call).
 *
 * (2) is a ceiling and (3) is a floor: an admin revoking a grant removes the
 * tools immediately, without the user having to re-consent, and re-granting
 * does not silently re-expand a consent the user never gave.
 *
 * And then the app gate (src/lib/apps/app-gate.ts), before a tool's module is
 * imported: while the app's own migrations are behind this build its tools
 * are not listed, and a call to one refuses until the release step has run.
 *
 * `hasAppGrant` — not `hasAppAccess` — is deliberate. "Installed" is a
 * dashboard-layout preference; "granted" is the authorization fact, and it is
 * what the App Services broker already uses for exactly this question.
 */

/** Separator between app slug and tool name in the client-facing tool name. */
const NS = "__";

export function toolFullName(slug: string, toolName: string): string {
  return `${slug}${NS}${toolName}`;
}

/**
 * Split a client-supplied tool name back into (slug, tool). Splits on the FIRST
 * separator; the generator guarantees neither side contains `__`, so this is
 * unambiguous.
 */
export function parseToolName(
  full: string,
): { slug: string; toolName: string } | null {
  const at = full.indexOf(NS);
  if (at < 1) return null;
  const slug = full.slice(0, at);
  const toolName = full.slice(at + NS.length);
  if (!slug || !toolName) return null;
  return { slug, toolName };
}

/** Every app that declares at least one MCP tool, in registry order. */
export function appsWithMcpTools(): AppManifest[] {
  return appRegistry.filter((a) => a.mcp.length > 0);
}

/**
 * Apps this user may be offered on the consent screen: declares tools AND the
 * user holds a grant. Ordered by display name so the screen is stable.
 */
export async function consentableApps(userId: string): Promise<AppManifest[]> {
  const candidates = appsWithMcpTools();
  const granted = await Promise.all(
    candidates.map((a) => hasAppGrant(userId, a.slug)),
  );
  return candidates
    .filter((_, i) => granted[i])
    .sort((a, b) => a.name.localeCompare(b.name));
}

/**
 * Apps reachable right now for a given token: consented AND still granted AND
 * let through by the app gate (src/lib/apps/app-gate.ts). `grantedApps` comes
 * from the token, `hasAppGrant` and the gate from the database.
 *
 * The gate is asked because listing a tool imports its module, for its input
 * schema. An app whose own migrations are behind this build runs no code, so
 * its tools are left out of the list until the release step has run, and a
 * call to one refuses with "This app is being updated" (`./broker.ts`).
 */
export async function reachableApps(
  userId: string,
  consentedSlugs: readonly string[],
): Promise<AppManifest[]> {
  const consented = new Set(consentedSlugs);
  const candidates = appsWithMcpTools().filter((a) => consented.has(a.slug));
  const reachable = await Promise.all(
    candidates.map(
      async (a) =>
        (await hasAppGrant(userId, a.slug)) && (await checkAppGate(a.slug)).open,
    ),
  );
  return candidates.filter((_, i) => reachable[i]);
}

export type McpToolHandler = (
  ctx: McpToolContext,
  input: unknown,
) => unknown | Promise<unknown>;

export interface LoadedTool {
  inputSchema: z.ZodType;
  handler: McpToolHandler;
}

/**
 * Dynamically import a tool handler. Template-literal import, matching how the
 * platform already loads API routes, jobs, and service handlers — Turbopack
 * tolerates it for these subtrees (only the page/widget maps need to be static).
 */
export async function loadTool(
  slug: string,
  toolName: string,
): Promise<LoadedTool | null> {
  let mod: { default?: unknown; inputSchema?: unknown };
  try {
    mod = await import(`@apps/${slug}/mcp/${toolName}`);
  } catch (err) {
    console.error(`[mcp] failed to import ${slug}/mcp/${toolName}:`, err);
    return null;
  }
  if (typeof mod.default !== "function") return null;
  // Duck-type rather than `instanceof z.ZodType`: an app could conceivably
  // resolve a different copy of zod, and the only capability we need is parsing.
  const schema = mod.inputSchema as z.ZodType | undefined;
  if (!schema || typeof (schema as { safeParse?: unknown }).safeParse !== "function") {
    return null;
  }
  return { inputSchema: schema, handler: mod.default as McpToolHandler };
}

export interface ToolListEntry {
  name: string;
  description: string;
  inputSchema: Record<string, unknown>;
  annotations: { readOnlyHint: true; title: string };
}

/** Connector slug -> display name, for the provenance line. */
const CONNECTOR_LABELS = new Map(
  connectorRegistry.map((c) => [c.name, c.displayName]),
);

/** Join names as prose: "A", "A and B", "A, B and C". */
function conjoin(names: readonly string[]): string {
  if (names.length <= 1) return names[0] ?? "";
  return `${names.slice(0, -1).join(", ")} and ${names[names.length - 1]}`;
}

/**
 * The provenance line appended to every tool description.
 *
 * It exists to keep our tools from quietly outranking the user's other
 * connectors. A client pools every server's tools into one flat list, where a
 * tool that describes its data ("closed-won ARR for the quarter") and a tool
 * that claims a topic ("start here for any sales question") compete directly —
 * and the claim wins, whether or not it deserves to. Rather than answer that by
 * stripping our descriptions back to bare mechanics, which would just push the
 * model toward raw connectors that can't do these joins, we state the shape of
 * the claim: this is a cached join over named systems, and those systems' own
 * connectors still hold the records underneath. That is a claim a better-suited
 * tool can beat.
 */
function builtFrom(sources: readonly string[]): string {
  const upstream = sources.filter((s) => s !== MIXOS_SOURCE);
  if (upstream.length === 0) {
    return "Built from: records kept in MixOS itself, not mirrored from a connected system.";
  }
  const labels = upstream.map((s) => CONNECTOR_LABELS.get(s) ?? s);
  const alsoMixos = sources.length > upstream.length ? ", plus records kept in MixOS" : "";
  return (
    `Built from: ${conjoin(labels)}${alsoMixos} — joined and cached in MixOS, ` +
    `scoped to what you can already see there; ` +
    `${upstream.length === 1 ? "that system's own connector holds" : "those systems' own connectors hold"} the raw records.`
  );
}

/**
 * Assemble the single string a client sees for one tool: what it returns, when
 * to reach for it, where the data came from, and what it doesn't have. Order
 * matters — the specific claim leads, and the two lines that bound it follow,
 * so a truncating client loses the qualifiers last rather than first.
 */
function composeDescription(tool: McpToolDefinition): string {
  const parts = [tool.description];
  if (tool.hint) parts.push(tool.hint);
  const footer = [builtFrom(tool.sources)];
  if (tool.notCovered) footer.push(`Not covered: ${tool.notCovered}`);
  parts.push(footer.join("\n"));
  return parts.join("\n\n");
}

/**
 * Build one client-facing tool descriptor, or null if the handler can't be
 * loaded or its schema can't be expressed as JSON Schema. Returning null (and
 * logging) rather than throwing keeps one malformed tool from blanking the
 * whole `tools/list` for every app the user consented to.
 */
export async function describeTool(
  manifest: AppManifest,
  tool: McpToolDefinition,
): Promise<ToolListEntry | null> {
  const loaded = await loadTool(manifest.slug, tool.name);
  if (!loaded) {
    console.error(
      `[mcp] omitting ${manifest.slug}__${tool.name} — handler or inputSchema missing`,
    );
    return null;
  }

  let jsonSchema: Record<string, unknown>;
  try {
    jsonSchema = z.toJSONSchema(loaded.inputSchema, {
      // MCP clients want a self-contained schema per tool; `io: "input"` keeps
      // the schema describing what the caller sends rather than what the parse
      // produces (they differ once defaults or transforms are involved).
      io: "input",
    }) as Record<string, unknown>;
  } catch (err) {
    console.error(
      `[mcp] omitting ${manifest.slug}__${tool.name} — inputSchema is not expressible as JSON Schema:`,
      err,
    );
    return null;
  }

  // MCP requires an object schema at the top level.
  if (jsonSchema.type !== "object") {
    jsonSchema = { type: "object", properties: {}, additionalProperties: false };
  }

  const description = composeDescription(tool);

  return {
    name: toolFullName(manifest.slug, tool.name),
    // Prefixing the owning app makes a flat, cross-app list legible to the
    // model: "Sales — closed-won ARR…" reads better than a bare sentence when
    // twenty tools from six apps sit side by side.
    description: `[${manifest.name}] ${description}`,
    inputSchema: jsonSchema,
    annotations: { readOnlyHint: true, title: `${manifest.name}: ${tool.name}` },
  };
}
