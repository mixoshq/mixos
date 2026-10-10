/* This Source Code Form is subject to the terms of the Mozilla Public
 * License, v. 2.0. If a copy of the MPL was not distributed with this
 * file, You can obtain one at https://mozilla.org/MPL/2.0/. */

"use client";

import type { ReactNode } from "react";
import { EmptyState, ErrorState, type EmptyCause } from "@/components/ui/app-states";
import ConnectorErrorState from "@/components/ui/connector-error-state";
import type { AppQuery } from "@/lib/apps/use-app-query";

/**
 * Render one async surface, with every state accounted for.
 *
 * `docs/apps/ux.md` opens with "every async surface has a loading state" and
 * "every state is designed, and each names its cause". Those were rules a
 * reviewer had to check. Here they are the type signature: you cannot render the
 * data branch without also supplying a `skeleton` and an `empty` — and `empty`
 * takes a `cause`, so "no results" can never be a generic grey box.
 *
 * What the component owns, so an app cannot forget it:
 *
 *   - **Loading** renders your skeleton, which mirrors the loaded layout. Never
 *     a spinner.
 *   - **Refetching** keeps the previous data on screen rather than flashing an
 *     anonymous skeleton at someone who just clicked a filter.
 *   - **Error** renders a calm message with a retry wired to `refetch`, never a
 *     raw error string. A failed connector call renders as that connector's
 *     state instead: "Not connected" with no Retry when an administrator has
 *     to act, since retrying cannot help.
 *   - **Empty** is detected for you from an array or a `{ items }` payload, and
 *     rendered with the cause you declared.
 *
 * ```tsx
 * const q = useAppQuery<Result>(appSlug, "GET /items", { limit: 20 });
 *
 * <AsyncView
 *   query={q}
 *   skeleton={<ItemsSkeleton />}
 *   empty={{ cause: "no-data", body: "Sync a source to populate this." }}
 * >
 *   {(data) => <DataTable rows={data.items} columns={COLUMNS} />}
 * </AsyncView>
 * ```
 */
export interface AsyncViewEmpty {
  cause: EmptyCause;
  title?: string;
  body: string;
  action?: { label: string; onClick?: () => void; href?: string };
}

export interface AsyncViewProps<T> {
  query: AppQuery<T>;
  /** Mirrors the loaded layout. Required — see ux.md, and see this file's note. */
  skeleton: ReactNode;
  /**
   * Required. Rendered when the payload has no records.
   *
   * A `no-filter` cause additionally requires an `action`, enforced by
   * `EmptyState` itself: a filter the user emptied is always recoverable by the
   * user, so a dead end there is always a bug.
   */
  empty: AsyncViewEmpty;
  /** Override emptiness detection when the payload is not a list. */
  isEmpty?: (data: T) => boolean;
  /** Shown above the data while a user-triggered refetch is in flight. */
  refetchingLabel?: string;
  children: (data: T) => ReactNode;
}

/**
 * Emptiness, guessed conservatively.
 *
 * An array is empty when it has no entries; an object with exactly one array
 * property (`{ items: [] }`, `{ rows: [] }`) is empty when that array is. A
 * payload that fits neither shape is never treated as empty — a wrong "nothing
 * here" is worse than a missing one, and `isEmpty` is there for that case.
 */
function looksEmpty(data: unknown): boolean {
  if (Array.isArray(data)) return data.length === 0;
  if (data && typeof data === "object") {
    const arrays = Object.values(data).filter(Array.isArray);
    if (arrays.length === 1) return (arrays[0] as unknown[]).length === 0;
  }
  return false;
}

export function AsyncView<T>({
  query,
  skeleton,
  empty,
  isEmpty,
  refetchingLabel,
  children,
}: AsyncViewProps<T>) {
  const { state, refetch } = query;

  if (state.status === "loading") return <>{skeleton}</>;

  if (state.status === "error") {
    if (state.error.envelope) {
      return (
        <ConnectorErrorState envelope={state.error.envelope} onRetry={refetch} />
      );
    }
    return (
      <ErrorState
        message={state.error.message}
        onRetry={refetch}
      />
    );
  }

  // `refetching` keeps the last good data visible. Replacing it with a skeleton
  // after a deliberate click leaves the user unsure the click registered.
  const data = state.data as T;
  const showEmpty = isEmpty ? isEmpty(data) : looksEmpty(data);

  return (
    <>
      {state.refetching && refetchingLabel && (
        <p
          className="mb-2 text-xs text-muted-foreground"
          role="status"
          aria-live="polite"
        >
          {refetchingLabel}
        </p>
      )}
      {showEmpty ? (
        <EmptyState
          {...(empty as AsyncViewEmpty & { cause: "no-match" })}
        />
      ) : (
        children(data)
      )}
    </>
  );
}
