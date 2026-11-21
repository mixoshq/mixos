/* This Source Code Form is subject to the terms of the Mozilla Public
 * License, v. 2.0. If a copy of the MPL was not distributed with this
 * file, You can obtain one at https://mozilla.org/MPL/2.0/. */

"use client";

import { Search } from "lucide-react";
import { useSearch } from "./search-context";

/**
 * The menu bar's search icon, before the gift. Absent when the person hid it
 * on their Search settings page; the shortcut still works if it is on.
 */
export default function SearchButton() {
  const { prefs, openSearch, shortcutLabel } = useSearch();
  if (!prefs.showIcon) return null;
  const label = prefs.shortcutEnabled ? `Search (${shortcutLabel})` : "Search";
  return (
    <button
      type="button"
      onClick={openSearch}
      aria-label={label}
      aria-haspopup="dialog"
      title={label}
      className="flex items-center rounded-md p-1.5 text-brand-foreground transition-colors hover:bg-brand-foreground/10"
    >
      <Search className="h-4 w-4" aria-hidden />
    </button>
  );
}
