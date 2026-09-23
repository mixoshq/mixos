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
  authors: AppAuthor[] | undefined,
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
    i === 0 ? [node] : [<span key={`sep-${i}`}>, </span>, node],
  );
}

/**
 * "1 table" / "3 tables" — a count that says what it counted.
 *
 * Shared because the same phrasing has to appear in two places that must agree:
 * the pills on a registry row and the facts panel inside that app's dialog. Two
 * copies is how "1 widgets" ships on one of them.
 */
export function formatCount(n: number, noun: string): string {
  return `${n} ${noun}${n === 1 ? "" : "s"}`;
}

/**
 * Words of an item's description shown on a registry tile. The details dialog
 * shows all of it.
 *
 * Shared so the apps and connectors grids cut at the same length: two tiles of
 * the same size, side by side in an admin's memory, should not disagree about
 * how much of a description is "the gist".
 */
export const TILE_DESCRIPTION_WORDS = 15;

/**
 * Cut to a whole-word boundary.
 *
 * By word rather than by character because this is prose being cut mid-sentence
 * — a character cut lands inside a word and reads as a rendering fault, where a
 * word cut reads as a deliberate "there's more". Trailing punctuation goes with
 * it, so the join is `…` and never `.…`.
 */
export function truncateWords(text: string, max: number): string {
  const words = text.trim().split(/\s+/);
  if (words.length <= max) return text;
  return `${words
    .slice(0, max)
    .join(" ")
    .replace(/[.,;:!?]+$/, "")}…`;
}
