/* This Source Code Form is subject to the terms of the Mozilla Public
 * License, v. 2.0. If a copy of the MPL was not distributed with this
 * file, You can obtain one at https://mozilla.org/MPL/2.0/. */

import { appRegistry } from "@/generated/app-registry";
import { connectorRegistry } from "@/generated/connector-registry";
import type { BaseConnector } from "@/lib/connectors/types";
import { getUserById, hasAppGrant } from "@/lib/apps/access";
import { createReadOnlyScopedClient } from "@/lib/apps/scoped-db";
import { recordMcpCall } from "@/lib/apps/telemetry";
import type { McpToolContext } from "@/lib/hooks/types";
import { safeErrorMessage } from "@/lib/safe-error";
import { loadTool, parseToolName } from "./tools";
import type { TokenPrincipal } from "./store";

/**
 * MCP tool broker — the one path from an MCP client to an app's data.
 *
 * Mirrors the App Services broker (src/lib/apps/services.ts) deliberately: same
 * fail-closed stance, same re-authorize-in-the-provider's-terms rule, same
 * timeout / payload-cap / error-isolation guarantees. The differences are all
 * consequences of the caller being a model rather than another app:
 *
 *   - the caller is a *user* via an OAuth token, so consent is checked as well
 *     as authorization;
 *   - the context is read-only;
 *   - errors come back as tool results the model can read and retry from,
 *     rather than as exceptions.
 */

/**
 * 30s, not the App Services broker's 10s. A tool commonly fronts a multi-call
 * CRM crawl (the account book pages every active company, their deal
 * associations, and their tickets — ~15s cold), and a timeout that a legitimate
 * tool trips half the time is worse than a slightly long wait: the model gets a
 * failure it can't act on. Still bounded, and tools are expected to serve from
 * cache and paginate rather than lean on this.
 */
const REQUEST_TIMEOUT_MS = 30_000;
/**
 * ~1 MB serialized. Well above anything a well-built tool should return (aim
 * for tens of KB — see docs/apps/mcp.md) and well below what would wedge a
 * client's context window. A hard error beats silent truncation: a truncated
 * answer looks authoritative and is wrong.
 */
const MAX_PAYLOAD_CHARS = 1_000_000;

export type McpErrorCode =
  | "NOT_FOUND" // no such app
  | "NOT_EXPOSED" // app doesn't declare this tool
  | "NOT_CONSENTED" // user didn't authorize this app for this client
  | "FORBIDDEN_USER" // user no longer has a grant for the app
  | "NO_HANDLER" // handler file missing / malformed
  | "INVALID_INPUT" // arguments failed the tool's Zod schema
  | "TIMEOUT"
  | "PAYLOAD_TOO_LARGE"
  | "TOOL_ERROR"; // handler threw

export class McpToolError extends Error {
  code: McpErrorCode;
  /** Extra detail safe to hand back to the model (e.g. Zod issues). */
  details?: unknown;
  constructor(code: McpErrorCode, message: string, details?: unknown) {
    super(message);
    this.name = "McpToolError";
    this.code = code;
    this.details = details;
  }
}

/**
 * Invoke a tool by its client-facing `<slug>__<tool>` name. Throws McpToolError;
 * the route turns that into an MCP tool result with `isError: true`.
 */
export async function callTool(
  principal: TokenPrincipal,
  fullToolName: string,
  args: unknown,
): Promise<unknown> {
  const parsed = parseToolName(fullToolName);
  if (!parsed) {
    throw new McpToolError("NOT_FOUND", `Unknown tool "${fullToolName}".`);
  }
  const { slug, toolName } = parsed;

  // Gate 1 — consent, checked FIRST and against the token alone, before any
  // registry lookup. The token's granted_apps is the ceiling the user set at the
  // consent screen; it cannot be widened by anything that happens later.
  //
  // Order matters for more than correctness: checking app existence first would
  // let any token holder enumerate apps they have no grant for (an unknown app
  // and a real-but-not-granted one would answer differently). Answering from the
  // consent list alone makes those two cases indistinguishable.
  if (!principal.grantedApps.includes(slug)) {
    throw new McpToolError(
      "NOT_CONSENTED",
      `This connection is not authorized to read "${slug}". The user can grant it at /account/mcp.`,
    );
  }

  const manifest = appRegistry.find((a) => a.slug === slug);
  if (!manifest) {
    throw new McpToolError("NOT_FOUND", `Unknown tool "${fullToolName}".`);
  }

  const tool = manifest.mcp.find((t) => t.name === toolName);
  if (!tool) {
    throw new McpToolError(
      "NOT_EXPOSED",
      `"${manifest.name}" does not expose a tool "${toolName}".`,
    );
  }

  // Gate 2 — live authorization. Re-checked on every call, never cached on the
  // token: revoking a user's app grant must take effect immediately.
  const granted = await hasAppGrant(principal.userId, slug);
  if (!granted) {
    throw new McpToolError(
      "FORBIDDEN_USER",
      `You don't have access to "${manifest.name}".`,
    );
  }

  const loaded = await loadTool(slug, toolName);
  if (!loaded) {
    throw new McpToolError(
      "NO_HANDLER",
      `"${fullToolName}" has no usable handler on disk.`,
    );
  }

  // Validate before building context — no point paying for connector init on a
  // malformed call. Zod issues go back to the model verbatim: they are precise,
  // contain no server internals, and the model can correct itself from them.
  const validated = loaded.inputSchema.safeParse(args ?? {});
  if (!validated.success) {
    throw new McpToolError(
      "INVALID_INPUT",
      `Invalid arguments for "${fullToolName}".`,
      validated.error.issues.map((i) => ({
        path: i.path.join("."),
        message: i.message,
      })),
    );
  }

  const ctx = await buildMcpToolContext(slug, principal);

  void recordMcpCall({
    appSlug: slug,
    toolName,
    clientId: principal.clientId,
    userId: principal.userId,
  });

  let result: unknown;
  try {
    result = await withTimeout(
      Promise.resolve(loaded.handler(ctx, validated.data)),
      REQUEST_TIMEOUT_MS,
    );
  } catch (err) {
    if (err instanceof McpToolError) throw err;
    console.error(`[mcp] ${fullToolName} threw:`, err);
    throw new McpToolError(
      "TOOL_ERROR",
      safeErrorMessage(err, `"${fullToolName}" failed.`),
    );
  }

  if (result === undefined) return {};

  let serialized: string;
  try {
    serialized = JSON.stringify(result);
  } catch {
    throw new McpToolError(
      "TOOL_ERROR",
      `"${fullToolName}" returned a non-serializable result.`,
    );
  }
  if (serialized.length > MAX_PAYLOAD_CHARS) {
    throw new McpToolError(
      "PAYLOAD_TOO_LARGE",
      `"${fullToolName}" returned too much data (${Math.round(serialized.length / 1024)} KB). Narrow the request with filters or a smaller limit.`,
    );
  }

  return result;
}

