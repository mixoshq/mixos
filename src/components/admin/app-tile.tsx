/* This Source Code Form is subject to the terms of the Mozilla Public
 * License, v. 2.0. If a copy of the MPL was not distributed with this
 * file, You can obtain one at https://mozilla.org/MPL/2.0/. */

"use client";

import { useState, useTransition } from "react";
import { AlertCircle } from "lucide-react";
import type { AppManifest } from "@/lib/apps/types";
import type { AppReplacement } from "@/lib/apps/access";
import LucideIcon from "@/components/lucide-icon";
import { Button } from "@/components/ui/button";
import { StatusPill } from "@/components/ui/status";
import { setAppActiveAction } from "@/lib/apps/admin-actions";
import { describeIdentity } from "@/lib/repository/identity";
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
import TypedConfirmDialog from "./typed-confirm-dialog";

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
  /** Whether the app serves anything on this instance. */
  isActive: boolean;
  /**
   * Set when the release step brought this app back into the build with files
   * that differ from the ones it left with, and switched it off. Activating
   * clears it.
   */
  returnedChangedAt: string | null;
  /**
   * Set when the release step found this app under a slug a different
   * extension had, switched it off and revoked its API keys. Activating needs
   * the slug typed, and clears it.
   */
  replacement: AppReplacement | null;
}

/**
 * One app in the registry grid.
 *
 * This was a full-width row in a divided list, which made apps the odd
 * abstraction out: connectors and themes were already tiles, so an admin moving
 * between the three registries met three different objects. The shell here is
 * the connector tile's, to the class — same `mix-card` rounded-lg border, same
 * padding, same icon plate, same path-and-action floor, same provenance footer.
 *
 * WHAT DID NOT COME ACROSS IS THE TINT. The connector tile washes its card in a
 * status colour because configuration is the whole point of that grid. An app
 * has no such state — every app in this list is in the registry, and being in
 * the registry is the whole of being valid — so tinting each card would invent
 * a status to report. Colour stays reserved for the things on this page that
 * genuinely need an admin: the unconfigured-connector strip, and the strip on
 * an app that came back into the build with different code, or that replaces
 * a different extension under its slug.
 */
