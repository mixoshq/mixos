"use client";

import { useMemo, useState } from "react";
import { Search } from "lucide-react";
import type { AppManifest } from "@/lib/apps/types";
import AppRegisterList from "./app-register-list";

interface MissingConnector {
  name: string;
  displayName: string;
}

interface Props {
  apps: AppManifest[];
  registeredSlugs: string[];
  missingConnectorsBySlug: Record<string, MissingConnector[]>;
}

type StatusFilter = "all" | "registered" | "unregistered";

const STATUS_OPTIONS: Array<{ value: StatusFilter; label: string }> = [
  { value: "all", label: "All" },
  { value: "registered", label: "Registered" },
  { value: "unregistered", label: "Unregistered" },
];

export default function AppRegistryList({
  apps,
  registeredSlugs,
  missingConnectorsBySlug,
}: Props) {
  const [query, setQuery] = useState("");
  const [status, setStatus] = useState<StatusFilter>("all");
  const registeredSet = useMemo(
    () => new Set(registeredSlugs),
    [registeredSlugs],
  );
  const lower = query.toLowerCase();
  const searchMatches = useMemo(
    () =>
      apps.filter((a) => {
        if (!query) return true;
        return (
          a.name.toLowerCase().includes(lower) ||
          a.slug.toLowerCase().includes(lower) ||
          a.description.toLowerCase().includes(lower)
        );
      }),
    [apps, query, lower],
  );
  const counts = useMemo(() => {
    let registered = 0;
    let unregistered = 0;
    for (const a of searchMatches) {
      if (registeredSet.has(a.slug)) registered++;
      else unregistered++;
    }
    return { all: searchMatches.length, registered, unregistered };
  }, [searchMatches, registeredSet]);
  const filtered = searchMatches.filter((a) => {
    if (status === "registered") return registeredSet.has(a.slug);
    if (status === "unregistered") return !registeredSet.has(a.slug);
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
            className="w-full rounded-lg border border-border bg-background py-2 pl-9 pr-3 text-sm shadow-sm focus:outline-none focus:ring-1 focus:ring-ring"
          />
        </div>
        <div
          role="tablist"
          aria-label="Filter by registration status"
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
                    ? "bg-mixnavy text-white"
                    : "text-muted-foreground hover:text-foreground"
                }`}
              >
                <span>{opt.label}</span>
                <span
                  className={`rounded px-1.5 py-px text-xs tabular-nums ${
                    active
                      ? "bg-white/20 text-white"
                      : "bg-muted text-muted-foreground"
                  }`}
                >
                  {count}
                </span>
              </button>
            );
          })}
        </div>
      </div>
      <div className="rounded-xl border border-border bg-card shadow-sm">
        <div className="divide-y divide-border">
          {filtered.length > 0 ? (
            filtered.map((app) => (
              <AppRegisterList
                key={app.slug}
                app={app}
                registered={registeredSet.has(app.slug)}
                missingConnectors={missingConnectorsBySlug[app.slug] ?? []}
              />
            ))
          ) : (
            <div className="px-6 py-8 text-center text-muted-foreground">
              {query || status !== "all"
                ? "No apps match your filters."
                : "No apps found. Add an app to the /apps directory."}
            </div>
          )}
        </div>
      </div>
    </>
  );
}
