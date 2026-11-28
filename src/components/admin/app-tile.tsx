/* This Source Code Form is subject to the terms of the Mozilla Public
 * License, v. 2.0. If a copy of the MPL was not distributed with this
 * file, You can obtain one at https://mozilla.org/MPL/2.0/. */

"use client";

import { useState, useTransition } from "react";
import { AlertCircle } from "lucide-react";
import type { AppManifest } from "@/lib/apps/types";
import type { AppReplacement, NeedsGrants } from "@/lib/apps/access";
import type { AppTrust } from "@/lib/apps/app-review";
import { describeAnomaly, type Anomaly } from "@/lib/apps/anomaly";
import { acknowledgeAnomaliesAction } from "@/lib/apps/admin-actions";
import { InfoTooltip } from "@/components/ui/info-tooltip";
import AppReviewDialog from "./app-review-dialog";
import LucideIcon from "@/components/lucide-icon";
import { Button } from "@/components/ui/button";
import { StatusPill } from "@/components/ui/status";
import { setAppActiveAction } from "@/lib/apps/admin-actions";
import { describeIdentity } from "@/lib/repository/identity";
import { CARD_SHELL } from "@/components/ui/card";
import { cn } from "@/lib/utils";
import {
  formatCount,
  truncateWords,
  TILE_DESCRIPTION_WORDS,
} from "@/lib/apps/display";
import AppDetailsDialog, {
  MissingConnectorWarning,
} from "./app-details-dialog";
import { TileFooter } from "./provenance";
import TypedConfirmDialog from "./typed-confirm-dialog";
import {
  missingConnectorSteps,
  type MissingConnector,
} from "@/lib/apps/connector-readiness";

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
   * Set when the release step found that people who had this app lost it:
   * since when, and why. Cleared when an admin grants it to someone.
   */
  needsGrants: NeedsGrants | null;
  /**
   * Set when the release step found this app under a slug a different
   * extension had, switched it off, revoked its API keys and turned its MCP
   * tools off. Activating needs the slug typed, and clears it.
   */
  replacement: AppReplacement | null;
  /**
   * For an app installed from a Registry: where from, and whether an admin
   * here reviewed the code it runs (lib/apps/app-review.ts). Null for a local
   * app, which shows nothing new.
   */
  trust?: AppTrust | null;
  /**
   * What detection raised about this app that nobody has marked as expected
   * (lib/apps/detection.ts). Shown as a strip with Deactivate and Mark as
   * expected; never acted on by itself.
   */
  anomalies?: Anomaly[];
  /**
   * Opens the Remove dialog, which says what goes and what stays before it
   * removes anything. Offered from the Details dialog's footer, not the tile.
   */
  onRemove: () => void;
}

/**
 * One app in the registry grid.
 *
 * This was a full-width row in a divided list, which made apps the odd
 * abstraction out: connectors and themes were already tiles, so an admin moving
 * between the three registries met three different objects. The shell here is
 * the connector tile's, to the class — same `mix-card` rounded-lg border, same
 * padding, same icon plate, same action row, same provenance band (./provenance.tsx).
 *
 * WHAT DID NOT COME ACROSS IS THE TINT. The connector tile washes its card in a
 * status colour because configuration is the whole point of that grid. An app
 * has no such state — every app in this list is in the registry, and being in
 * the registry is the whole of being valid — so tinting each card would invent
 * a status to report. Colour stays reserved for the things on this page that
 * genuinely need an admin: the unconfigured-connector strip, and the strip on
 * an app that came back into the build with different code, that replaces a
 * different extension under its slug, or that stopped being global.
 */
