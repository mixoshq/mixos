/* This Source Code Form is subject to the terms of the Mozilla Public
 * License, v. 2.0. If a copy of the MPL was not distributed with this
 * file, You can obtain one at https://mozilla.org/MPL/2.0/. */

"use client";

import { useMemo, useState } from "react";
import { Search } from "lucide-react";
import type { AppManifest } from "@/lib/apps/types";
import type { AppReplacement } from "@/lib/apps/access";
import AppTile from "./app-tile";
import RemoveDialog, { type RemoveTarget } from "./remove/remove-dialog";
import { CARD_SHELL } from "@/components/ui/card";
import { cn } from "@/lib/utils";

interface MissingConnector {
  name: string;
  displayName: string;
}

interface Props {
  apps: AppManifest[];
  missingConnectorsBySlug: Record<string, MissingConnector[]>;
  /** Grant holders per slug. A slug with no grants is absent, meaning 0. */
  grantCountsBySlug: Record<string, number>;
  /** Live table counts per slug. A slug with no tables is absent, meaning 0. */
  tableCountsBySlug: Record<string, number>;
  activeBySlug: Record<string, boolean>;
  /** Apps the release step brought back with different code: slug to when. */
  returnedChangedBySlug: Record<string, string>;
  /** Apps the release step found under a slug a different extension had. */
  replacedBySlug: Record<string, AppReplacement>;
}

export default function AppRegistryList({
  apps,
  missingConnectorsBySlug,
  grantCountsBySlug,
  tableCountsBySlug,
  activeBySlug,
  returnedChangedBySlug,
  replacedBySlug,
}: Props) {
  const [query, setQuery] = useState("");
  /** The app whose Remove dialog is open, or null. One dialog for the grid. */
  const [removing, setRemoving] = useState<RemoveTarget | null>(null);
  const lower = query.toLowerCase();
  /*
    Search is the only filter left. The status tabs it sat beside — All /
    Registered / Unregistered — partitioned the list by a state that no longer
    exists: every app in this list is in the registry, and being in the registry
    is the whole of being valid.
  */
  const filtered = useMemo(
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

  return (
    <>
      <div className="mb-4 flex flex-col gap-2 sm:flex-row sm:items-center">
        <div className="relative flex-1">
          <Search className="absolute left-3 top-1/2 h-4 w-4 -translate-y-1/2 text-muted-foreground" />
          <input
            type="text"
            placeholder="Search apps..."
            aria-label="Search apps"
            value={query}
            onChange={(e) => setQuery(e.target.value)}
            className="w-full rounded-lg border border-input bg-background py-2 pl-9 pr-3 text-sm shadow-sm focus:outline-none focus:ring-1 focus:ring-ring"
          />
        </div>
      </div>
      {/*
        The same grid the connector and theme registries use — three columns at
        lg, two at sm — so the three registries are one layout an admin learns
        once. This was a divided list of full-width rows, which is why apps felt
        like a different kind of object from the other two.
      */}
      {filtered.length > 0 ? (
        <div className="grid grid-cols-1 gap-4 sm:grid-cols-2 lg:grid-cols-3">
          {filtered.map((app) => (
            <AppTile
              key={app.slug}
              app={app}
              missingConnectors={missingConnectorsBySlug[app.slug] ?? []}
              grantCount={grantCountsBySlug[app.slug] ?? 0}
              tableCount={tableCountsBySlug[app.slug] ?? 0}
              // Absent means the registry sync has not run since this app
              // appeared, which is not the same as active.
              isActive={activeBySlug[app.slug] === true}
              returnedChangedAt={returnedChangedBySlug[app.slug] ?? null}
              replacement={replacedBySlug[app.slug] ?? null}
              onRemove={() => setRemoving({ kind: "app", slug: app.slug, name: app.name })}
            />
          ))}
        </div>
      ) : (
        <div
          className={cn(CARD_SHELL, "p-5 text-center text-muted-foreground")}
        >
          {query
            ? "No apps match your search."
            : "No apps found. Add an app to the /apps directory."}
        </div>
      )}
      {removing && <RemoveDialog target={removing} onClose={() => setRemoving(null)} />}
    </>
  );
}
