import { z } from "zod";
import type { McpToolContext } from "@/lib/hooks/types";

/**
 * Example MCP tool.
 *
 * Declared in app.json under `mcp`, and off until an admin turns it on, on the
 * app's MCP tab. Then the MixOS MCP server invokes it when a user has connected
 * an MCP client (Claude) and ticked this app on the consent screen. It runs as
 * that user, with this app's roles resolved.
 *
 * Two exports are required, and the registry generator refuses to build without
 * them:
 *   - `inputSchema` — a Zod object. It becomes the tool's JSON Schema, which is
 *     what the model reads to work out how to call you. `.describe()` every
 *     field; those strings do real work.
 *   - a default handler — `(ctx, input) => result`. Return a plain object.
 *
 * Tools are READ-ONLY. `ctx.db` has no insert/update/upsert/delete (they're
 * absent from the type and throw at runtime), there's no `ctx.notifications`,
 * and any connector call you make must be a read.
 *
 * See docs/apps/mcp.md.
 */

export const inputSchema = z.object({
  greeting: z
    .string()
    .optional()
    .describe('Greeting word to use. Defaults to "Hello".'),
});

export default async function hello(
  ctx: McpToolContext,
  input: z.infer<typeof inputSchema>,
) {
  return {
    message: `${input.greeting ?? "Hello"}, ${ctx.user.displayName}!`,
    // Handy for showing which client is asking — `ctx.caller.clientName` is the
    // MCP client's self-reported name (display only; never trust it for authz).
    askedBy: ctx.caller.clientName,
  };
}
