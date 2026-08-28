/* This Source Code Form is subject to the terms of the Mozilla Public
 * License, v. 2.0. If a copy of the MPL was not distributed with this
 * file, You can obtain one at https://mozilla.org/MPL/2.0/. */

"use client";

import Image from "next/image";
import { Plug } from "lucide-react";
import { Button } from "@/components/ui/button";
import { StatusPill } from "@/components/ui/status";
import type { ConnectorConfigState } from "@/lib/connectors/status";
import type { ConnectorWithStatus } from "./connector-registry-list";

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
  unconfigured: "border-border bg-card",
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

/** Words of the description shown on a tile. The dialog shows all of it. */
const TILE_DESCRIPTION_WORDS = 15;

/**
 * Cut to a whole-word boundary.
 *
 * By word rather than by character because this is prose being cut mid-sentence
 * — a character cut lands inside a word and reads as a rendering fault, where a
 * word cut reads as a deliberate "there's more". Trailing punctuation goes with
 * it, so the join is `…` and never `.…`.
 */
function truncateWords(text: string, max: number): string {
  const words = text.trim().split(/\s+/);
  if (words.length <= max) return text;
  return `${words.slice(0, max).join(" ").replace(/[.,;:!?]+$/, "")}…`;
}

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
      className={`mix-card flex h-full flex-col rounded-xl border p-4 shadow-sm transition-colors ${TILE_TONE[state]}`}
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
          <h3 className="truncate text-lg font-medium text-foreground" title={connector.displayName}>
            {connector.displayName}
          </h3>
          {/* `title` carries the whole description, since this is a cut of it.
              The dialog shows all of it. */}
          <p className="mt-1 text-sm text-muted-foreground" title={connector.description}>
            {truncateWords(connector.description, TILE_DESCRIPTION_WORDS)}
          </p>
        </div>

        {/* Top right, and `shrink-0` so it never compresses: the status is the
            one thing this grid exists to show at a glance, so when the row is
            tight it is the connector's NAME that truncates, not this. */}
        <span className="shrink-0">
          <StatusPill tone={STATUS_TONE[state]}>{STATUS_LABEL[state]}</StatusPill>
        </span>
      </div>

      {/* mt-auto pins the action to the bottom, so tiles of differing height
          still line their buttons up across the row. */}
      <div className="mt-auto flex justify-end pt-4">
        <Button
          variant={state === "ready" ? "secondary" : "primary"}
          size="sm"
          onClick={onConfigure}
        >
          Configure
        </Button>
      </div>
    </div>
  );
}
