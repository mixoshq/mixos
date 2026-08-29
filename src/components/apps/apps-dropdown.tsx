/* This Source Code Form is subject to the terms of the Mozilla Public
 * License, v. 2.0. If a copy of the MPL was not distributed with this
 * file, You can obtain one at https://mozilla.org/MPL/2.0/. */

"use client";

import { useState, useRef, useEffect, useLayoutEffect, useMemo } from "react";
import Link from "next/link";
import { usePathname } from "next/navigation";
import { LayoutGrid, ChevronDown, MoreHorizontal, Pin } from "lucide-react";
import { appRegistry } from "@/generated/app-registry";
import LucideIcon from "@/components/lucide-icon";
import {
  getMyInstalledApps,
  reorderMyApps,
  setMyAppPinned,
  type InstalledApp,
} from "@/lib/apps/actions";
import { usePreferences } from "@/components/preferences-context";
import { useListReorder } from "@/lib/dnd/use-list-reorder";
import AppsMoreMenu from "@/components/apps/apps-more-menu";
import type { AppManifest } from "@/lib/apps/types";
import { CARD_SURFACE } from "@/components/ui/card";
import { cn } from "@/lib/utils";

const BAR_GAP_PX = 2; // matches Tailwind gap-0.5 between bar items
const OUTER_GAP_PX = 4; // matches Tailwind gap-1 between the Apps button and bar
const DIVIDER_PX = 1; // the w-px rule separating system nav from the app strip

function computeVisibleCount(
  widths: number[],
  available: number,
  moreWidth: number,
  gap: number,
): number {
  if (widths.length === 0) return 0;
  if (!Number.isFinite(available) || available <= 0) return widths.length;
  const totalWithGaps =
    widths.reduce((s, w) => s + w, 0) + Math.max(0, widths.length - 1) * gap;
  if (totalWithGaps <= available) return widths.length;

  const cap = available - moreWidth - gap;
  if (cap <= 0) return 0;
  let used = 0;
  let k = 0;
  for (let i = 0; i < widths.length; i++) {
    const next = used + (k > 0 ? gap : 0) + widths[i];
    if (next > cap) break;
    used = next;
    k++;
  }
  return k;
}

