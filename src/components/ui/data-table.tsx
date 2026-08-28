/* This Source Code Form is subject to the terms of the Mozilla Public
 * License, v. 2.0. If a copy of the MPL was not distributed with this
 * file, You can obtain one at https://mozilla.org/MPL/2.0/. */

"use client";

import type { ReactNode } from "react";
import { CARD_SHELL } from "@/components/ui/card";
import { Skeleton } from "@/components/ui/skeleton";
import { cn } from "@/lib/utils";

/**
 * A table.
 *
 * WHY A COMPONENT. A hand-rolled `<table>` is where three ux.md rules go to
 * die at once: the skeleton draws grey blocks with no card chrome so the border
 * and header appear all at once when data lands (the layout shift the guide
 * calls out by name), the header cells drift between `text-xs` and `text-sm`
 * across apps, and a wide table pushes the page into horizontal scroll instead
 * of scrolling inside its own container.
 *
 * All three are decided here. `TableSkeleton` reproduces this component's exact
 * chrome — same shell, same header row, same padding — so the two cannot drift
 * the way a copy would.
 */
export interface Column<Row> {
  key: string;
  header: ReactNode;
  /** Cell content. Return a string for text, or a node for anything else. */
  cell: (row: Row) => ReactNode;
  /** Right-align numeric columns so digits line up. */
  align?: "left" | "right";
  /** Applied to both the header cell and every body cell. Width only. */
  className?: string;
}

export interface DataTableProps<Row> {
  rows: Row[];
  columns: Column<Row>[];
  /** Stable identity per row. Index is a last resort and reorders badly. */
  rowKey: (row: Row, index: number) => string;
  /** Makes rows activatable. Adds keyboard access and a pointer affordance. */
  onRowClick?: (row: Row) => void;
  caption?: string;
  className?: string;
}

export function DataTable<Row>({
  rows,
  columns,
  rowKey,
  onRowClick,
  caption,
  className,
}: DataTableProps<Row>) {
  return (
    <div className={cn(CARD_SHELL, "overflow-hidden", className)}>
      {/* Wide content scrolls INSIDE its own container. A table that widens the
          page body is the one layout bug every artifact and app guide bans. */}
      <div className="overflow-x-auto">
        <table className="mix-table w-full border-collapse text-sm">
          {caption && <caption className="sr-only">{caption}</caption>}
          <thead>
            <tr className="border-b border-border">
              {columns.map((c) => (
                <th
                  key={c.key}
                  scope="col"
                  className={cn(
                    "px-4 py-2.5 text-xs font-medium uppercase tracking-wide text-muted-foreground",
                    c.align === "right" ? "text-right" : "text-left",
                    c.className,
                  )}
                >
                  {c.header}
                </th>
              ))}
            </tr>
          </thead>
          <tbody>
            {rows.map((row, i) => (
              <tr
                key={rowKey(row, i)}
                onClick={onRowClick ? () => onRowClick(row) : undefined}
                // A clickable row is a control: it takes focus and responds to
                // Enter, or it is unreachable by keyboard.
                tabIndex={onRowClick ? 0 : undefined}
                role={onRowClick ? "button" : undefined}
                onKeyDown={
                  onRowClick
                    ? (e) => {
                        if (e.key === "Enter" || e.key === " ") {
                          e.preventDefault();
                          onRowClick(row);
                        }
                      }
                    : undefined
                }
                className={cn(
                  "border-b border-border last:border-0",
                  onRowClick &&
                    "cursor-pointer focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-inset focus-visible:ring-ring hover:bg-muted/50",
                )}
              >
                {columns.map((c) => (
                  <td
                    key={c.key}
                    className={cn(
                      "px-4 py-2.5 text-card-foreground",
                      c.align === "right" && "text-right tabular-nums",
                      c.className,
                    )}
                  >
                    {c.cell(row)}
                  </td>
                ))}
              </tr>
            ))}
          </tbody>
        </table>
      </div>
    </div>
  );
}

/**
 * The table's own skeleton.
 *
 * Reproduces the CHROME, not just the content: same shell, same header row, same
 * padding. A skeleton that draws only grey blocks inside no card is a layout
 * shift waiting to happen — when the data lands, the border, header and padding
 * all appear at once and push everything down.
 */
export function TableSkeleton({
  columns,
  rows = 6,
  className,
}: {
  columns: number;
  rows?: number;
  className?: string;
}) {
  return (
    <div className={cn(CARD_SHELL, "overflow-hidden", className)} aria-hidden>
      <div className="border-b border-border px-4 py-2.5">
        <Skeleton className="h-3 w-32" />
      </div>
      {Array.from({ length: rows }, (_, r) => (
        <div
          key={r}
          className="flex items-center gap-4 border-b border-border px-4 py-3 last:border-0"
        >
          {Array.from({ length: columns }, (_, c) => (
            <Skeleton
              key={c}
              className={cn("h-4", c === 0 ? "flex-1" : "w-20")}
            />
          ))}
        </div>
      ))}
    </div>
  );
}
