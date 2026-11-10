"use client";

import { useEffect } from "react";
import type { WidgetProps } from "@/lib/hooks/types";
import { useAppQuery } from "@/lib/apps/use-app-query";
import { AsyncView } from "@/components/ui/async-view";
import { Skeleton } from "@/components/ui/skeleton";

interface HourlyQuote {
  text: string;
  character: string;
  /** When this line is replaced, ISO-8601, decided by the server. */
  nextChangeAt: string;
}

/**
 * One line from WALL·E, chosen at random, changing on the hour.
 *
 * IT REFETCHES ON THE BOUNDARY, NOT ON AN INTERVAL. The server says when the
 * line changes (`nextChangeAt`); the widget sleeps until then and asks again.
 * A `setInterval(…, 3600_000)` would drift off the hour by however long the
 * tab took to load, and a tab left open overnight would change the line at
 * 9:43 rather than at 10:00. It also re-checks when the tab becomes visible:
 * background timers are throttled to minutes in every browser, so the one
 * moment the widget must be right — someone looking at it again — is the one
 * a timer alone cannot be trusted for.
 *
 * Zero config by design: there is no title field, no character filter, no
 * rotation setting. You add it and it works.
 *
 * Everything is `text-foreground` / `text-muted-foreground` on the widget's own
 * card. No tinted surface, which is not an aesthetic call — `text-muted-foreground`
 * on `bg-muted` measures 4.34:1 and fails the contrast rule, and the byline is
 * exactly the element that would have gone there.
 *
 * The two-element shell exists for the small sizes. The widget can be resized
 * down to 2×2, and the longest quote in the list does not fit there at any font
 * size worth reading — so the outer element scrolls and the inner one carries
 * `min-h-full` with `justify-center`. Short quotes sit centred; a long one in a
 * cramped card scrolls instead of bleeding past the card edge.
 */
export default function QuoteOfTheDayWidget({ appSlug }: WidgetProps) {
  const query = useAppQuery<HourlyQuote>(appSlug, "GET /quote");
  const { refetch } = query;
  const nextChangeAt = query.state.data?.nextChangeAt ?? null;

  useEffect(() => {
    if (!nextChangeAt) return;
    const due = new Date(nextChangeAt).getTime();
    if (Number.isNaN(due)) return;

    // At least a second, so a clock a little behind the server cannot spin
    // this into a refetch loop.
    const timer = window.setTimeout(refetch, Math.max(1000, due - Date.now()));
    const onVisible = () => {
      if (document.visibilityState === "visible" && Date.now() >= due) {
        refetch();
      }
    };
    document.addEventListener("visibilitychange", onVisible);

    return () => {
      clearTimeout(timer);
      document.removeEventListener("visibilitychange", onVisible);
    };
  }, [nextChangeAt, refetch]);

  return (
    <div className="h-full overflow-y-auto p-4">
      <div className="flex min-h-full flex-col justify-center">
        <AsyncView
          query={query}
          // Two text lines and a short byline, at the sizes and gaps the loaded
          // state uses, so nothing moves when the quote lands.
          skeleton={
            <div className="flex flex-col gap-3">
              <Skeleton className="h-5 w-5 rounded-sm" />
              <div className="flex flex-col gap-2">
                <Skeleton className="h-4 w-full" />
                <Skeleton className="h-4 w-4/5" />
              </div>
              <Skeleton className="h-3 w-28" />
            </div>
          }
          // The payload is one object, so emptiness is a question only this
          // widget can answer: a quote with no text is the only empty there is.
          isEmpty={(data) => !data.text}
          empty={{
            cause: "no-data",
            title: "No quote today",
            body: "The quote list came back empty.",
          }}
        >
          {(quote) => (
            <figure className="flex flex-col gap-3">
              <blockquote className="text-pretty text-base font-medium leading-snug text-foreground">
                {quote.text}
              </blockquote>
              <figcaption className="text-xs text-muted-foreground">
                — {quote.character}
              </figcaption>
            </figure>
          )}
        </AsyncView>
      </div>
    </div>
  );
}
