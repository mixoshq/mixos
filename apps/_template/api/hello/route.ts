import { z } from "zod";
import { defineRoute } from "@/lib/apps/route";

/**
 * Example API route.
 *
 * A route is a DECLARATION, not a bare function. Everything above `handler`
 * has to be readable by something other than the handler: the build checks the
 * roles against your manifest, the gateway enforces the auth set before your
 * code runs, and the generated client types itself from the schemas. That is
 * why `export async function GET(...)` fails the build.
 *
 * What you get for declaring it:
 *
 *   - `input` is parsed, coerced from the query string, and validated before
 *     your handler runs. Omit it and your handler receives `{}` — an undeclared
 *     input is not merely unvalidated, it is unavailable.
 *   - `output` is validated on the way out, so your route can never quietly
 *     return a shape your widget doesn't expect.
 *   - You return plain data. The platform serializes it, picks the status, and
 *     turns a thrown `AppError` into the right code — no `NextResponse`, no
 *     hand-written 404, and no chance of leaking a driver message.
 *   - `budget` caps connector calls and wall clock, so a route that turns into
 *     an N+1 fails loudly instead of quietly costing thirty seconds.
 *
 * Call it from a widget or page with `createAppClient("_template")`.
 */
export const GET = defineRoute({
  summary: "Greet the signed-in user.",
  auth: ["session"],
  input: z.object({
    /** Try `/hello?shout=true`. Query strings are coerced to the declared type. */
    shout: z.boolean().default(false),
  }),
  output: z.object({
    message: z.string(),
  }),
  handler: async (context, input) => {
    const message = `Hello, ${context.user.displayName}!`;
    return { message: input.shout ? message.toUpperCase() : message };
  },
});
