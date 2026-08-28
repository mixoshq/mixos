/* This Source Code Form is subject to the terms of the Mozilla Public
 * License, v. 2.0. If a copy of the MPL was not distributed with this
 * file, You can obtain one at https://mozilla.org/MPL/2.0/. */

"use client";

import { ChevronLeft, ChevronRight } from "lucide-react";
import { Button, IconButton } from "@/components/ui/button";

/**
 * Page controls for a bounded list.
 *
 * Reports the range in words as well as arrows, because "Showing 21–40 of 137"
 * is the part a user actually reads, and because two unlabelled chevrons are
 * meaningless to a screen reader. Both buttons carry accessible names by
 * construction — `IconButton` requires a `label`.
 */
export function Pagination({
  page,
  pageSize,
  total,
  onPageChange,
}: {
  /** 1-based. */
  page: number;
  pageSize: number;
  total: number;
  onPageChange: (page: number) => void;
}) {
  const pages = Math.max(1, Math.ceil(total / pageSize));
  const first = total === 0 ? 0 : (page - 1) * pageSize + 1;
  const last = Math.min(page * pageSize, total);

  // One page is not a choice; rendering controls for it is noise.
  if (pages <= 1) return null;

  return (
    <nav
      className="flex items-center justify-between gap-4 pt-3"
      aria-label="Pagination"
    >
      <p className="text-xs text-muted-foreground" aria-live="polite">
        Showing <span className="font-medium text-foreground">{first}</span>–
        <span className="font-medium text-foreground">{last}</span> of{" "}
        <span className="font-medium text-foreground">{total}</span>
      </p>
      <div className="flex items-center gap-1">
        <IconButton
          size="sm"
          label="Previous page"
          icon={<ChevronLeft className="h-4 w-4" />}
          disabled={page <= 1}
          onClick={() => onPageChange(page - 1)}
        />
        <span className="px-2 text-xs text-muted-foreground">
          {page} / {pages}
        </span>
        <IconButton
          size="sm"
          label="Next page"
          icon={<ChevronRight className="h-4 w-4" />}
          disabled={page >= pages}
          onClick={() => onPageChange(page + 1)}
        />
      </div>
    </nav>
  );
}

export { Button };
