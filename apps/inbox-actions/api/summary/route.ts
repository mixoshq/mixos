import { z } from "zod";
import { defineRoute, AppError } from "@/lib/apps/route";
import { readSummary } from "../../lib/server/messages";
import { RETENTION_DAYS } from "../../lib/shared/messages";

/**
 * Counts only.
 *
 * Separate from `GET /messages` so the stat widget doesn't pull fifty message
 * bodies to render three numbers — the "fetch only what you render" rule from
 * docs/apps/widgets.md. It is three `count` queries and no row bodies at all.
 */
export const GET = defineRoute({
  summary: "How many recent messages carry action items.",
  auth: ["session"],
  output: z.object({
    total: z.number(),
    needingAction: z.number(),
    withDeadline: z.number(),
    /** When the sync last wrote a row, ISO 8601. Null when the table is cold. */
    syncedAt: z.string().nullable(),
    gmailConfigured: z.boolean(),
    retentionDays: z.number(),
  }),
  handler: async (context) => {
    if (!context.db) throw AppError.unavailable("This app has no database.");

    const gmailConfigured = context.connectors.gmail?.configured === true;
    const summary = await readSummary(context.db);

    if (summary.total === 0 && !gmailConfigured) {
      throw AppError.unavailable(
        "Gmail is not configured. Ask an admin to connect the shared mailbox in Administration → Connectors.",
      );
    }

    return { ...summary, gmailConfigured, retentionDays: RETENTION_DAYS };
  },
});
