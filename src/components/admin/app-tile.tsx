/* This Source Code Form is subject to the terms of the Mozilla Public
 * License, v. 2.0. If a copy of the MPL was not distributed with this
 * file, You can obtain one at https://mozilla.org/MPL/2.0/. */

"use client";

import { useState } from "react";
import type { AppManifest } from "@/lib/apps/types";
import LucideIcon from "@/components/lucide-icon";
import { Button } from "@/components/ui/button";
import { StatusPill } from "@/components/ui/status";
import { CARD_SHELL } from "@/components/ui/card";
import { cn } from "@/lib/utils";
import {
  renderAuthors,
  formatLastUpdated,
  formatCount,
  truncateWords,
  TILE_DESCRIPTION_WORDS,
} from "@/lib/apps/display";
import AppDetailsDialog, {
  MissingConnectorWarning,
} from "./app-details-dialog";

interface MissingConnector {
  name: string;
  displayName: string;
}

interface AppTileProps {
  app: AppManifest;
  missingConnectors: MissingConnector[];
  grantCount: number;
  /** Tables in this app's scoped database, counted live. */
  tableCount: number;
}

/**
 * One app in the registry grid.
 *
 * This was a full-width row in a divided list, which made apps the odd
 * abstraction out: connectors and themes were already tiles, so an admin moving
 * between the three registries met three different objects. The shell here is
 * the connector tile's, to the class — same `mix-card` rounded-xl border, same
 * padding, same icon plate, same path-and-action floor, same provenance footer.
 *
 * WHAT DID NOT COME ACROSS IS THE TINT. The connector tile washes its card in a
 * status colour because configuration is the whole point of that grid. An app
 * has no such state — every app in this list is in the registry, and being in
 * the registry is the whole of being valid — so tinting each card would invent
 * a status to report. Colour stays reserved for the one thing on this page that
 * genuinely signals state: the unconfigured-connector strip.
 */
