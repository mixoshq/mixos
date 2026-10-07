/* This Source Code Form is subject to the terms of the Mozilla Public
 * License, v. 2.0. If a copy of the MPL was not distributed with this
 * file, You can obtain one at https://mozilla.org/MPL/2.0/. */

"use client";

import {
  useEffect,
  useLayoutEffect,
  useRef,
  useState,
  type KeyboardEvent as ReactKeyboardEvent,
  type ReactNode,
} from "react";
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

function itemClass(item: MenuItem): string {
  return cn(
    "flex w-full items-center gap-2 rounded px-2.5 py-1.5 text-left text-sm transition-colors",
    "focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-inset focus-visible:ring-ring",
    "disabled:pointer-events-none disabled:opacity-50",
    item.destructive
      ? "text-destructive hover:bg-destructive hover:text-destructive-foreground"
      : "text-foreground hover:bg-muted",
  );
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
              className={itemClass(item)}
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

/** Gap kept between a context menu and the viewport edge. */
const VIEWPORT_MARGIN = 8;

/**
 * A right-click menu, opened at the pointer.
 *
 * The caller owns whether it is open — mount it with the click's `clientX` and
 * `clientY`, unmount it on `onClose`. It closes on outside mousedown, Escape,
 * Tab, scroll, resize, and after an item runs.
 *
 * Unlike `Menu`, nothing was focused to open it, so it takes focus itself: the
 * menu on open, arrow keys onto and between items, and back to whatever had
 * focus when it closes. Without that, a menu opened from the keyboard
 * (Shift+F10 or the context-menu key) could be seen but not used. The menu
 * rather than its first item, so a right-click doesn't open with a focus ring
 * on an item the pointer isn't on.
 */
export function ContextMenu({
  x,
  y,
  items,
  onClose,
  label,
}: {
  x: number;
  y: number;
  items: MenuItem[];
  onClose: () => void;
  label?: string;
}) {
  const rootRef = useRef<HTMLDivElement>(null);

  // Opened near the right or bottom edge, the menu would hang off the screen.
  // Measured before paint and written straight to the element, so it never
  // shows in the wrong place and no second render is needed.
  useLayoutEffect(() => {
    const el = rootRef.current;
    if (!el) return;
    const { width, height } = el.getBoundingClientRect();
    const maxLeft = window.innerWidth - width - VIEWPORT_MARGIN;
    const maxTop = window.innerHeight - height - VIEWPORT_MARGIN;
    el.style.left = `${Math.max(VIEWPORT_MARGIN, Math.min(x, maxLeft))}px`;
    el.style.top = `${Math.max(VIEWPORT_MARGIN, Math.min(y, maxTop))}px`;
  }, [x, y]);

  useEffect(() => {
    const root = rootRef.current;
    const restoreTo = document.activeElement as HTMLElement | null;
    root?.focus({ preventScroll: true });
    return () => {
      // Only when focus would otherwise be lost: an item that opened a dialog
      // has already moved focus somewhere better.
      const active = document.activeElement;
      const lost =
        !active || active === document.body || root?.contains(active);
      if (lost && restoreTo && restoreTo !== document.body) {
        restoreTo.focus({ preventScroll: true });
      }
    };
  }, []);

  useEffect(() => {
    // Ignore mousedowns inside the menu — closing on an item's own mousedown
    // would unmount it before its click fires, so it would never activate.
    const onDown = (e: MouseEvent) => {
      if (rootRef.current?.contains(e.target as Node)) return;
      onClose();
    };
    const onKey = (e: KeyboardEvent) => {
      if (e.key === "Escape") onClose();
    };
    document.addEventListener("mousedown", onDown);
    document.addEventListener("keydown", onKey);
    window.addEventListener("scroll", onClose, true);
    window.addEventListener("resize", onClose);
    return () => {
      document.removeEventListener("mousedown", onDown);
      document.removeEventListener("keydown", onKey);
      window.removeEventListener("scroll", onClose, true);
      window.removeEventListener("resize", onClose);
    };
  }, [onClose]);

  const onKeyDown = (e: ReactKeyboardEvent<HTMLDivElement>) => {
    if (e.key === "Tab") {
      e.preventDefault();
      onClose();
      return;
    }
    const enabled = Array.from(
      rootRef.current?.querySelectorAll<HTMLElement>(
        '[role="menuitem"]:not(:disabled)',
      ) ?? [],
    );
    if (enabled.length === 0) return;
    // -1 while the menu itself has focus, so ArrowDown lands on the first item
    // and ArrowUp on the last.
    const at = enabled.indexOf(document.activeElement as HTMLElement);
    const next =
      e.key === "ArrowDown"
        ? enabled[(at + 1) % enabled.length]
        : e.key === "ArrowUp"
          ? enabled[at <= 0 ? enabled.length - 1 : at - 1]
          : e.key === "Home"
            ? enabled[0]
            : e.key === "End"
              ? enabled[enabled.length - 1]
              : null;
    if (!next) return;
    e.preventDefault();
    next.focus();
  };

  return (
    <div
      ref={rootRef}
      role="menu"
      aria-label={label}
      tabIndex={-1}
      onKeyDown={onKeyDown}
      // A right-click on the menu itself would otherwise bubble to whatever
      // opened it and open a second menu on top.
      onContextMenu={(e) => {
        e.preventDefault();
        e.stopPropagation();
      }}
      className={cn(
        "mix-popover",
        CARD_SURFACE,
        "fixed z-50 min-w-48 overflow-hidden p-1 shadow-lg outline-none",
      )}
      style={{ left: x, top: y }}
    >
      {items.map((item) => (
        <button
          key={item.label}
          type="button"
          role="menuitem"
          tabIndex={-1}
          disabled={item.disabled}
          onClick={() => {
            onClose();
            item.onClick();
          }}
          className={itemClass(item)}
        >
          {item.icon}
          {item.label}
        </button>
      ))}
    </div>
  );
}