export default function AppTile({
  app,
  missingConnectors,
  grantCount,
  tableCount,
  isActive,
  returnedChangedAt,
  needsGrants: lostBy,
  replacement,
  trust = null,
  anomalies = [],
  onRemove,
}: AppTileProps) {
  const [acknowledging, startAcknowledge] = useTransition();
  /** Deactivate from the strip asks once before it switches everything off. */
  const [confirmingStop, setConfirmingStop] = useState(false);
  const unusual = anomalies.length > 0;
  const [detailsOpen, setDetailsOpen] = useState(false);
  const [reviewOpen, setReviewOpen] = useState(false);
  /** A Registry app nobody here has reviewed the code of: Review comes before Activate. */
  const needsReview = trust !== null && !trust.reviewed;
  const [pending, startTransition] = useTransition();
  /** Activate's typed confirmation, for an app that replaces a different extension. */
  const [confirming, setConfirming] = useState(false);
  const [confirmError, setConfirmError] = useState<string | null>(null);
  /*
    The count the Access tab read after a grant or a revoke, so the pill below
    agrees with the list at once. Kept with the count it replaced: once the
    page's own refresh brings a new one, that wins.
  */
  const [liveGrants, setLiveGrants] = useState<{ from: number; count: number } | null>(null);
  const grants = liveGrants && liveGrants.from === grantCount ? liveGrants.count : grantCount;

  // One message at a time. An app that came back as a different extension
  // usually came back with different code too, and the replacement is what
  // the admin has to answer: it asks more of them.
  const replaced = replacement !== null;
  const backChanged = returnedChangedAt !== null && !replaced;
  // People who had it have lost it, until an admin grants it to them.
  const needsGrants = lostBy !== null && !app.global;

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
    A connector that isn't ready is a warning here, not a gate. What it blocks
    is GRANTING the app to someone, which the shared grant action enforces for the
    Access tab and /admin/users alike, so this strip says what is wrong and
    where the consequence lands, and stops there.
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
  else if (grants > 0) pills.push(formatCount(grants, "granted user"));
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
      {(pills.length > 0 || !isActive || backChanged || replaced || needsGrants || trust || unusual) && (
        <div className="mt-3 flex flex-wrap items-center gap-1.5">
          {/* The pills here that are states rather than measurements, so the
              ones that get a tone. Nothing marks an active app: active is
              what every app in a working instance is, and a green pill on
              every tile would be a row of decoration. */}
          {unusual && <StatusPill tone="danger">Unusual activity</StatusPill>}
          {!isActive && <StatusPill tone="warning">Inactive</StatusPill>}
          {trust && (
            <InfoTooltip
              tip={`Installed from ${trust.provenance}${trust.modified ? ", and modified locally since" : ""}. Someone else's code, so it runs only once an admin here has reviewed it.`}
            >
              <StatusPill tone="neutral">Third-party</StatusPill>
            </InfoTooltip>
          )}
          {needsReview && (
            <StatusPill tone="warning">{trust!.previouslyReviewed ? "Updated, needs review" : "Unreviewed"}</StatusPill>
          )}
          {replaced && (
            <StatusPill tone="warning">Replaces a different extension</StatusPill>
          )}
          {backChanged && (
            <StatusPill tone="warning">Back with different code</StatusPill>
          )}
          {needsGrants && <StatusPill tone="warning">Needs grants</StatusPill>}
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
            isActive={isActive}
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
              switched off, its API keys were revoked and its MCP tools were
              turned off. Its grants, settings and data were kept. Before:{" "}
              {describeIdentity(replacement.previous)}. Now:{" "}
              {describeIdentity(replacement.identity)}. Check what it does,
              then activate it by typing its slug.
            </span>
          </p>
        </div>
      )}
      {/* What detection saw, first: it is the one strip that may mean the app
          is doing something it shouldn't. Nothing here acts by itself. */}
      {unusual && (
        <div className="mt-3 rounded-lg border-l-4 border-destructive bg-destructive/10 py-2 pl-3 pr-3">
          <div className="flex items-start gap-2 text-xs text-foreground">
            <AlertCircle className="mt-0.5 h-3.5 w-3.5 shrink-0 text-destructive" />
            <div className="min-w-0 space-y-1">
              <ul className="space-y-0.5">
                {anomalies.slice(0, 3).map((a) => (
                  <li key={a.id}>{describeAnomaly(a)}</li>
                ))}
              </ul>
              {anomalies.length > 3 && <p>And {anomalies.length - 3} more.</p>}
              <div className="flex flex-wrap items-center gap-2 pt-1">
                {isActive &&
                  (confirmingStop ? (
                    <>
                      <Button
                        variant="destructive"
                        size="sm"
                        busy={pending}
                        busyLabel="Deactivating…"
                        onClick={() =>
                          startTransition(async () => {
                            await setAppActiveAction(app.slug, false);
                            setConfirmingStop(false);
                          })
                        }
                      >
                        Deactivate for everyone
                      </Button>
                      <Button variant="ghost" size="sm" onClick={() => setConfirmingStop(false)}>
                        Keep it on
                      </Button>
                    </>
                  ) : (
                    <Button variant="secondary" size="sm" onClick={() => setConfirmingStop(true)}>
                      Deactivate
                    </Button>
                  ))}
                <Button
                  variant="ghost"
                  size="sm"
                  busy={acknowledging}
                  busyLabel="Marking…"
                  onClick={() =>
                    startAcknowledge(async () => {
                      await acknowledgeAnomaliesAction(app.slug, anomalies.slice(0, 3).map((a) => a.id));
                    })
                  }
                >
                  Mark as expected
                </Button>
              </div>
            </div>
          </div>
        </div>
      )}
      {needsReview && (
        <div className="mt-3 rounded-lg border-l-4 border-brand-accent bg-brand-accent/10 py-2 pl-3 pr-3">
          <p className="flex items-start gap-2 text-xs text-foreground">
            <AlertCircle className="mt-0.5 h-3.5 w-3.5 shrink-0 text-primary" />
            <span>
              From {trust!.provenance}
              {trust!.modified ? ", modified locally" : ""}.{" "}
              {trust!.previouslyReviewed
                ? "Its code changed since an admin here reviewed it"
                : "Nobody here has reviewed its code yet"}
              {trust!.reviewNeededSince ? ", so it was switched off" : ""}. Review what it can do, then activate it.
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
      {needsGrants && (
        <div className="mt-3 rounded-lg border-l-4 border-brand-accent bg-brand-accent/10 py-2 pl-3 pr-3">
          <p className="flex items-start gap-2 text-xs text-foreground">
            <AlertCircle className="mt-0.5 h-3.5 w-3.5 shrink-0 text-primary" />
            <span>
              This app isn&apos;t global any more, so only the people granted
              it have it. People who had it without a grant don&apos;t now;
              their roles were kept, and give no access. Grant it from its
              Access tab, under Details.
            </span>
          </p>
        </div>
      )}

      {/* mt-auto pins the actions and the provenance band to the bottom, so
          tiles of differing height still line their buttons up across the
          row. The app's path is in the Details dialog's footer, where someone
          about to go and edit it is looking; on the tile it was a third thing
          to read before the buttons. */}
      <div className="mt-auto flex items-center justify-end gap-3 pt-4">
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
          {/* Review takes Activate's place, and its weight, while a Registry
              app's code is unreviewed: activating is refused until then. */}
          {needsReview && !isActive ? (
            <Button
              variant="primary"
              size="sm"
              onClick={() => setReviewOpen(true)}
              aria-label={`Review ${app.name}`}
            >
              Review
            </Button>
          ) : (
            <Button
              variant={isActive ? "ghost" : "primary"}
              size="sm"
              disabled={pending || blockActivate}
              onClick={toggleActive}
              aria-label={`${isActive ? "Deactivate" : "Activate"} ${app.name}`}
              title={
                blockActivate
                  ? `${missingConnectorSteps(missingConnectors)} first`
                  : undefined
              }
            >
              {pending ? "Saving…" : isActive ? "Deactivate" : "Activate"}
            </Button>
          )}
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

      {/* The Details dialog's footer band, in the same words: an admin reads
          when it changed and who changed it the same way on the tile and in
          the dialog, and the same on the connector and theme tiles. */}
      {trust && (
        <AppReviewDialog app={app} trust={trust} open={reviewOpen} onClose={() => setReviewOpen(false)} />
      )}
      <TileFooter lastUpdated={app.lastUpdated} authors={app.authors} />

      <AppDetailsDialog
        app={app}
        trust={trust}
        missingConnectors={missingConnectors}
        isActive={isActive}
        grantCount={grants}
        onGrantCount={(count) => setLiveGrants({ from: grantCount, count })}
        open={detailsOpen}
        onClose={() => setDetailsOpen(false)}
        // The Remove dialog replaces this one rather than stacking on it: two
        // focus traps at once, and the details of an app that is going.
        onRemove={() => {
          setDetailsOpen(false);
          onRemove();
        }}
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
            this slug. The API keys made for the one before were revoked, and
            its MCP tools are off until you turn each one on.
          </p>
        </TypedConfirmDialog>
      )}
    </div>
  );
}
