"use client";

import Link from "next/link";
import type { WidgetProps } from "@/lib/hooks/types";
import { useAppQuery } from "@/lib/apps/use-app-query";
import { AsyncView } from "@/components/ui/async-view";
import { Skeleton } from "@/components/ui/skeleton";
import { Button } from "@/components/ui/button";

/**
 * A widget, built the way every widget should be.
 *
 * `useAppQuery` + `AsyncView` is the pair that makes ux.md's state rules
 * structural rather than remembered. You cannot render the data branch without
 * supplying a `skeleton` and an `empty` that names its cause — the types will
 * not let you — and loading, refetching and error are handled for you:
 *
 *   - the skeleton mirrors the loaded layout, so nothing shifts when data lands,
 *   - a refetch keeps the previous data visible instead of flashing an anonymous
 *     shimmer at someone who just clicked something,
 *   - an error gets a calm message and a retry, never a raw error string.
 *
 * The controls come from the primitives for the same reason: `Button` makes the
 * pending state one prop, and a raw `<button>` here is a lint error.
 */
export default function HelloWidget({ appSlug }: WidgetProps) {
  const query = useAppQuery<{ message: string }>(appSlug, "GET /hello");

  return (
    <div className="flex h-full flex-col items-center justify-center gap-3 p-4 text-center">
      <AsyncView
        query={query}
        skeleton={
          <div className="flex flex-col items-center gap-2">
            <Skeleton className="h-7 w-40" />
            <Skeleton className="h-4 w-20" />
          </div>
        }
        empty={{
          cause: "no-data",
          title: "No greeting yet",
          body: "The hello route returned nothing to show.",
        }}
        // The payload is a single object, not a list, so emptiness is a
        // question only this widget can answer.
        isEmpty={(data) => !data.message}
      >
        {(data) => (
          <>
            <p className="text-2xl font-bold text-foreground">{data.message}</p>
            <p className="text-sm text-muted-foreground">Welcome!</p>
          </>
        )}
      </AsyncView>

      <Button variant="primary" size="sm" onClick={query.refetch}>
        Refresh
      </Button>
      <Link
        href={`/apps/${appSlug}`}
        className="text-xs text-muted-foreground underline underline-offset-2 hover:text-foreground"
      >
        Open app
      </Link>
    </div>
  );
}
