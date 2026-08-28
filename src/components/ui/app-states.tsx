/* This Source Code Form is subject to the terms of the Mozilla Public
 * License, v. 2.0. If a copy of the MPL was not distributed with this
 * file, You can obtain one at https://mozilla.org/MPL/2.0/. */

"use client";

/**
 * The four screens an async surface can show that aren't the happy path.
 *
 * Every app hits all four. The reason they live here rather than being written
 * per-app is that the interesting part isn't the markup — it's the distinction
 * between them. A blank card is the same pixels whether the user emptied a
 * filter, the filter matched nothing, or the fetch failed; those are three
 * different problems with three different fixes, and collapsing them into one
 * "No results" box tells the user nothing about which one they're in.
 *
 * `EmptyState` therefore requires a `cause`, and `no-filter` additionally
 * requires an `action` — a filter the user emptied is always fixable by the
 * user, so there is always something to offer them.
 *
 * See docs/apps/ux.md ("Empty, error & not-connected states").
 */

import Link from "next/link";
import { Loader2 } from "lucide-react";

/** Why there is nothing to show. Drives the default copy and whether an action
 *  is required. */
export type EmptyCause =
  /** The user's own filter selection excludes everything (or is empty). Always
   *  recoverable by the user, so `action` is required. */
  | "no-filter"
  /** Filters are valid but matched no records. */
  | "no-match"
  /** There is genuinely no data yet — a new install, an unsynced source. */
  | "no-data";

const DASHED_PANEL =
  "flex flex-1 items-center justify-center rounded-xl border border-dashed border-border bg-card p-10 text-center";

interface EmptyStateProps {
  cause: EmptyCause;
  /** Short headline. Defaults per cause. */
  title?: string;
  /** One sentence of guidance. Say what would make records appear. */
  body: string;
  /** Required for `no-filter`, optional otherwise. */
  action?: { label: string; onClick?: () => void; href?: string };
}

const DEFAULT_TITLE: Record<EmptyCause, string> = {
  "no-filter": "Nothing selected",
  "no-match": "Nothing here",
  "no-data": "Nothing yet",
};

/**
 * Empty state. Requires the caller to say *why* it's empty.
 *
 * The `action` requirement on `no-filter` is enforced by the overload below, so
 * the compiler rejects a filter-empty screen with no way out of it.
 */
export function EmptyState(
  props: EmptyStateProps &
    ({ cause: "no-filter"; action: NonNullable<EmptyStateProps["action"]> } | { cause: "no-match" | "no-data" }),
) {
  const { cause, title, body, action } = props as EmptyStateProps;
  return (
    <div className={DASHED_PANEL}>
      <div>
        <p className="text-base font-semibold text-foreground">
          {title ?? DEFAULT_TITLE[cause]}
        </p>
        <p className="mx-auto mt-1 max-w-md text-sm text-muted-foreground">
          {body}
        </p>
        {action && (
          <div className="mt-4">
            <ActionButton {...action} />
          </div>
        )}
      </div>
    </div>
  );
}

/**
 * Error state. Takes an already-safe message — never pass a raw `error.message`
 * from a catch block (see `safeErrorMessage` and apps/AGENTS.md invariant #9).
 */
export function ErrorState({
  message,
  onRetry,
  title = "Failed to load",
}: {
  message: string;
  onRetry?: () => void;
  title?: string;
}) {
  return (
    <div className="flex flex-1 items-center justify-center p-8">
      <div className="text-center">
        <p className="text-lg font-semibold text-destructive">{title}</p>
        <p className="mx-auto mt-1 max-w-md text-sm text-muted-foreground">
          {message}
        </p>
        {onRetry && (
          <div className="mt-4">
            <ActionButton label="Retry" onClick={onRetry} />
          </div>
        )}
      </div>
    </div>
  );
}

/**
 * Loading state for a *refetch the user triggered* — a filter change, a scope
 * switch. Unlike a skeleton, it names what's loading, so a user who just picked
 * a different owner can see their choice being applied rather than watching an
 * anonymous shimmer.
 *
 * Use a `Skeleton` for the first paint (nothing to name yet) and this once the
 * user has made a selection worth echoing back.
 */
export function PendingState({
  label,
  /** Optional chips echoing the selection being applied (e.g. stage names). */
  chips,
}: {
  /** Say what is loading. Emphasise the part the user just chose:
   *  `<>Loading customers for <strong>{name}</strong>…</>` */
  label: React.ReactNode;
  chips?: string[];
}) {
  return (
    <div className="flex h-full min-h-[300px] flex-1 items-center justify-center rounded-xl border border-border bg-card p-8">
      <div className="max-w-md text-center">
        <Loader2
          aria-hidden
          className="mx-auto h-5 w-5 animate-spin text-foreground"
        />
        <p className="mt-3 text-sm text-muted-foreground">{label}</p>
        {chips && chips.length > 0 && (
          <div className="mt-3 flex flex-wrap justify-center gap-1.5">
            {chips.map((chip) => (
              <span
                key={chip}
                className="rounded-full border border-border bg-muted px-2 py-0.5 text-xs font-medium text-foreground"
              >
                {chip}
              </span>
            ))}
          </div>
        )}
      </div>
    </div>
  );
}

/** Shared action affordance — renders a link or a button from the same props. */
function ActionButton({
  label,
  onClick,
  href,
}: {
  label: string;
  onClick?: () => void;
  href?: string;
}) {
  const className =
    "inline-flex items-center rounded-md bg-primary px-4 py-2 text-sm font-medium text-primary-foreground hover:bg-primary/90";
  if (href) {
    return (
      <Link href={href} className={className}>
        {label}
      </Link>
    );
  }
  return (
    <button type="button" onClick={onClick} className={className}>
      {label}
    </button>
  );
}
