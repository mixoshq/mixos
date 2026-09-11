"use client";

/**
 * How much of the shared mailbox is waiting on someone.
 *
 * Hits `GET /summary`, which is three `count` queries and no message bodies at
 * all. Pointing this at `GET /messages` would pull fifty rows of snippets and
 * evidence to render three numbers — the "fetch only what you render" mistake
 * from docs/apps/widgets.md.
 */

import Link from "next/link";
import type { WidgetProps } from "@/lib/hooks/types";
import { useAppQuery } from "@/lib/apps/use-app-query";
import { AsyncView } from "@/components/ui/async-view";
import { Skeleton } from "@/components/ui/skeleton";
import { StatusDot } from "@/components/ui/status";
import { formatReceived, type InboxSummary } from "../lib/shared/messages";

interface SummaryResult extends InboxSummary {
  gmailConfigured: boolean;
  retentionDays: number;
}

export default function ActionSummaryWidget({ appSlug }: WidgetProps) {
  const query = useAppQuery<SummaryResult>(appSlug, "GET /summary");

  return (
    <div className="flex h-full flex-col p-4">
      <AsyncView
        query={query}
        skeleton={
          <div className="space-y-2">
            <Skeleton className="h-3 w-28" />
            <Skeleton className="h-9 w-24" />
            <Skeleton className="h-3 w-36" />
          </div>
        }
        empty={{
          cause: "no-data",
          title: "Nothing synced yet",
          body: "The mailbox sync runs every 15 minutes; counts appear after its first run.",
        }}
        // A single object, not a list — emptiness is a question only this widget
        // can answer, and zero synced messages is the one that means "nothing yet".
        isEmpty={(data) => data.total === 0}
      >
        {(data) => (
          <div className="flex h-full flex-col">
            <p className="text-sm text-muted-foreground">Needs action</p>
            <p className="mt-1 text-3xl font-semibold text-foreground">
              {data.needingAction}
              <span className="ml-1 text-base font-normal text-muted-foreground">
                / {data.total}
              </span>
            </p>

            <div className="mt-2 flex items-center gap-1.5">
              <StatusDot
                tone={data.withDeadline > 0 ? "danger" : "neutral"}
                label={`${data.withDeadline} mentioning a deadline`}
              />
              <span className="text-sm text-foreground">
                {data.withDeadline} mention a deadline
              </span>
            </div>

            <p className="mt-auto pt-2 text-xs text-muted-foreground">
              Shared mailbox, last {data.retentionDays} days · synced{" "}
              {formatReceived(data.syncedAt).toLowerCase()}
            </p>

            <Link
              href={`/apps/${appSlug}?filter=needs-action`}
              className="mt-1 text-xs text-muted-foreground underline underline-offset-2 hover:text-foreground"
            >
              Open triage board
            </Link>
          </div>
        )}
      </AsyncView>
    </div>
  );
}
