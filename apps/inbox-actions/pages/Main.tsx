"use client";

/**
 * The triage board: the latest mail in the shared mailbox, each message showing
 * whether it carries action items and, when it does, the lines that say so.
 *
 * Two things about the framing are deliberate:
 *
 *  - It never says "your inbox". The Gmail connector is TENANT-scoped — one
 *    mailbox an admin connected, shared by every user of the app — and its own
 *    source comments say it must not be presented as per-user mail. The header
 *    says "shared mailbox" for that reason.
 *  - The detector is rules, not a model, so every count is shown next to its
 *    evidence rather than asking the reader to trust a number.
 *
 * Data comes from this app's own route via `useAppQuery`, which with `AsyncView`
 * makes loading, refetching, error and empty structural rather than remembered.
 */

import { useCallback } from "react";
import { useRouter, useSearchParams } from "next/navigation";
import { Paperclip, RefreshCw } from "lucide-react";
import AppPageHeader from "@/components/ui/app-page-header";
import { AsyncView } from "@/components/ui/async-view";
import { Button } from "@/components/ui/button";
import { Card, CardBody } from "@/components/ui/card";
import { Skeleton } from "@/components/ui/skeleton";
import { useAppQuery } from "@/lib/apps/use-app-query";
import { ActionEvidence, ActionStatus } from "../components/action-evidence";
import {
  FILTERS,
  formatReceived,
  isMessageFilter,
  senderLabel,
  type InboxMessage,
  type MessageFilter,
} from "../lib/shared/messages";

const SLUG = "inbox-actions";
const LIMIT = 50;

interface MessagesResult {
  messages: InboxMessage[];
  gmailConfigured: boolean;
  retentionDays: number;
}

export default function InboxActionsPage() {
  const router = useRouter();
  // `useSearchParams`, not `window.location.search`: the filter decides which
  // control renders as active, so a value that differs between the server and
  // the first client render is a hydration mismatch and a flash of the wrong
  // tab (docs/apps/app-shell.md).
  const searchParams = useSearchParams();

  const param = searchParams.get("filter");
  const filter: MessageFilter = isMessageFilter(param) ? param : "all";

  const query = useAppQuery<MessagesResult>(SLUG, "GET /messages", {
    limit: LIMIT,
    filter,
  });

  const setFilter = useCallback(
    (next: MessageFilter) => {
      // An absent param and an explicit "all" mean the same thing here — there
      // is no per-user default to preserve — so "all" drops the param entirely
      // and keeps the URL clean.
      router.replace(next === "all" ? "?" : `?filter=${next}`, { scroll: false });
    },
    [router],
  );

  const messages = query.state.data?.messages ?? [];
  const needingAction = messages.filter((m) => m.actionCount > 0).length;
  const refreshing = query.state.status === "refetching";

  return (
    <div className="p-8">
      <AppPageHeader
        title="Inbox Actions"
        subtitle={
          query.state.data ? (
            <>
              <span className="font-semibold text-foreground">{needingAction}</span>
              {" of "}
              {messages.length} shown need action · shared mailbox, last{" "}
              {query.state.data.retentionDays} days
            </>
          ) : (
            "Shared mailbox — action items detected in each message"
          )
        }
        actions={[
          {
            label: "Refresh",
            icon: RefreshCw,
            onClick: query.refetch,
            busy: refreshing,
            disabled: refreshing,
          },
        ]}
      />

      <div
        className="mb-4 flex flex-wrap items-center gap-2"
        role="group"
        aria-label="Filter messages"
      >
        {FILTERS.map((option) => (
          <Button
            key={option.key}
            size="sm"
            variant={option.key === filter ? "primary" : "secondary"}
            aria-pressed={option.key === filter}
            onClick={() => setFilter(option.key)}
          >
            {option.label}
          </Button>
        ))}
      </div>

      <AsyncView
        query={query}
        skeleton={<MessageListSkeleton />}
        // The three reasons this list can be blank are three different problems.
        // "Needs action" matching nothing is the good news case and says so;
        // an empty table is the cold-sync case and says what will fix it.
        empty={
          filter === "all"
            ? {
                cause: "no-data",
                title: "No messages synced yet",
                body: "The mailbox sync runs every 15 minutes. Once it has run, the latest messages appear here.",
              }
            : {
                cause: "no-match",
                title:
                  filter === "needs-action"
                    ? "Nothing is waiting on anyone"
                    : "Every message has an action item",
                body:
                  filter === "needs-action"
                    ? "No message in the last 30 days has a detected action item."
                    : "Every synced message matched at least one action item.",
                action: { label: "Show all messages", onClick: () => setFilter("all") },
              }
        }
        isEmpty={(data) => data.messages.length === 0}
        refetchingLabel={`Loading ${
          FILTERS.find((f) => f.key === filter)?.label.toLowerCase() ?? "messages"
        }…`}
      >
        {(data) => (
          <ul className="space-y-3">
            {data.messages.map((message) => (
              <li key={message.id}>
                <MessageCard message={message} />
              </li>
            ))}
          </ul>
        )}
      </AsyncView>
    </div>
  );
}

function MessageCard({ message }: { message: InboxMessage }) {
  return (
    <Card>
      <CardBody className="space-y-3">
        <div className="flex flex-wrap items-baseline gap-x-3 gap-y-1">
          <h2 className="min-w-0 flex-1 text-base font-semibold text-foreground">
            {message.subject || "(no subject)"}
          </h2>
          {message.hasAttachments && (
            <Paperclip
              className="h-4 w-4 shrink-0 text-muted-foreground"
              aria-label="Has an attachment"
              role="img"
            />
          )}
          <span className="shrink-0 text-xs text-muted-foreground">
            {formatReceived(message.receivedAt)}
          </span>
        </div>

        <div className="flex flex-wrap items-center gap-x-3 gap-y-1">
          <span className="text-sm text-muted-foreground">
            {senderLabel(message)}
          </span>
          <ActionStatus
            actionCount={message.actionCount}
            hasDeadline={message.hasDeadline}
          />
        </div>

        {message.actionCount === 0 ? (
          <p className="text-sm text-muted-foreground">{message.snippet}</p>
        ) : (
          <ActionEvidence
            actions={message.actions}
            actionCount={message.actionCount}
          />
        )}
      </CardBody>
    </Card>
  );
}

/**
 * Mirrors the loaded layout — the same card shell, the same three rows, the same
 * `p-5` inset — so nothing shifts when the data lands. A skeleton that draws
 * bare grey blocks outside a card is the layout shift `docs/apps/ux.md` names.
 */
function MessageListSkeleton() {
  return (
    <ul className="space-y-3" aria-hidden>
      {Array.from({ length: 6 }, (_, i) => (
        <li key={i}>
          <Card>
            <CardBody className="space-y-3">
              <div className="flex items-baseline gap-3">
                <Skeleton className="h-5 flex-1" />
                <Skeleton className="h-3 w-14" />
              </div>
              <div className="flex items-center gap-3">
                <Skeleton className="h-4 w-32" />
                <Skeleton className="h-4 w-28" />
              </div>
              <Skeleton className="h-16 w-full rounded-md" />
            </CardBody>
          </Card>
        </li>
      ))}
    </ul>
  );
}
