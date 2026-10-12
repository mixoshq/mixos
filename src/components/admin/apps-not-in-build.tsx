/* This Source Code Form is subject to the terms of the Mozilla Public
 * License, v. 2.0. If a copy of the MPL was not distributed with this
 * file, You can obtain one at https://mozilla.org/MPL/2.0/. */

import type { AppNotInBuild } from "@/lib/apps/access";
import LucideIcon from "@/components/lucide-icon";
import { StatusPill } from "@/components/ui/status";
import { CARD_SHELL } from "@/components/ui/card";
import { formatCount, formatLastUpdated } from "@/lib/apps/display";
import { cn } from "@/lib/utils";
import DeleteDataButton from "./data/delete-data-button";

/**
 * Apps this database keeps that this build doesn't carry.
 *
 * The release step marks an app that leaves the build rather than deleting it
 * (scripts/sync-app-registry.ts), so its grants, installs, widgets, settings and
 * tables outlive a removed folder, a rename or a skip by the build. Without
 * this list that data would be invisible: the grid above is the build's
 * registry, and these apps are exactly the ones missing from it.
 *
 * Keeping is the default and needs nothing. Bringing an app back is a deploy,
 * not a click. The one action is **Delete data…**, destructive, whose dialog
 * asks for the slug typed and which the server refuses until the app has gone
 * from every build that uses this database (src/lib/repository/delete-data.ts).
 */
export default function AppsNotInBuild({
  apps,
  grantCountsBySlug,
}: {
  apps: AppNotInBuild[];
  /** Grant holders per slug, as the grid reads them. Absent means 0. */
  grantCountsBySlug: Record<string, number>;
}) {
  if (apps.length === 0) return null;

  return (
    <section aria-labelledby="apps-not-in-build" className="mt-10">
      <h2
        id="apps-not-in-build"
        className="text-lg font-medium text-foreground"
      >
        Not in this build
      </h2>
      <p className="mt-1 text-sm text-muted-foreground">
        Removed from the repository, renamed, or skipped by the build. Nobody
        can open these, and everything they had is kept: activation, grants,
        installs, widgets, settings and tables. Restore an app&apos;s folder
        and deploy to bring it back. With the same files it returns as it was;
        with different files it returns switched off. Once no build that uses
        this database has an app, Delete data removes what it kept here.
      </p>
      <ul className="mt-4 grid gap-4 sm:grid-cols-2 lg:grid-cols-3">
        {apps.map((app) => {
          const grants = grantCountsBySlug[app.slug] ?? 0;
          return (
            <li
              key={app.slug}
              className={cn(CARD_SHELL, "flex items-start gap-3 p-5")}
            >
              {/* The app tile's icon plate, from the name the sync recorded. */}
              <span className="flex h-13 w-13 shrink-0 items-center justify-center rounded-lg border border-border bg-background">
                <LucideIcon
                  name={app.icon ?? "box"}
                  className="h-6 w-6 text-muted-foreground"
                />
              </span>
              <div className="min-w-0 flex-1">
                <h3
                  className="truncate text-lg font-medium text-foreground"
                  title={app.name}
                >
                  {app.name}
                </h3>
                <div className="mt-2 flex flex-wrap items-center gap-1.5">
                  <StatusPill tone="warning">Missing from this build</StatusPill>
                  {grants > 0 && (
                    <StatusPill tone="neutral">
                      {formatCount(grants, "granted user")}
                    </StatusPill>
                  )}
                </div>
                <p className="mt-3 flex items-baseline justify-between gap-3 text-xs text-muted-foreground">
                  <code className="min-w-0 truncate font-mono">
                    /apps/{app.slug}/
                  </code>
                  {/* Null until a release step runs without it: a build
                      serving without its own release step, such as a host's
                      rollback, can lack an app that no step has marked. */}
                  {app.missingSince && (
                    <span className="shrink-0">
                      Left {formatLastUpdated(Date.parse(app.missingSince))}
                    </span>
                  )}
                </p>
                <div className="mt-3 flex justify-end">
                  <DeleteDataButton kind="app" slug={app.slug} name={app.name} />
                </div>
              </div>
            </li>
          );
        })}
      </ul>
    </section>
  );
}
