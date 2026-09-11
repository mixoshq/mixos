"use client";

/**
 * The messages currently asking for something, most recent first, each with the
 * line that asked.
 *
 * Requests `filter=needs-action` rather than pulling everything and filtering in
 * the browser: the route can answer that with an indexed `action_count > 0`, and
 * a widget should ask for exactly the rows it renders.
 */

import Link from "next/link";
import type { WidgetProps } from "@/lib/hooks/types";
import { useAppQuery } from "@/lib/apps/use-app-query";
import { AsyncView } from "@/components/ui/async-view";
import { Skeleton } from "@/components/ui/skeleton";
import { ActionStatus } from "../components/action-evidence";
import {
  formatReceived,
  senderLabel,
  type InboxMessage,
} from "../lib/shared/messages";

/** Enough to be useful at the default widget size without becoming a page. */
const LIMIT = 8;

interface MessagesResult {
  messages: InboxMessage[];
  gmailConfigured: boolean;
  retentionDays: number;
}

export default function ActionInboxWidget({ appSlug }: WidgetProps) {
  const query = useAppQuery<MessagesResult>(appSlug, "GET /messages", {
    limit: LIMIT,
    filter: "needs-action",
  });

  return (
    <div className="flex h-full flex-col p-4">
      <div className="mb-2 flex items-baseline justify-between gap-2">
        <h3 className="text-sm font-semibold text-foreground">Needs action</h3>
        <Link
          href={`/apps/${appSlug}?filter=needs-action`}
          className="text-xs text-muted-foreground underline underline-offset-2 hover:text-foreground"
        >
          View all
        </Link>
      </div>

      <AsyncView
        query={query}
        skeleton={
          <ul className="space-y-3" aria-hidden>
            {Array.from({ length: 4 }, (_, i) => (
              <li key={i} className="space-y-1.5">
                <Skeleton className="h-4 w-full" />
                <Skeleton className="h-3 w-2/3" />
              </li>
            ))}
          </ul>
        }
        // Not a filter the user emptied — this widget is always scoped to
        // "needs action" — so an empty result is genuinely good news, not a
        // dead end needing a way out.
        empty={{
          cause: "no-match",
          title: "All clear",
          body: "No recent message in the shared mailbox has a detected action item.",
        }}
        isEmpty={(data) => data.messages.length === 0}
      >
        {(data) => (
          <ul className="min-h-0 flex-1 space-y-3 overflow-y-auto">
            {data.messages.map((message) => (
              <li key={message.id} className="space-y-1">
                <div className="flex items-baseline gap-2">
                  <span className="min-w-0 flex-1 truncate text-sm font-medium text-foreground">
                    {message.subject || "(no subject)"}
                  </span>
                  <span className="shrink-0 text-xs text-muted-foreground">
                    {formatReceived(message.receivedAt)}
                  </span>
                </div>
                <ActionStatus
                  actionCount={message.actionCount}
                  hasDeadline={message.hasDeadline}
                />
                {message.actions[0] && (
                  // One line of evidence, not all of them: the widget's job is to
                  // make the flag believable at a glance, and the page carries the
                  // full list.
                  <p className="text-xs text-muted-foreground">
                    {senderLabel(message)} — “{message.actions[0].text}”
                  </p>
                )}
              </li>
            ))}
          </ul>
        )}
      </AsyncView>
    </div>
  );
}
