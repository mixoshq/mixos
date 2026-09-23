/* This Source Code Form is subject to the terms of the Mozilla Public
 * License, v. 2.0. If a copy of the MPL was not distributed with this
 * file, You can obtain one at https://mozilla.org/MPL/2.0/. */

"use client";

import Image from "next/image";
import { Plug } from "lucide-react";
import { Button } from "@/components/ui/button";
import { StatusPill } from "@/components/ui/status";
import {
  renderAuthors,
  formatLastUpdated,
  truncateWords,
  TILE_DESCRIPTION_WORDS,
} from "@/lib/apps/display";
import type { ConnectorConfigState } from "@/lib/connectors/status";
import type { ConnectorWithStatus } from "./connector-registry-list";
import { CARD_SHELL } from "@/components/ui/card";
import { cn } from "@/lib/utils";

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
}: {
  connector: ConnectorWithStatus;
  onConfigure: () => void;
}) {
  const { state } = connector;

  return (
    <div
      className={cn(
        CARD_SHELL,
        "flex h-full flex-col p-5 transition-colors",
        TILE_TONE[state],
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

      {/* mt-auto pins the action and the provenance row to the bottom, so
          tiles of differing height still line their buttons up across the
          row. */}
      <div className="mt-auto flex items-center justify-between gap-3 pt-4">
        {/* Where this connector's source lives — the same third provenance
            fact the configure dialog puts beside its footer, in the same mono
            treatment: the row below says when it changed and who changed it,
            this says where to go to change it yourself. */}
        <code className="min-w-0 truncate font-mono text-xs text-muted-foreground">
          /connectors/{connector.name}/
        </code>
        <Button
          variant={state === "ready" ? "secondary" : "primary"}
          size="sm"
          className="shrink-0"
          onClick={onConfigure}
        >
          Configure
        </Button>
      </div>

      {/* Identical to the theme tile's footer, deliberately: an admin moving
          between /admin/connectors and /admin/themes reads provenance in the
          same place, in the same words. */}
      <div className="mt-3 flex items-baseline justify-between gap-3 border-t border-border pt-3 text-[10px] leading-none text-muted-foreground">
        <p className="min-w-0 truncate">
          {connector.authors.length > 0 && (
            <>
              <strong className="font-semibold">Authored By</strong>{" "}
              {renderAuthors(connector.authors)}
            </>
          )}
        </p>
        <p className="shrink-0">
          <strong className="font-semibold">Updated</strong>{" "}
          {/* Stamped by the pre-commit hook, so a connector edited but not yet
              committed says so rather than showing a stale date. */}
          {formatLastUpdated(connector.lastUpdated, "Not yet committed")}
        </p>
      </div>
    </div>
  );
}