export default function AppTile({
  app,
  missingConnectors,
  grantCount,
  tableCount,
  isActive,
  returnedChangedAt,
  replacement,
}: AppTileProps) {
  const [detailsOpen, setDetailsOpen] = useState(false);
  const [pending, startTransition] = useTransition();
  /** Activate's typed confirmation, for an app that replaces a different extension. */
  const [confirming, setConfirming] = useState(false);
  const [confirmError, setConfirmError] = useState<string | null>(null);

  // One message at a time. An app that came back as a different extension
  // usually came back with different code too, and the replacement is what
  // the admin has to answer: it asks more of them.
  const replaced = replacement !== null;
  const backChanged = returnedChangedAt !== null && !replaced;

  function toggleActive() {
    if (!isActive && replaced) {
      setConfirmError(null);
      setConfirming(true);
      return;
    }
    startTransition(async () => {
      await setAppActiveAction(app.slug, !isActive);
    });
  }

  function activateReplaced(typed: string) {
    startTransition(async () => {
      try {
        await setAppActiveAction(app.slug, true, typed);
        setConfirming(false);
      } catch {
        setConfirmError("It couldn't be activated. Reload the page and try again.");
      }
    });
  }

  /*
    An unconfigured connector is a warning here, not a gate. It used to block
    registration; there is no registration to block. What it still blocks is
    GRANTING the app to someone, which is enforced in /admin/users — so this
    strip says what is wrong and where the consequence lands, and stops there.
  */
  // An app whose connectors are not configured cannot serve a request, so
  // activating it would put a broken app in front of everyone. Deactivating
  // stays available whatever the state — the way out of a mistake must never
  // be gated on the thing that made it.
  const missingSomething = missingConnectors.length > 0;
  const blockActivate = !isActive && missingSomething;

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
      {(pills.length > 0 || !isActive || backChanged || replaced) && (
        <div className="mt-3 flex flex-wrap items-center gap-1.5">
          {/* The pills here that are states rather than measurements, so the
              ones that get a tone. Nothing marks an active app: active is
              what every app in a working instance is, and a green pill on
              every tile would be a row of decoration. */}
          {!isActive && <StatusPill tone="warning">Inactive</StatusPill>}
          {replaced && (
            <StatusPill tone="warning">Replaces a different extension</StatusPill>
          )}
          {backChanged && (
            <StatusPill tone="warning">Back with different code</StatusPill>
          )}
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

      {/* Why the pill above is there, and what clears it. The same strip as
          the connector warning: one fact about this app that needs an admin
          before it is used. */}
      {replacement && (
        <div className="mt-3 rounded-lg border-l-4 border-brand-accent bg-brand-accent/10 py-2 pl-3 pr-3">
          <p className="flex items-start gap-2 text-xs text-foreground">
            <AlertCircle className="mt-0.5 h-3.5 w-3.5 shrink-0 text-primary" />
            <span>
              A different extension had this slug before, so this app was
              switched off and its API keys were revoked. Its grants, settings
              and data were kept. Before: {describeIdentity(replacement.previous)}. Now:{" "}
              {describeIdentity(replacement.identity)}. Check what it does,
              then activate it by typing its slug.
            </span>
          </p>
        </div>
      )}
      {backChanged && (
        <div className="mt-3 rounded-lg border-l-4 border-brand-accent bg-brand-accent/10 py-2 pl-3 pr-3">
          <p className="flex items-start gap-2 text-xs text-foreground">
            <AlertCircle className="mt-0.5 h-3.5 w-3.5 shrink-0 text-primary" />
            <span>
              This app left the build and came back with different files, so
              it was switched off. Its grants and data were kept. Check what
              changed, then activate it.
            </span>
          </p>
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
        <div className="flex shrink-0 items-center gap-2">
          {/* Activate is the primary action while an app is off — it is the
              one thing standing between the app and being usable. Once it is
              on, Details takes the fill back and turning it off becomes the
              quiet action, which is the right weight for something that
              removes an app from everyone at once. */}
          <Button
            variant={isActive ? "ghost" : "primary"}
            size="sm"
            disabled={pending || blockActivate}
            onClick={toggleActive}
            aria-label={`${isActive ? "Deactivate" : "Activate"} ${app.name}`}
            title={
              blockActivate
                ? `Configure ${missingConnectors
                    .map((m) => m.displayName)
                    .join(", ")} first`
                : undefined
            }
          >
            {pending ? "Saving…" : isActive ? "Deactivate" : "Activate"}
          </Button>
          <Button
            variant={isActive ? "primary" : "ghost"}
            size="sm"
            onClick={() => setDetailsOpen(true)}
            // The tile names the app above this control, but a screen reader
            // moving button to button does not carry that with it: a registry of
            // forty apps otherwise announces forty buttons called "Details".
            aria-label={`Details for ${app.name}`}
          >
            Details
          </Button>
        </div>
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

      {confirming && replacement && (
        <TypedConfirmDialog
          onClose={() => setConfirming(false)}
          title={`Activate ${app.name}?`}
          word={app.slug}
          confirmLabel="Activate"
          busyLabel="Activating…"
          busy={pending}
          error={confirmError}
          onConfirm={activateReplaced}
        >
          <p className="text-muted-foreground">
            A different extension had the slug{" "}
            <code className="font-mono text-foreground">{app.slug}</code>{" "}
            before this one.
          </p>
          <dl className="space-y-1">
            <div className="flex flex-wrap gap-x-2">
              <dt className="text-muted-foreground">Before</dt>
              <dd className="text-foreground">
                {describeIdentity(replacement.previous)}
              </dd>
            </div>
            <div className="flex flex-wrap gap-x-2">
              <dt className="text-muted-foreground">Now</dt>
              <dd className="text-foreground">
                {describeIdentity(replacement.identity)}
              </dd>
            </div>
          </dl>
          <p className="text-muted-foreground">
            Activating it gives it the grants, settings and data kept under
            this slug. The API keys made for the one before were revoked.
          </p>
        </TypedConfirmDialog>
      )}
    </div>
  );
}
