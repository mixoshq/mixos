/* This Source Code Form is subject to the terms of the Mozilla Public
 * License, v. 2.0. If a copy of the MPL was not distributed with this
 * file, You can obtain one at https://mozilla.org/MPL/2.0/. */

import { Plug } from "lucide-react";
import type { ConnectorNotInBuild } from "@/lib/connectors/not-in-build";
import { StatusPill } from "@/components/ui/status";
import { CARD_SHELL } from "@/components/ui/card";
import { formatCount, formatLastUpdated } from "@/lib/apps/display";
import { cn } from "@/lib/utils";
import DeleteDataButton from "./data/delete-data-button";

/**
 * Connectors this database keeps credentials or connections for that this
 * build doesn't carry: Admin > Connectors' Not in this build, as Admin > Apps
 * has for apps (./apps-not-in-build.tsx).
 *
 * A connector's credentials, and its users' connections, outlive its folder.
 * Without this list they would be invisible: the grid above is the build's
 * registry. Keeping them is the default and needs nothing; the one action is
 * **Delete data…**, which the server refuses until no build that uses this
 * database has the connector (src/lib/repository/delete-data.ts).
 *
 * The build no longer has its manifest, so an entry shows the connector's
 * name, and what is kept.
 */
export default function ConnectorsNotInBuild({ connectors }: { connectors: ConnectorNotInBuild[] }) {
  if (connectors.length === 0) return null;

  return (
    <section aria-labelledby="connectors-not-in-build" className="mt-10">
      <h2 id="connectors-not-in-build" className="text-lg font-medium text-foreground">
        Not in this build
      </h2>
      <p className="mt-1 text-sm text-muted-foreground">
        Removed from the repository, or skipped by the build. No app can call
        these, and what they had is kept: the saved credentials and each
        user&apos;s own connection. Restore a connector&apos;s folder and
        deploy to bring it back. Once no build that uses this database has a
        connector, Delete data removes what it kept here.
      </p>
      <ul className="mt-4 grid gap-4 sm:grid-cols-2 lg:grid-cols-3">
        {connectors.map((c) => (
          <li key={c.name} className={cn(CARD_SHELL, "flex items-start gap-3 p-5")}>
            <span className="flex h-13 w-13 shrink-0 items-center justify-center rounded-lg border border-border bg-background">
              <Plug className="h-6 w-6 text-muted-foreground" aria-hidden />
            </span>
            <div className="min-w-0 flex-1">
              <h3 className="truncate font-mono text-base font-medium text-foreground" title={c.name}>
                {c.name}
              </h3>
              <div className="mt-2 flex flex-wrap items-center gap-1.5">
                <StatusPill tone="warning">Missing from this build</StatusPill>
                {c.credentials && <StatusPill tone="neutral">Credentials saved</StatusPill>}
                {c.connections > 0 && (
                  <StatusPill tone="neutral">{formatCount(c.connections, "user connection")}</StatusPill>
                )}
              </div>
              <p className="mt-3 flex items-baseline justify-between gap-3 text-xs text-muted-foreground">
                <code className="min-w-0 truncate font-mono" title={`/connectors/${c.name}/`}>
                  /connectors/{c.name}/
                </code>
                {/* Null until a release step runs without it. */}
                {c.missingSince && (
                  <span className="shrink-0">Left {formatLastUpdated(Date.parse(c.missingSince))}</span>
                )}
              </p>
              <div className="mt-3 flex justify-end">
                <DeleteDataButton kind="connector" slug={c.name} name={c.name} />
              </div>
            </div>
          </li>
        ))}
      </ul>
    </section>
  );
}
