import { z } from "zod";
import { defineRoute, AppError } from "@/lib/apps/route";
import { countAllMessages, readMessages } from "../../lib/server/messages";
import {
  RETENTION_DAYS,
  type MessageFilter,
} from "../../lib/shared/messages";

const ActionItem = z.object({
  kind: z.enum(["assignment", "request", "question"]),
  /** The sentence that matched. Shown in the UI, so the reader can disagree. */
  text: z.string(),
  hasDeadline: z.boolean(),
});

const Message = z.object({
  id: z.string(),
  threadId: z.string(),
  receivedAt: z.string().nullable(),
  fromName: z.string().nullable(),
  fromEmail: z.string().nullable(),
  subject: z.string().nullable(),
  snippet: z.string(),
  isUnread: z.boolean(),
  hasAttachments: z.boolean(),
  actionCount: z.number(),
  actions: z.array(ActionItem),
  hasDeadline: z.boolean(),
});

export const GET = defineRoute({
  summary: "The latest messages in the shared mailbox, with detected action items.",
  auth: ["session"],
  input: z.object({
    limit: z.number().int().min(1).max(100).default(50),
    filter: z.enum(["all", "needs-action", "clear"]).default("all"),
  }),
  output: z.object({
    messages: z.array(Message),
    /** Whether an admin has connected the shared mailbox at all. */
    gmailConfigured: z.boolean(),
    /** How far back the table reaches, so the UI can say what "latest" means. */
    retentionDays: z.number(),
  }),
  handler: async (context, input) => {
    if (!context.db) throw AppError.unavailable("This app has no database.");

    // A property read, never a call: the connector is reached only by
    // `sync/messages.ts`. This is here so the page can distinguish "nobody has
    // connected a mailbox" from "the mailbox is quiet", which are the same blank
    // screen otherwise.
    const gmailConfigured = context.connectors.gmail?.configured === true;

    const messages = await readMessages(context.db, {
      limit: input.limit,
      filter: input.filter as MessageFilter,
    });

    // The cold-install case — nothing stored and no mailbox connected — is the
    // only one worth a 503, because it is the only one the user cannot fix by
    // changing a filter.
    //
    // The emptiness that matters here is the TABLE's, not this request's. Testing
    // `messages.length` alone reported "Gmail is not configured" whenever a
    // filter simply matched nothing, which is both wrong and alarming: the app
    // was working fine and the user had just asked a narrower question. The
    // extra count runs only on the empty-and-unconfigured path.
    if (messages.length === 0 && !gmailConfigured) {
      const stored = await countAllMessages(context.db);
      if (stored === 0) {
        throw AppError.unavailable(
          "Gmail is not configured. Ask an admin to connect the shared mailbox in Administration → Connectors.",
        );
      }
    }

    return { messages, gmailConfigured, retentionDays: RETENTION_DAYS };
  },
});
