import { z } from "zod";
import { defineRoute } from "@/lib/apps/route";

import { nextChangeAfter, pickQuoteForHour } from "../../lib/shared/quotes";

/**
 * This hour's quote, and when it changes.
 *
 * A route rather than an import in the widget, for a reason that is not
 * ceremony. The widget is lazy-loaded inside a `"use client"` dashboard grid,
 * so it still renders on the server; a clock read in both places disagrees
 * across an hour boundary and mismatches on hydrate. Deciding here means one
 * clock decides, which is also the only way "everyone sees the same line right
 * now" is true rather than approximately true.
 *
 * `nextChangeAt` is returned rather than left to the widget to work out. The
 * widget has to schedule its own refetch, and a boundary computed from the
 * browser's clock would fire early or late by whatever that clock is off by —
 * on a machine minutes fast, every hour, forever.
 *
 * No `input` schema, deliberately. The obvious next field is a timestamp the
 * caller passes — which would hand every browser its own hour back and undo
 * the paragraph above. The server owns the clock.
 */
export const GET = defineRoute({
  summary: "The WALL·E quote for the current hour.",
  auth: ["session"],
  output: z.object({
    text: z.string(),
    character: z.string(),
    /** When this line is replaced: the top of the next hour, ISO-8601. */
    nextChangeAt: z.string(),
  }),
  handler: async () => {
    const now = new Date();
    const quote = pickQuoteForHour(now);

    return {
      text: quote.text,
      character: quote.character,
      nextChangeAt: nextChangeAfter(now).toISOString(),
    };
  },
});
