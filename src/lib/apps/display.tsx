/* This Source Code Form is subject to the terms of the Mozilla Public
 * License, v. 2.0. If a copy of the MPL was not distributed with this
 * file, You can obtain one at https://mozilla.org/MPL/2.0/. */

import type { ReactNode } from "react";
import type { AppAuthor } from "./types";

/**
 * Render a timestamp as a short relative age ("3 days ago").
 *
 * `fallback` is what to show when there is no timestamp. Apps and connectors
 * pass "Not yet committed", because for them a null date has a specific meaning:
 * the item has never been part of a commit, so the pre-commit stamp has never
 * run for it. Other callers (e.g. MCP client "connected" / "last used" times)
 * keep the generic default, where a missing value really is just unknown.
 */
export function formatLastUpdated(
  ts: number | null | undefined,
  fallback = "Unknown",
): string {
  if (!ts) return fallback;
  const diff = Date.now() - ts;
  const day = 24 * 60 * 60 * 1000;
  if (diff < 60 * 1000) return "just now";
  if (diff < 60 * 60 * 1000) {
    const m = Math.round(diff / (60 * 1000));
    return `${m} min${m === 1 ? "" : "s"} ago`;
  }
  if (diff < day) {
    const h = Math.round(diff / (60 * 60 * 1000));
    return `${h} hour${h === 1 ? "" : "s"} ago`;
  }
  if (diff < 30 * day) {
    const d = Math.round(diff / day);
    return `${d} day${d === 1 ? "" : "s"} ago`;
  }
  return new Date(ts).toLocaleDateString(undefined, {
    year: "numeric",
    month: "short",
    day: "numeric",
  });
}

/**
 * Renders authors as a comma-separated list. When an author has an email,
 * their name is wrapped in a mailto: link.
 */
export function renderAuthors(
  authors: AppAuthor[] | undefined
): ReactNode | null {
  if (!authors || authors.length === 0) return null;
  const items = authors
    .filter((a) => a.name || a.email)
    .map((a, i) => {
      const label = a.name || a.email;
      const node = a.email ? (
        <a
          key={`${a.email}-${i}`}
          href={`mailto:${a.email}`}
          className="hover:text-foreground hover:underline"
          onClick={(e) => e.stopPropagation()}
        >
          {label}
        </a>
      ) : (
        <span key={`${a.name}-${i}`}>{label}</span>
      );
      return node;
    });
  return items.flatMap((node, i) =>
    i === 0 ? [node] : [<span key={`sep-${i}`}>, </span>, node]
  );
}