export default function AppsDropdown() {
  const pathname = usePathname();
  const { menuBarAppDisplay } = usePreferences();
  const iconOnly = menuBarAppDisplay === "icon";
  const [dropdownOpen, setDropdownOpen] = useState(false);
  const [moreOpen, setMoreOpen] = useState(false);
  const [installedApps, setInstalledApps] = useState<InstalledApp[]>([]);

  const containerRef = useRef<HTMLDivElement>(null);
  const dropdownRef = useRef<HTMLDivElement>(null);
  const moreRef = useRef<HTMLDivElement>(null);
  const appsBtnRef = useRef<HTMLButtonElement>(null);
  const measureRef = useRef<HTMLDivElement>(null);

  const [containerWidth, setContainerWidth] = useState<number | null>(null);
  const [appsBtnWidth, setAppsBtnWidth] = useState(0);
  const [itemWidths, setItemWidths] = useState<number[]>([]);
  const [moreWidth, setMoreWidth] = useState(0);

  function refresh() {
    getMyInstalledApps().then((apps) => setInstalledApps(apps));
  }

  useEffect(() => {
    let cancelled = false;
    getMyInstalledApps().then((apps) => {
      if (!cancelled) setInstalledApps(apps);
    });
    function onChanged() {
      refresh();
    }
    window.addEventListener("apps:installed-changed", onChanged);
    return () => {
      cancelled = true;
      window.removeEventListener("apps:installed-changed", onChanged);
    };
  }, []);

  useEffect(() => {
    function handleClickOutside(e: MouseEvent) {
      if (
        dropdownRef.current &&
        !dropdownRef.current.contains(e.target as Node)
      ) {
        setDropdownOpen(false);
      }
      if (moreRef.current && !moreRef.current.contains(e.target as Node)) {
        setMoreOpen(false);
      }
    }
    document.addEventListener("mousedown", handleClickOutside);
    return () => document.removeEventListener("mousedown", handleClickOutside);
  }, []);

  // Order-preserving derivation. Walk the installed apps (canonical position
  // order), look each up in the registry, and split into:
  //  - pinnedApps: pageable + pinned → rendered inline in the bar (reorderable)
  //  - dropdownApps: all pageable installed apps → listed in the Apps dropdown
  //    (sorted by name; the dropdown is a fixed list, reorder happens in the bar)
  //  - unpinnedPageableSlugs / nonPageableSlugs: kept so a bar reorder can
  //    reconstruct the full persisted slug list without dropping anything.
  const {
    pinnedApps,
    dropdownApps,
    unpinnedPageableSlugs,
    nonPageableSlugs,
    pinnedSlugs,
  } = useMemo(() => {
    const pinned: AppManifest[] = [];
    const pageable: AppManifest[] = [];
    const unpinnedPageable: string[] = [];
    const nonPage: string[] = [];
    const pinnedSet = new Set<string>();
    for (const { slug, pinned: isPinned } of installedApps) {
      const app = appRegistry.find((a) => a.slug === slug);
      if (!app || !app.hasPages) {
        nonPage.push(slug);
        continue;
      }
      pageable.push(app);
      if (isPinned) {
        pinned.push(app);
        pinnedSet.add(slug);
      } else {
        unpinnedPageable.push(slug);
      }
    }
    const dropdown = [...pageable].sort((a, b) => a.name.localeCompare(b.name));
    return {
      pinnedApps: pinned,
      dropdownApps: dropdown,
      unpinnedPageableSlugs: unpinnedPageable,
      nonPageableSlugs: nonPage,
      pinnedSlugs: pinnedSet,
    };
  }, [installedApps]);

  const currentAppSlug = pathname.startsWith("/apps/")
    ? pathname.split("/")[2]
    : null;

  // Freeze K during drag so the dragged item doesn't disappear into More
  // mid-drag (which would orphan the cursor). Snapshot at drag start, clear
  // at drag end.
  const [frozenK, setFrozenK] = useState<number | null>(null);
  const liveKRef = useRef(0);

  const { getItemProps, getDropTargetProps, dragIndex, dragOverIndex } =
    useListReorder<AppManifest>({
      items: pinnedApps,
      onReorder: (next) => {
        const nextPinnedSlugs = next.map((a) => a.slug);
        const fullOrder = [
          ...nextPinnedSlugs,
          ...unpinnedPageableSlugs,
          ...nonPageableSlugs,
        ];
        // Optimistically rebuild local state in the new persisted order,
        // preserving each app's pinned flag.
        const bySlug = new Map(installedApps.map((a) => [a.slug, a]));
        const nextInstalled = fullOrder
          .map((slug) => bySlug.get(slug))
          .filter((a): a is InstalledApp => Boolean(a));
        setInstalledApps(nextInstalled);
        reorderMyApps(fullOrder).catch(() => {
          refresh();
        });
      },
      onDragStart: () => setFrozenK(liveKRef.current),
      onDragEnd: () => setFrozenK(null),
    });

  function togglePin(slug: string, currentlyPinned: boolean) {
    const next = !currentlyPinned;
    setInstalledApps((prev) =>
      prev.map((a) => (a.slug === slug ? { ...a, pinned: next } : a)),
    );
    setMyAppPinned(slug, next).catch(() => {
      refresh();
    });
  }

  // ResizeObserver on the whole apps region. Tracks the space available to the
  // pinned bar (total width minus the always-present Apps button).
  useEffect(() => {
    const el = containerRef.current;
    if (!el) return;
    const ro = new ResizeObserver((entries) => {
      for (const entry of entries) {
        setContainerWidth(entry.contentRect.width);
      }
      if (appsBtnRef.current) setAppsBtnWidth(appsBtnRef.current.offsetWidth);
    });
    ro.observe(el);
    return () => ro.disconnect();
  }, []);

  // Measure rendered item widths from the offscreen layer whenever the pinned
  // set changes. useLayoutEffect runs before paint so the visible row trims on
  // the same frame.
  useLayoutEffect(() => {
    if (appsBtnRef.current) setAppsBtnWidth(appsBtnRef.current.offsetWidth);
    const root = measureRef.current;
    if (!root) {
      setItemWidths([]);
      return;
    }
    const items = Array.from(
      root.querySelectorAll<HTMLElement>("[data-measure-item]"),
    );
    setItemWidths(items.map((el) => el.offsetWidth));
    const more = root.querySelector<HTMLElement>("[data-measure-more]");
    setMoreWidth(more ? more.offsetWidth : 0);
  }, [pinnedApps, iconOnly]);

  // The divider is a real flex child: it costs its own width plus one more
  // container gap. Unaccounted for, the bar would fit ~5px more than it has.
  const dividerCost = pinnedApps.length > 0 ? DIVIDER_PX + OUTER_GAP_PX : 0;
  const availableForBar =
    containerWidth == null
      ? Number.POSITIVE_INFINITY
      : Math.max(0, containerWidth - appsBtnWidth - OUTER_GAP_PX - dividerCost);

  const liveK = computeVisibleCount(
    itemWidths,
    availableForBar,
    moreWidth,
    BAR_GAP_PX,
  );
  const dragging = dragIndex !== null;
  const K = dragging && frozenK !== null ? frozenK : liveK;
  useLayoutEffect(() => {
    liveKRef.current = liveK;
  }, [liveK]);

  const visibleApps = pinnedApps.slice(0, K);
  const overflowApps = pinnedApps.slice(K);
  const showMore = overflowApps.length > 0;

  const itemClass = `flex min-w-0 items-center rounded-md py-1 text-xs font-medium transition-colors ${
    iconOnly ? "px-1.5" : "gap-1.5 px-2"
  }`;
  // A tier below the system nav (Dashboard/Apps/Settings), which is
  // full-strength brand-foreground — that contrast step is what separates the
  // permanent bar entries from the app strip.
  const itemColors = (isActive: boolean) =>
    isActive
      ? "bg-brand-foreground/20 text-brand-foreground"
      : "text-brand-foreground/70 hover:bg-brand-foreground/10 hover:text-brand-foreground";

  return (
    <div ref={containerRef} className="flex min-w-0 flex-1 items-center gap-1">
      {/* Apps dropdown — always present, immediately right of Dashboard.
          Lists every installed app with a pin toggle, plus App Manager. */}
      <div className="relative shrink-0" ref={dropdownRef}>
        <button
          ref={appsBtnRef}
          onClick={() => setDropdownOpen(!dropdownOpen)}
          className="flex items-center gap-1.5 rounded-md px-2 py-1 text-sm font-medium text-brand-foreground transition-colors hover:bg-brand-foreground/10"
        >
          <LayoutGrid className="h-4 w-4" />
          <span className="hidden sm:inline">Apps</span>
        </button>

        {dropdownOpen && (
          <div
            className={cn(
              "mix-popover",
              CARD_SURFACE,
              "absolute left-0 top-full z-50 mt-1 w-64 py-1 shadow-lg",
            )}
          >
            {dropdownApps.length > 0 ? (
              dropdownApps.map((app) => {
                const isActive = currentAppSlug === app.slug;
                const pinned = pinnedSlugs.has(app.slug);
                return (
                  <div key={app.slug} className="flex items-center pr-1">
                    <Link
                      href={`/apps/${app.slug}`}
                      onClick={() => setDropdownOpen(false)}
                      data-tour-app-nav={app.slug}
                      className={`flex min-w-0 flex-1 items-center gap-2 px-3 py-2 text-sm hover:bg-accent ${
                        isActive
                          ? "bg-accent font-medium text-foreground"
                          : "text-foreground"
                      }`}
                    >
                      <LucideIcon
                        name={app.icon}
                        className="h-4 w-4 shrink-0 text-muted-foreground"
                      />
                      <span className="truncate">{app.name}</span>
                    </Link>
                    <button
                      type="button"
                      onClick={() => togglePin(app.slug, pinned)}
                      title={pinned ? "Unpin from menu bar" : "Pin to menu bar"}
                      aria-label={
                        pinned ? "Unpin from menu bar" : "Pin to menu bar"
                      }
                      aria-pressed={pinned}
                      className={`shrink-0 rounded-md p-1.5 transition-colors hover:bg-accent ${
                        pinned
                          ? "text-foreground"
                          : "text-muted-foreground hover:text-accent-foreground"
                      }`}
                    >
                      <Pin
                        className={`h-3.5 w-3.5 ${pinned ? "fill-current" : ""}`}
                      />
                    </button>
                  </div>
                );
              })
            ) : (
              <p className="px-3 py-2 text-sm text-muted-foreground">
                No apps installed
              </p>
            )}
            <div className="my-1 border-t border-border" />
            <Link
              href="/apps"
              onClick={() => setDropdownOpen(false)}
              className="flex items-center gap-2 px-3 py-2 text-sm text-foreground hover:bg-accent"
            >
              <LayoutGrid className="h-4 w-4 text-muted-foreground" />
              App Manager
            </Link>
          </div>
        )}
      </div>

      {/* Separates the two permanent system entries (Dashboard, Apps) from the
          pinned apps. Width is accounted for in availableForBar — change
          DIVIDER_PX with it. */}
      {pinnedApps.length > 0 && (
        <span
          aria-hidden="true"
          className="h-4 w-px shrink-0 bg-brand-foreground/15"
        />
      )}

      {/* Pinned apps — inline in the bar, reorderable, overflow into More. */}
      <div className="relative flex min-w-0 items-center gap-0.5">
        {/* Hidden measurement layer: all pinned items + a More placeholder.
            Source of width truth for the overflow math. */}
        <div
          ref={measureRef}
          aria-hidden="true"
          className="pointer-events-none invisible absolute left-0 top-0 flex items-center gap-0.5"
        >
          {pinnedApps.map((app) => (
            <span
              key={`measure-${app.slug}`}
              data-measure-item
              className={itemClass}
            >
              <LucideIcon name={app.icon} className="h-3.5 w-3.5 shrink-0" />
              {!iconOnly && <span>{app.name}</span>}
            </span>
          ))}
          <span
            data-measure-more
            className={`${itemClass} ${itemColors(false)}`}
          >
            {iconOnly ? (
              <MoreHorizontal className="h-3.5 w-3.5 shrink-0" />
            ) : (
              <>
                <span>More</span>
                <ChevronDown className="h-3 w-3" />
              </>
            )}
          </span>
        </div>

        {visibleApps.map((app, i) => {
          const isActive = currentAppSlug === app.slug;
          const isDropTarget =
            dragOverIndex === i && dragIndex !== null && dragIndex !== i;
          const isDragging = dragIndex === i;
          return (
            <Link
              key={app.slug}
              href={`/apps/${app.slug}`}
              title={iconOnly ? undefined : app.name}
              data-tour-app-nav={app.slug}
              {...getItemProps(i)}
              className={`${itemClass} ${itemColors(isActive)} ${
                isDropTarget ? "ring-1 ring-brand-foreground/40" : ""
              } ${isDragging ? "opacity-50" : ""} ${
                iconOnly ? "group relative" : ""
              }`}
            >
              <LucideIcon name={app.icon} className="h-3.5 w-3.5 shrink-0" />
              {iconOnly ? (
                <span className="pointer-events-none absolute left-1/2 top-full z-50 mt-1.5 hidden -translate-x-1/2 whitespace-nowrap rounded-md bg-brand px-2 py-1 text-xs font-medium text-brand-foreground shadow-lg ring-1 ring-brand-foreground/10 group-hover:block">
                  {app.name}
                </span>
              ) : (
                <span className="truncate">{app.name}</span>
              )}
            </Link>
          );
        })}
        {showMore && (
          <div className="relative" ref={moreRef}>
            <button
              type="button"
              onClick={() => setMoreOpen((o) => !o)}
              {...getDropTargetProps(K)}
              className={`${itemClass} ${itemColors(false)} ${
                dragOverIndex === K && dragIndex !== null
                  ? "ring-1 ring-brand-foreground/40"
                  : ""
              }`}
              title="More apps"
            >
              {iconOnly ? (
                <MoreHorizontal className="h-3.5 w-3.5 shrink-0" />
              ) : (
                <>
                  <span>More</span>
                  <ChevronDown className="h-3 w-3" />
                </>
              )}
            </button>
            {moreOpen && (
              <AppsMoreMenu
                apps={overflowApps}
                offset={K}
                currentAppSlug={currentAppSlug}
                getItemProps={getItemProps}
                getDropTargetProps={getDropTargetProps}
                dragIndex={dragIndex}
                dragOverIndex={dragOverIndex}
                onItemClick={() => setMoreOpen(false)}
              />
            )}
          </div>
        )}
      </div>
    </div>
  );
}