/**
 * Refuse a mutating connector call from a read-only tool.
 *
 * `ctx.db` has been read-only three ways since MCP shipped — the type has no
 * write verbs, a runtime Proxy throws on them, and ESLint blocks the raw client.
 * Connectors were the acknowledged hole: docs/apps/mcp.md said plainly that the
 * platform "cannot know which connector methods mutate" and that "a reviewer has
 * to confirm it."
 *
 * Now a connector declares it (`telemetry[].mutates`), so the platform can. What
 * this does NOT do is guess: a method the connector never declared passes
 * through, because inferring intent from a method name would be worse than an
 * honest gap. Declaring a connector's writes is what buys the enforcement.
 */
function readOnlyConnectors(
  connectors: Record<string, BaseConnector>,
): Record<string, BaseConnector> {
  const wrapped: Record<string, BaseConnector> = {};
  for (const [name, connector] of Object.entries(connectors)) {
    const declared = connectorRegistry.find((c) => c.name === name);
    const mutating = new Set(
      (declared?.telemetry ?? []).filter((m) => m.mutates).map((m) => m.method),
    );
    if (mutating.size === 0) {
      wrapped[name] = connector;
      continue;
    }
    wrapped[name] = new Proxy(connector, {
      get(target, prop) {
        // `target` as the receiver, not the proxy: a connector's getters read
        // their own private fields, and routing `this` back through the proxy
        // turns a working getter into a runtime error.
        const value = Reflect.get(target, prop, target);
        if (typeof value !== "function" || !mutating.has(String(prop))) {
          return value;
        }
        return () => {
          throw new McpToolError(
            "TOOL_ERROR",
            `"${name}.${String(prop)}" changes data upstream and cannot be called from an MCP tool. Tools answer questions; they do not act.`,
          );
        };
      },
    }) as BaseConnector;
  }
  return wrapped;
}

/**
 * Build the app's own context, then narrow it for a tool: swap the scoped DB for
 * a read-only one, drop `notifications` and `hooks`, and stamp the caller.
 *
 * Reusing `buildAppContext` is the point — a tool gets exactly the connectors,
 * roles, and scoped DB that the app's own API routes get for this user, so
 * there is no second, subtly-different authorization surface to keep in step.
 */
async function buildMcpToolContext(
  slug: string,
  principal: TokenPrincipal,
): Promise<McpToolContext> {
  const dbUser = await getUserById(principal.userId);
  if (!dbUser) {
    // The token references a user row that no longer exists.
    throw new McpToolError("FORBIDDEN_USER", "This account is no longer active.");
  }

  // Dynamic import mirrors services.ts: keeps a static cycle from forming with
  // the context builder.
  const { buildAppContext } = await import("@/lib/apps/context");
  const appCtx = await buildAppContext(slug, {
    id: dbUser.id,
    email: dbUser.email,
    display_name: dbUser.display_name,
    is_admin: dbUser.is_admin,
  });

  return {
    user: appCtx.user,
    connectors: readOnlyConnectors(appCtx.connectors),
    db: appCtx.manifest.database ? createReadOnlyScopedClient(slug) : null,
    telemetry: appCtx.telemetry,
    services: appCtx.services,
    manifest: appCtx.manifest,
    caller: {
      kind: "mcp",
      clientId: principal.clientId,
      clientName: principal.clientName,
    },
  };
}

function withTimeout<T>(p: Promise<T>, ms: number): Promise<T> {
  return new Promise<T>((resolve, reject) => {
    const timer = setTimeout(
      () =>
        reject(
          new McpToolError("TIMEOUT", "The tool took too long and was cancelled."),
        ),
      ms,
    );
    p.then(
      (v) => {
        clearTimeout(timer);
        resolve(v);
      },
      (e) => {
        clearTimeout(timer);
        reject(e);
      },
    );
  });
}
