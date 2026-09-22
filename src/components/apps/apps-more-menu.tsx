/* This Source Code Form is subject to the terms of the Mozilla Public
 * License, v. 2.0. If a copy of the MPL was not distributed with this
 * file, You can obtain one at https://mozilla.org/MPL/2.0/. */

"use client";

import { forwardRef } from "react";
import Link from "next/link";
import LucideIcon from "@/components/lucide-icon";
import type { AppManifest } from "@/lib/apps/types";
import type {
  ListReorderItemProps,
  ListReorderDropTargetProps,
} from "@/lib/dnd/use-list-reorder";
import { CARD_SURFACE } from "@/components/ui/card";
import { cn } from "@/lib/utils";

type Props = {
  apps: AppManifest[];
  /** Index in the full ordered list at which the first overflow item lives. */
  offset: number;
  currentAppSlug: string | null;
  getItemProps: (index: number) => ListReorderItemProps;
  getDropTargetProps: (index: number) => ListReorderDropTargetProps;
  dragIndex: number | null;
  dragOverIndex: number | null;
  onItemClick: () => void;
};

const AppsMoreMenu = forwardRef<HTMLDivElement, Props>(function AppsMoreMenu(
  {
    apps,
    offset,
    currentAppSlug,
    getItemProps,
    getDropTargetProps,
    dragIndex,
    dragOverIndex,
    onItemClick,
  },
  ref,
) {
  return (
    <div
      ref={ref}
      role="menu"
      className={cn(
        "mix-popover",
        CARD_SURFACE,
        "absolute right-0 top-full z-50 mt-1 w-56 py-1 shadow-lg",
      )}
      {...getDropTargetProps(offset + apps.length)}
    >
      {apps.map((app, m) => {
        const globalIndex = offset + m;
        const isActive = currentAppSlug === app.slug;
        const isDropTarget =
          dragOverIndex === globalIndex &&
          dragIndex !== null &&
          dragIndex !== globalIndex;
        const isDragging = dragIndex === globalIndex;
        return (
          <Link
            key={app.slug}
            href={`/apps/${app.slug}`}
            onClick={onItemClick}
            {...getItemProps(globalIndex)}
            className={`flex items-center gap-2 px-3 py-2 text-sm hover:bg-accent ${
              isActive
                ? "bg-accent font-medium text-foreground"
                : "text-foreground"
            } ${isDropTarget ? "bg-accent" : ""} ${
              // A ring rather than a fade: dimming the label thins
              // `text-foreground` to 3.75:1, and "picked up" reads more clearly
              // as an outline than as a ghost.
              isDragging ? "bg-accent ring-2 ring-inset ring-ring" : ""
            }`}
          >
            <LucideIcon
              name={app.icon}
              className="h-4 w-4 text-muted-foreground"
            />
            {app.name}
          </Link>
        );
      })}
    </div>
  );
});

export default AppsMoreMenu;