export default function AppTile({
  app,
  missingConnectors,
  grantCount,
  tableCount,
}: AppTileProps) {
  const [detailsOpen, setDetailsOpen] = useState(false);

  /*
    An unconfigured connector is a warning here, not a gate. It used to block
    registration; there is no registration to block. What it still blocks is
    GRANTING the app to someone, which is enforced in /admin/users — so this
    strip says what is wrong and where the consequence lands, and stops there.
  */
  const missingSomething = missingConnectors.length > 0;

  /*
    The six Composition facts, in the order the dialog's panel states them — a
    tile is the summary of that panel, and two orders for one set of facts is a
    thing to re-learn per surface.

    Zeros are dropped: a tile is a glance, and "0 connectors · 0 tools · 0
    tables" is three pills spent saying nothing. The panel inside the dialog is
    where every fact is stated whether or not it is zero, because that is the
    surface built for comparing.

    A global app shows "Anyone" rather than a count. It has no grant rows at
    all, so the count would report the widest possible audience as zero — and
    zero is exactly what this list then hides.
  */
  const pills: string[] = [];
  if (app.global) pills.push("Anyone");
  else if (grantCount > 0) pills.push(formatCount(grantCount, "granted user"));
  if (app.pageCount > 0) pills.push(formatCount(app.pageCount, "page"));
  if (app.widgets.length > 0)
    pills.push(formatCount(app.widgets.length, "widget"));
  if (app.connectors.length > 0)
    pills.push(formatCount(app.connectors.length, "connector"));
  if (app.mcp.length > 0) pills.push(formatCount(app.mcp.length, "tool"));
  if (tableCount > 0) pills.push(formatCount(tableCount, "table"));

  return (
    <div
      className={cn(CARD_SHELL, "flex h-full flex-col p-5 transition-colors")}
    >
      {/*
        The tile is not a click target. Details is a button rather than the
        whole card because what it opens is a dialog, and a card that swallows
        the click takes the author's mailto: link in the footer with it.
      */}
      <div className="flex items-start gap-3">
        {/* The connector tile's icon plate, at the same size. An app ships a
            Lucide name rather than artwork, so the glyph sits where a
            provider's mark would. */}
        <span className="flex h-13 w-13 shrink-0 items-center justify-center rounded-lg border border-border bg-background">
          <LucideIcon
            name={app.icon}
            className="h-6 w-6 text-muted-foreground"
          />
        </span>

        <div className="min-w-0 flex-1">
          {/* text-lg is the design system's card-title size (CARD_TITLE in
              ui/card.tsx) — staying on the type scale rather than introducing a
              one-off size for this one heading. */}
          <h3
            className="truncate text-lg font-medium text-foreground"
            title={app.name}
          >
            {app.name}
          </h3>
          {/* `title` carries the whole description, since this is a cut of it.
              The dialog shows all of it. */}
          <p
            className="mt-1 text-sm text-muted-foreground"
            title={app.description}
          >
            {truncateWords(app.description, TILE_DESCRIPTION_WORDS)}
          </p>
        </div>
      </div>

      {/*
        One quiet tone for all six, not a colour each. The old row gave every
        badge its own fill, which reads as four severities when it is really
        four measurements — and six of those would be a traffic light.
      */}
      {pills.length > 0 && (
        <div className="mt-3 flex flex-wrap items-center gap-1.5">
          {pills.map((text) => (
            <StatusPill key={text} tone="neutral">
              {text}
            </StatusPill>
          ))}
        </div>
      )}

      {/* Repeated on the dialog's Overview for someone who opened it to find
          out what the strip was about. Inset rather than bled to the card's
          edges: a full-width band would cut the tile in two, and this is one
          fact about the app, not a second section. */}
      {missingSomething && (
        <div className="mt-3 rounded-lg border-l-4 border-brand-accent bg-brand-accent/10 py-2 pl-3 pr-3">
          <MissingConnectorWarning
            app={app}
            missingConnectors={missingConnectors}
          />
        </div>
      )}

      {/* mt-auto pins the action and the provenance row to the bottom, so
          tiles of differing height still line their buttons up across the
          row. */}
      <div className="mt-auto flex items-center justify-between gap-3 pt-4">
        {/* Where this app's source lives — the same third provenance fact the
            details dialog puts beside its footer, in the same mono treatment:
            the row below says when it changed and who changed it, this says
            where to go to change it yourself. */}
        <code className="min-w-0 truncate font-mono text-xs text-muted-foreground">
          /apps/{app.slug}/
        </code>
        {/* The theme tile's Apply and the connector tile's Configure, exactly:
            size="sm" and variant="primary". Details is the one thing there is
            to do on an app card — an app has no configuration to finish, so
            nothing here ever demotes to the secondary fill the connector tile
            uses for a connector that is already set up. */}
        <Button
          variant="primary"
          size="sm"
          className="shrink-0"
          onClick={() => setDetailsOpen(true)}
          // The tile names the app above this control, but a screen reader
          // moving button to button does not carry that with it: a registry of
          // forty apps otherwise announces forty buttons called "Details".
          aria-label={`Details for ${app.name}`}
        >
          Details
        </Button>
      </div>

      {/* Identical to the connector and theme tiles' footers, deliberately: an
          admin moving between the three registries reads provenance in the same
          place, in the same words. */}
      <div className="mt-3 flex items-baseline justify-between gap-3 border-t border-border pt-3 text-[10px] leading-none text-muted-foreground">
        <p className="min-w-0 truncate">
          {app.authors && app.authors.length > 0 && (
            <>
              <strong className="font-semibold">Authored By</strong>{" "}
              {renderAuthors(app.authors)}
            </>
          )}
        </p>
        <p className="shrink-0">
          <strong className="font-semibold">Updated</strong>{" "}
          {/* Stamped by the pre-commit hook, so an app edited but not yet
              committed says so rather than showing a stale date. */}
          {formatLastUpdated(app.lastUpdated, "Not yet committed")}
        </p>
      </div>

      <AppDetailsDialog
        app={app}
        missingConnectors={missingConnectors}
        grantCount={grantCount}
        open={detailsOpen}
        onClose={() => setDetailsOpen(false)}
      />
    </div>
  );
}
