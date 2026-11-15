/* This Source Code Form is subject to the terms of the Mozilla Public
 * License, v. 2.0. If a copy of the MPL was not distributed with this
 * file, You can obtain one at https://mozilla.org/MPL/2.0/. */

"use client";

import { Trash2 } from "lucide-react";
import type { AppAuthor } from "@/lib/apps/types";
import { formatLastUpdated, renderAuthors } from "@/lib/apps/display";

/**
 * An extension's provenance, and its Delete, as the registries show them.
 *
 * "Updated <date>" and "By <author>", in two places that used to word it
 * differently: the footer band of an app's or a connector's dialog, and the
 * floor of its tile, which said "Authored By" on the left and "Updated" on the
 * right. An admin reads the same facts in the same words on the card and in the
 * dialog it opens, and the two can't drift, since this is the one copy.
 *
 * In the dialog the two sit together at the band's start, with the path and
 * Delete at its end. On a tile, `spread`, they take an end each: one line, the
 * date whole, and the authors cut short with an ellipsis when the tile is too
 * narrow for both, their names whole in the tooltip and in the dialog.
 */
export function Provenance({
  lastUpdated,
  authors,
  spread = false,
}: {
  lastUpdated: number | null | undefined;
  authors: AppAuthor[] | undefined;
  spread?: boolean;
}) {
  const hasAuthors = authors !== undefined && authors.length > 0;
  return (
    <span
      className={
        spread
          ? "flex min-w-0 items-baseline justify-between gap-4"
          : "flex flex-wrap gap-x-10 gap-y-1.5"
      }
    >
      <span className={spread ? "shrink-0" : undefined}>
        <strong className="font-semibold">Updated</strong>{" "}
        {/* Stamped by the pre-commit hook, so an extension edited but not yet
            committed says so rather than showing a stale date. */}
        {formatLastUpdated(lastUpdated, "Not yet committed")}
      </span>
      {hasAuthors && (
        <span
          className={spread ? "min-w-0 truncate text-right" : undefined}
          title={spread ? authors.map((a) => a.name).join(", ") : undefined}
        >
          <strong className="font-semibold">By</strong> {renderAuthors(authors)}
        </span>
      )}
    </span>
  );
}

/**
 * A registry tile's floor: the dialog's footer band (ui/dialog.tsx, the branch
 * with tabs), carried down to the tile, with its provenance spread across it.
 * The tile is `p-5`, so the band takes that inset back with negative margins to
 * run edge to edge, and rounds its own bottom corners, as the dialog's does,
 * since the card shell doesn't clip.
 *
 * It goes last in the tile, below the actions: `mt-auto` on the action row
 * above keeps it on the floor whatever the tile's height. It carries nothing
 * but provenance, so it reads the same on an app, a connector and a theme.
 */
export function TileFooter({
  lastUpdated,
  authors,
}: {
  lastUpdated: number | null | undefined;
  authors: AppAuthor[] | undefined;
}) {
  return (
    <div className="-mx-5 -mb-5 mt-5 rounded-b-lg border-t border-border bg-muted/40 px-5 py-2.5 text-xs text-foreground">
      <Provenance lastUpdated={lastUpdated} authors={authors} spread />
    </div>
  );
}

/**
 * Delete, at the right end of a dialog's footer band, or at the start of a
 * theme tile's action row, since a theme has no dialog to put it in. It opens
 * the Remove dialog, which says what is deleted and what is kept, and asks.
 *
 * Sized for the band rather than as a Button: a `size="sm"` Button is h-9, and
 * would make the band twice as tall as the line of text it carries. It is the
 * quietest control in the dialog, since removing code is rare, and the dialog
 * it opens says what goes and what stays before anything does.
 *
 * The text is `text-foreground`, and the icon carries the red. `text-destructive`
 * on a muted ground is under the contrast floor (docs/apps/ux.md, "Verified
 * pairs"), and an icon needs 3:1, not 4.5:1.
 */
export function RemoveAction({ name, onClick }: { name: string; onClick: () => void }) {
  return (
    <button
      type="button"
      onClick={onClick}
      aria-label={`Delete ${name}`}
      className="inline-flex items-center gap-1.5 rounded-sm text-xs font-medium text-foreground hover:underline focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-ring focus-visible:ring-offset-1"
    >
      <Trash2 className="h-3.5 w-3.5 text-destructive" aria-hidden />
      Delete
    </button>
  );
}
