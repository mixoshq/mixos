import { z } from "zod";
import { defineRoute } from "@/lib/apps/route";

import { pickQuoteForDate } from "../../lib/shared/quotes";

/**
 * Today's quote.
 *
 * A route rather than an import in the widget, for a reason that is not
 * ceremony. The widget is lazy-loaded inside a `"use client"` dashboard grid,
 * so it still renders on the server; a date read in both places disagrees
 * across UTC midnight and mismatches on hydrate. Deciding here means one clock
 * decides, which is also the only way "everyone sees the same quote today" is
 * true rather than approximately true.
 *
 * No `input` schema, deliberately. The obvious next field is a `date` the
 * caller passes — which would hand every browser its own day back and undo the
 * paragraph above. The server owns the date.
 */
export const GET = defineRoute({
  summary: "The WALL·E quote for the current UTC day.",
  auth: ["session"],
  output: z.object({
    text: z.string(),
    character: z.string(),
    /** The UTC day this line belongs to, `YYYY-MM-DD`. */
    date: z.string(),
  }),
  handler: async () => {
    const now = new Date();
    const quote = pickQuoteForDate(now);

    return {
      text: quote.text,
      character: quote.character,
      date: now.toISOString().slice(0, 10),
    };
  },
});
