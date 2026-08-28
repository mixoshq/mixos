/* This Source Code Form is subject to the terms of the Mozilla Public
 * License, v. 2.0. If a copy of the MPL was not distributed with this
 * file, You can obtain one at https://mozilla.org/MPL/2.0/. */

"use client";

import { useMemo, useState } from "react";
import { Search } from "lucide-react";
import type { AppManifest } from "@/lib/apps/types";
import AppToggleList from "./app-toggle-list";

interface MissingConnector {
  name: string;
  displayName: string;
}

interface Props {
  apps: AppManifest[];
  installedSlugs: string[];
  missingUserConnectorsBySlug: Record<string, MissingConnector[]>;
}

type StatusFilter = "all" | "installed" | "not-installed";

const STATUS_OPTIONS: Array<{ value: StatusFilter; label: string }> = [
  { value: "all", label: "All" },
  { value: "installed", label: "Installed" },
  { value: "not-installed", label: "Not Installed" },
];

export default function AppManagerList({
  apps,
  installedSlugs,
  missingUserConnectorsBySlug,
}: Props) {
  const [query, setQuery] = useState("");
  const [fullAppOnly, setFullAppOnly] = useState(false);
  const [widgetsOnly, setWidgetsOnly] = useState(false);
  const [status, setStatus] = useState<StatusFilter>("all");

  const installedSet = useMemo(
    () => new Set(installedSlugs),
    [installedSlugs],
  );
  const lower = query.toLowerCase();
  const baseFiltered = useMemo(
    () =>
      apps.filter((a) => {
        if (query) {
          const matches =
            a.name.toLowerCase().includes(lower) ||
            a.slug.toLowerCase().includes(lower) ||
            a.description.toLowerCase().includes(lower);
          if (!matches) return false;
        }
        if (fullAppOnly && !a.hasPages) return false;
        if (widgetsOnly && a.widgets.length === 0) return false;
        return true;
      }),
    [apps, query, lower, fullAppOnly, widgetsOnly],
  );
  const counts = useMemo(() => {
    let installed = 0;
    let notInstalled = 0;
    for (const a of baseFiltered) {
      if (installedSet.has(a.slug)) installed++;
      else notInstalled++;
    }
    return {
      all: baseFiltered.length,
      installed,
      "not-installed": notInstalled,
    };
  }, [baseFiltered, installedSet]);
  const filtered = baseFiltered.filter((a) => {
    if (status === "installed") return installedSet.has(a.slug);
    if (status === "not-installed") return !installedSet.has(a.slug);
    return true;
  });

  return (
    <>
      <div className="mb-4 flex flex-col gap-2 sm:flex-row sm:items-center">
        <div className="relative flex-1">
          <Search className="absolute left-3 top-1/2 h-4 w-4 -translate-y-1/2 text-muted-foreground" />
          <input
            type="text"
            placeholder="Search apps..."
            value={query}
            onChange={(e) => setQuery(e.target.value)}
            className="w-full rounded-lg border border-input bg-background py-2 pl-9 pr-3 text-sm shadow-sm focus:outline-none focus:ring-1 focus:ring-ring"
          />
        </div>
        <div
          role="tablist"
          aria-label="Filter by install status"
          className="inline-flex shrink-0 rounded-lg border border-border bg-background p-0.5 shadow-sm"
        >
          {STATUS_OPTIONS.map((opt) => {
            const active = status === opt.value;
            const count = counts[opt.value];
            return (
              <button
                key={opt.value}
                role="tab"
                type="button"
                aria-selected={active}
                onClick={() => setStatus(opt.value)}
                className={`inline-flex items-center gap-1.5 rounded-md px-3 py-1.5 text-sm transition-colors ${
                  active
                    ? "bg-brand text-brand-foreground"
                    : "text-muted-foreground hover:text-foreground"
                }`}
              >
                <span>{opt.label}</span>
                <span
                  className={`rounded px-1.5 py-px text-xs tabular-nums ${
                    active
                      ? "bg-white/20 text-white"
                      : "bg-muted text-foreground"
                  }`}
                >
                  {count}
                </span>
              </button>
            );
          })}
        </div>
        <div className="flex shrink-0 items-center gap-3">
          <label className="flex cursor-pointer items-center gap-1.5 text-sm">
            <input
              type="checkbox"
              checked={fullAppOnly}
              onChange={(e) => setFullAppOnly(e.target.checked)}
              className="h-4 w-4 rounded border-border accent-brand"
            />
            Full App
          </label>
          <label className="flex cursor-pointer items-center gap-1.5 text-sm">
            <input
              type="checkbox"
              checked={widgetsOnly}
              onChange={(e) => setWidgetsOnly(e.target.checked)}
              className="h-4 w-4 rounded border-border accent-brand"
            />
            Widgets
          </label>
        </div>
      </div>
      <div className="rounded-xl border border-border bg-card shadow-sm">
        <div className="divide-y divide-border">
          {filtered.length > 0 ? (
            filtered.map((app) => (
              <AppToggleList
                key={app.slug}
                app={app}
                installed={installedSet.has(app.slug)}
                missingUserConnectors={missingUserConnectorsBySlug[app.slug] ?? []}
              />
            ))
          ) : (
            <div className="px-6 py-8 text-center text-muted-foreground">
              {query || fullAppOnly || widgetsOnly || status !== "all"
                ? "No apps match the current filters."
                : "No apps have been granted to you yet. Ask an admin to grant access."}
            </div>
          )}
        </div>
      </div>
    </>
  );
}
