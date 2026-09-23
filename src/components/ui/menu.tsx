/* This Source Code Form is subject to the terms of the Mozilla Public
 * License, v. 2.0. If a copy of the MPL was not distributed with this
 * file, You can obtain one at https://mozilla.org/MPL/2.0/. */

"use client";

import { useEffect, useRef, useState, type ReactNode } from "react";
import { MoreHorizontal } from "lucide-react";
import { IconButton } from "@/components/ui/button";
import { CARD_SURFACE } from "@/components/ui/card";
import { cn } from "@/lib/utils";

/**
 * An overflow menu.
 *
 * `docs/apps/app-shell.md` sends destructive operations, mode toggles and
 * once-a-month actions here rather than into a page header — "a header with nine
 * buttons has no primary action, only nine equal ones". This is where they go.
 *
 * It closes on outside click, on Escape, and after an item runs. The Escape
 * handler matters more than it looks: a menu you can only dismiss with the mouse
 * is a keyboard trap.
 */
export interface MenuItem {
  label: string;
  onClick: () => void;
  icon?: ReactNode;
  /** Renders in the destructive tone and sorts to the bottom visually. */
  destructive?: boolean;
  disabled?: boolean;
}

export function Menu({
  items,
  label = "More actions",
  align = "right",
}: {
  items: MenuItem[];
  label?: string;
  align?: "left" | "right";
}) {
  const [open, setOpen] = useState(false);
  const rootRef = useRef<HTMLDivElement>(null);

  useEffect(() => {
    if (!open) return;
    const onDown = (e: MouseEvent) => {
      if (!rootRef.current?.contains(e.target as Node)) setOpen(false);
    };
    const onKey = (e: KeyboardEvent) => {
      if (e.key === "Escape") setOpen(false);
    };
    document.addEventListener("mousedown", onDown);
    document.addEventListener("keydown", onKey);
    return () => {
      document.removeEventListener("mousedown", onDown);
      document.removeEventListener("keydown", onKey);
    };
  }, [open]);

  return (
    <div ref={rootRef} className="relative inline-block">
      <IconButton
        size="sm"
        variant="ghost"
        label={label}
        icon={<MoreHorizontal className="h-4 w-4" />}
        aria-haspopup="menu"
        aria-expanded={open}
        onClick={() => setOpen((v) => !v)}
      />
      {open && (
        <div
          role="menu"
          className={cn(
            "mix-popover",
            CARD_SURFACE,
            "absolute z-30 mt-1 min-w-48 overflow-hidden p-1 shadow-lg",
            align === "right" ? "right-0" : "left-0",
          )}
        >
          {items.map((item) => (
            <button
              key={item.label}
              type="button"
              role="menuitem"
              disabled={item.disabled}
              onClick={() => {
                setOpen(false);
                item.onClick();
              }}
              className={cn(
                "flex w-full items-center gap-2 rounded px-2.5 py-1.5 text-left text-sm transition-colors",
                "focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-inset focus-visible:ring-ring",
                "disabled:pointer-events-none disabled:opacity-50",
                item.destructive
                  ? "text-destructive hover:bg-destructive hover:text-destructive-foreground"
                  : "text-foreground hover:bg-muted",
              )}
            >
              {item.icon}
              {item.label}
            </button>
          ))}
        </div>
      )}
    </div>
  );
}
