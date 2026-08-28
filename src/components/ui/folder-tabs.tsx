/* This Source Code Form is subject to the terms of the Mozilla Public
 * License, v. 2.0. If a copy of the MPL was not distributed with this
 * file, You can obtain one at https://mozilla.org/MPL/2.0/. */

"use client";

/**
 * Folder-style tabs for switching between peer views of one record.
 *
 * The active tab drops its bottom border and `-mb-px` pulls it over the bar's
 * border, so it reads as continuous with the panel beneath. That effect only
 * works if the active tab's fill matches the surface it sits on — so
 * `surface` names that surface rather than hardcoding one. A tab band above a
 * `bg-card` panel and one above a `bg-muted` page need different fills to
 * produce the *same* illusion; copying a literal colour between them is what
 * breaks it.
 *
 * FILTER, DON'T DISABLE. A tab for a feature this record doesn't use should not
 * be rendered at all. A disabled tab poses a question ("why can't I click
 * that?") that the tab bar has no room to answer. Filter the array instead:
 *
 *   <FolderTabs items={TABS.filter(t => t.key !== "billing" || hasBilling)} … />
 */

export interface FolderTabItem<K extends string = string> {
  key: K;
  label: string;
  /**
   * Count of items on this tab that need attention, shown as a red circle badge
   * at the tab's top-right corner. Omit or pass 0 to render nothing.
   *
   * BADGE COUNTS OF THINGS, NOT STATES. A count reads as a queue you can drain —
   * "3 tickets", "2 records missing an owner". Putting one on a measurement
   * ("2 metrics below target") invites reading a reading as a to-do list, and a
   * red badge on a tab can be misread as the whole view being red. Keep this for
   * countable records the user can act on.
   */
  badge?: number;
  /**
   * How the badge reads to a screen reader, e.g. "4 concerns need attention".
   * The bare number is announced next to the label otherwise, which says nothing
   * about what it counts. Defaults to "<n> need attention".
   */
  badgeLabel?: string;
}

export default function FolderTabs<K extends string>({
  items,
  active,
  onChange,
  surface = "card",
  className = "",
}: {
  items: FolderTabItem<K>[];
  active: K;
  onChange: (key: K) => void;
  /** The surface directly beneath the tab band. The active tab matches it. */
  surface?: "card" | "muted" | "background";
  className?: string;
}) {
  const activeFill =
    surface === "muted"
      ? "bg-muted"
      : surface === "background"
        ? "bg-background"
        : "bg-card";

  // Badges sit ABOVE and to the RIGHT of the tab corner, so the band needs top
  // room for them and wider gaps so a badge doesn't sit on its neighbour. Both
  // are conditional: callers with no badges keep the original tight layout.
  const hasBadges = items.some((i) => (i.badge ?? 0) > 0);

  return (
    <div
      className={`flex flex-wrap ${hasBadges ? "gap-3 pt-2" : "gap-1"} ${className}`}
    >
      {items.map((item) => {
        const isActive = item.key === active;
        const count = item.badge ?? 0;
        return (
          <button
            key={item.key}
            type="button"
            onClick={() => onChange(item.key)}
            aria-current={isActive ? "page" : undefined}
            className={`relative -mb-px rounded-t-md px-4 py-2 text-sm font-semibold transition-colors ${
              isActive
                ? `border border-b-0 border-border ${activeFill} text-foreground`
                : "border border-transparent text-muted-foreground hover:text-foreground"
            }`}
          >
            {item.label}
            {count > 0 && (
              <>
                <span
                  aria-hidden
                  // Overhangs the corner: most of the circle sits above the
                  // tab's top edge and clear of its right edge.
                  className="absolute -right-2 -top-2 flex h-5 min-w-[1.25rem] items-center justify-center rounded-full bg-destructive px-1 text-xs font-bold leading-none tabular-nums text-destructive-foreground shadow-sm"
                >
                  {count > 99 ? "99+" : count}
                </span>
                {/* The visible badge is a bare number, which tells a screen
                    reader nothing about what it counts. */}
                <span className="sr-only">
                  {" "}
                  — {item.badgeLabel ?? `${count} need attention`}
                </span>
              </>
            )}
          </button>
        );
      })}
    </div>
  );
}
