/* This Source Code Form is subject to the terms of the Mozilla Public
 * License, v. 2.0. If a copy of the MPL was not distributed with this
 * file, You can obtain one at https://mozilla.org/MPL/2.0/. */

"use client";

import Image from "next/image";
import { Plug } from "lucide-react";
import { Button } from "@/components/ui/button";
import { StatusPill } from "@/components/ui/status";
import { truncateWords, TILE_DESCRIPTION_WORDS } from "@/lib/apps/display";
import type { ConnectorConfigState } from "@/lib/connectors/status";
import type { ConnectorWithStatus } from "./connector-registry-list";
import { CARD_SHELL } from "@/components/ui/card";
import { cn } from "@/lib/utils";
import { TileFooter } from "./provenance";

/**
 * One connector in the registry grid.
 *
 * THE TINT IS NEVER THE ONLY SIGNAL. Every state also carries its words in the
 * pill, per `ui/status.tsx` — a green card that says nothing is a colour-only
 * status, and the one person most likely to administer a deployment alone is
 * the one least likely to have someone to ask what green meant.
 *
 * WHY A TINT AND NOT A SOLID FILL. `docs/apps/ux.md` measured `text-warning` on
 * `bg-warning/10` at 4.39:1 — under the floor. So the tint carries no text of
 * its own: body copy on these cards stays `text-foreground` / `text-muted-
 * foreground` over the card ground, and the only thing sitting on a status
 * colour is the pill, which uses the solid token with its own foreground.
 */
const TILE_TONE: Record<ConnectorConfigState, string> = {
  ready: "border-success/40 bg-success/10",
  "needs-authorization": "border-warning/40 bg-warning/10",
  // Empty, not a repeat of the shell's own `border-border bg-card`: the
  // untinted state IS the card shell, and restating it here is how the two
  // would later drift apart.
  unconfigured: "",
};

const STATUS_LABEL: Record<ConnectorConfigState, string> = {
  ready: "Configured",
  "needs-authorization": "Needs authorization",
  unconfigured: "Not configured",
};

const STATUS_TONE = {
  ready: "success",
  "needs-authorization": "warning",
  unconfigured: "neutral",
} as const;

export default function ConnectorTile({
  connector,
  onConfigure,
  onDisable,
  onEnable,
  switching,
}: {
  connector: ConnectorWithStatus;
  /** Opens the Configure dialog, whose footer also offers Remove. */
  onConfigure: () => void;
  /** Opens Disable's confirmation; nothing changes until it is confirmed. */
  onDisable: () => void;
  onEnable: () => void;
  /** A Disable or Enable is in flight somewhere in the grid. */
  switching: boolean;
}) {
  const { state } = connector;
  const disabled = connector.disabledAt !== null;

  return (
    <div
      className={cn(
        CARD_SHELL,
        "flex h-full flex-col p-5 transition-colors",
        // No tint while disabled: a green card would read as "ready to call"
        // for a connector nothing may call. The pill below says why.
        !disabled && TILE_TONE[state],
      )}
    >
      <div className="flex items-start gap-3">
        {/*
          The icon sits on its own neutral plate rather than directly on the
          tint. A provider's mark is drawn against white and carries its own
          colours; laying it on a green wash makes both look wrong, and the
          plate keeps every tile's icon area identical whether or not the
          connector ships artwork.
        */}
        <span className="flex h-13 w-13 shrink-0 items-center justify-center overflow-hidden rounded-lg border border-border bg-background">
          {connector.icon ? (
            <Image
              src={connector.icon}
              alt=""
              width={52}
              height={52}
              className="h-10 w-10 object-contain"
            />
          ) : (
            <Plug className="h-6 w-6 text-muted-foreground" aria-hidden />
          )}
        </span>

        <div className="min-w-0 flex-1">
          {/* text-lg is the design system's card-title size (CARD_TITLE in
              ui/card.tsx) — staying on the type scale rather than introducing a
              one-off size for this one heading. */}
          <h3
            className="truncate text-lg font-medium text-foreground"
            title={connector.displayName}
          >
            {connector.displayName}
          </h3>
          {/* `title` carries the whole description, since this is a cut of it.
              The dialog shows all of it. */}
          <p
            className="mt-1 text-sm text-muted-foreground"
            title={connector.description}
          >
            {truncateWords(connector.description, TILE_DESCRIPTION_WORDS)}
          </p>
        </div>

        {/* Top right, and `shrink-0` so it never compresses: the status is the
            one thing this grid exists to show at a glance, so when the row is
            tight it is the connector's NAME that truncates, not this. */}
        <span className="shrink-0">
          <StatusPill tone={STATUS_TONE[state]}>
            {STATUS_LABEL[state]}
          </StatusPill>
        </span>
      </div>

      {/* The app tile's Inactive pill, for the same kind of fact: an admin
          switched this off, and the corner pill still says how it is set up.
          The release step switches it off too when a different connector has
          taken the name, and the second pill says so: Enable then asks for
          the name. */}
      {(disabled || connector.replacement) && (
        <div className="mt-3 flex flex-wrap items-center gap-1.5">
          {disabled && <StatusPill tone="warning">Disabled</StatusPill>}
          {connector.replacement && (
            <StatusPill tone="warning">Replaces a different extension</StatusPill>
          )}
        </div>
      )}

      {/* mt-auto pins the actions and the provenance band to the bottom, so
          tiles of differing height still line their buttons up across the
          row. The path is in the Configure dialog's footer, as the app's is in
          its Details dialog. */}
      <div className="mt-auto flex items-center justify-end gap-3 pt-4">
        <div className="flex shrink-0 items-center gap-2">
          {/* The app tile's Activate and Deactivate, in the same weights:
              Enable is the primary action while the connector is off, and
              Disable is the quiet one, since it stops every app that uses
              the connector at once. */}
          <Button
            variant={disabled ? "primary" : "ghost"}
            size="sm"
            disabled={switching}
            onClick={disabled ? onEnable : onDisable}
            aria-label={`${disabled ? "Enable" : "Disable"} ${connector.displayName}`}
          >
            {disabled ? "Enable" : "Disable"}
          </Button>
          <Button
            variant={disabled || state === "ready" ? "secondary" : "primary"}
            size="sm"
            onClick={onConfigure}
          >
            Configure
          </Button>
        </div>
      </div>

      {/* The Configure dialog's footer band, in the same words, as on the app
          and theme tiles. */}
      <TileFooter lastUpdated={connector.lastUpdated} authors={connector.authors} />
    </div>
  );
}
