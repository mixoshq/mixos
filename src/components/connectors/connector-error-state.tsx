/* This Source Code Form is subject to the terms of the Mozilla Public
 * License, v. 2.0. If a copy of the MPL was not distributed with this
 * file, You can obtain one at https://mozilla.org/MPL/2.0/. */

"use client";

import Link from "next/link";
import { Plug, RefreshCw, TriangleAlert } from "lucide-react";
import type { ConnectorErrorEnvelope } from "@/lib/connectors/response";
import { isAdminActionable } from "@/lib/connectors/response";
import { CARD_SHELL } from "@/components/ui/card";
import { cn } from "@/lib/utils";

/**
 * The screen a widget shows when its connector failed.
 *
 * docs/apps/ux.md names three states an async surface can be in; this is the
 * fourth it references but never had — *not connected*. It matters because a
 * connector failure is usually not a failure at all from the user's side: an
 * integration nobody finished setting up is a task for an administrator, and
 * rendering it as "Failed to load" tells the user to retry something that will
 * never start working on its own.
 *
 * So the treatment splits on cause. Missing or rejected credentials get the
 * not-connected panel and no Retry button, because retrying is futile. Genuinely
 * transient failures get the error panel and a Retry that might work.
 *
 * Every message here already passed through `connectorErrorEnvelope`, so it is
 * safe to render as-is — no raw error strings, no upstream bodies.
 */
export default function ConnectorErrorState({
  envelope,
  onRetry,
}: {
  envelope: ConnectorErrorEnvelope;
  /** Offered only for causes where trying again could plausibly succeed. */
  onRetry?: () => void;
}) {
  const { error } = envelope;
  const needsAdmin = isAdminActionable(error.category);
  const retryable =
    !needsAdmin &&
    error.category !== "not_found" &&
    error.category !== "invalid_request";

  const Icon = needsAdmin ? Plug : TriangleAlert;
  const waitHint =
    error.retryAfterMs != null
      ? ` Try again in about ${Math.max(1, Math.round(error.retryAfterMs / 1000))} seconds.`
      : "";

  return (
    <div
      className={cn(
        CARD_SHELL,
        "flex flex-1 items-center justify-center border-dashed p-5 text-center",
      )}
    >
      <div className="max-w-md">
        <Icon
          aria-hidden
          className={`mx-auto h-6 w-6 ${needsAdmin ? "text-muted-foreground" : "text-destructive"}`}
        />
        <p className="mt-3 text-base font-semibold text-foreground">
          {needsAdmin ? "Not connected" : "Couldn't load this"}
        </p>
        <p className="mx-auto mt-1 text-sm text-muted-foreground">
          {error.message}
          {waitHint}
        </p>

        {/*
          Admin-only. `adminActionUrl` is present only when the server decided
          this viewer is an admin, so the link cannot appear for anyone else —
          the check happened where it is trustworthy, not here.
        */}
        {error.adminActionUrl && (
          <div className="mt-4 space-y-2">
            {error.adminHint && (
              <p className="mx-auto text-xs text-muted-foreground">
                {error.adminHint}
              </p>
            )}
            <Link
              href={error.adminActionUrl}
              className="inline-flex items-center gap-2 rounded-md border border-input bg-background px-3 py-2 text-sm font-medium shadow-sm hover:bg-accent"
            >
              <Plug className="h-4 w-4" aria-hidden />
              Open Connector Registry
            </Link>
            {error.upstreamRequestId && (
              <p className="mx-auto font-mono text-[11px] text-muted-foreground">
                Reference: {error.upstreamRequestId}
              </p>
            )}
          </div>
        )}

        {retryable && onRetry && (
          <div className="mt-4">
            <button
              type="button"
              onClick={onRetry}
              className="inline-flex items-center gap-2 rounded-md border border-input bg-background px-3 py-2 text-sm font-medium shadow-sm hover:bg-accent"
            >
              <RefreshCw className="h-4 w-4" aria-hidden />
              Retry
            </button>
          </div>
        )}
      </div>
    </div>
  );
}
