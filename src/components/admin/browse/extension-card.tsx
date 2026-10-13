/* This Source Code Form is subject to the terms of the Mozilla Public
 * License, v. 2.0. If a copy of the MPL was not distributed with this
 * file, You can obtain one at https://mozilla.org/MPL/2.0/. */

"use client";

import { CheckCircle2, ExternalLink, PencilLine, ShieldCheck } from "lucide-react";
import { Badge } from "@/components/ui/badge";
import { Button } from "@/components/ui/button";
import { CARD_SHELL } from "@/components/ui/card";
import { cn } from "@/lib/utils";
import {
  formatCount,
  truncateWords,
  TILE_DESCRIPTION_WORDS,
} from "@/lib/apps/display";
import {
  provenanceDetail,
  provenanceLine,
  type Provenance,
} from "@/lib/repository/provenance";
import { KIND_SEGMENT, type ExtensionSummary } from "@/lib/repository/types";

/**
 * One catalogue listing, in the same tile shape as the registry grids next
 * door.
 *
 * WHY IT MATCHES THE REGISTRY TILE. This grid and `/admin/apps` are the same
 * question asked twice — "what is there, and what does it do" — separated only
 * by whether the answer is already on this instance. Giving the browse results
 * their own card language would make an admin re-learn the layout to cross a
 * button.
 *
 * WHAT IT DOES NOT BORROW is the status colouring. A listing has no state on
 * this instance, and every fact on this card comes from a service that is not
 * this one — so nothing here is tinted as though the instance had verified it.
 * `verified` is rendered as what mixos.org says it is: a claim about the
 * PUBLISHER, not an audit of the code.
 *
 * ── IT IS BUILT FROM A SUMMARY, WHICH BOUNDS WHAT IT CAN SAY ────────────────
 *
 * `/api/v1/search` returns `ExtensionSummary`: no `sourceRepo`, no `releases`.
 * So the version comes from `latestVersion`, the link goes to the listing on
 * the repository rather than to GitHub, and the card cannot know whether the
 * current release has been yanked. None of that is worth a second request per
 * tile — those facts are stated in the register dialog, which fetches the full
 * record precisely because that is the screen where they matter.
 *
 * ── AN INSTALLED ONE SAYS WHERE IT CAME FROM ────────────────────────────────
 *
 * A name already in this build gets a line instead of a button, from its
 * install record (src/lib/repository/provenance.ts): installed from this
 * catalogue at a version, perhaps modified locally since; installed from
 * another catalogue; or a local extension that only shares the name. Matching
 * the name alone, as this did, called all three "Installed".
 *
 * One installed from this catalogue can be updated from here: Update opens
 * the update dialog in a checkout ("Change release" when the catalogue's
 * current release is the one in place), and on a built deployment the card
 * links to how updating works. An update already waiting in pending offers its
 * review instead.
 */
export default function ExtensionCard({
  extension,
  repositoryOrigin,
  installed,
  pendingSlugs,
  onInstall,
  onReview,
  onUpdate,
  updateHelpUrl = null,
}: {
  extension: ExtensionSummary;
  /** Origin of the repository being browsed, for the listing link. */
  repositoryOrigin: string;
  /** Where the extension of this name in this build came from, or null when there is none. */
  installed: Provenance | null;
  /** Identifiers waiting in `.mixos/pending/` to be registered. */
  pendingSlugs: ReadonlySet<string>;
  onInstall: (extension: ExtensionSummary) => void;
  /** Open the review of a pending install, which leads to Register. */
  onReview: (extension: ExtensionSummary) => void;
  /** Open the update dialog, for one installed from this catalogue. Absent where this deployment can't install. */
  onUpdate?: (extension: ExtensionSummary) => void;
  /** Where a built deployment reads how updating works, in place of the button. */
  updateHelpUrl?: string | null;
}) {
  const pending = !installed && pendingSlugs.has(extension.slug);
  const fromHere = installed?.from === "catalogue" ? installed : null;
  const updatePending = fromHere !== null && pendingSlugs.has(extension.slug);
  const newer = fromHere !== null && (fromHere.modified || (extension.latestVersion ?? fromHere.version) !== fromHere.version);
  // No version means no published release: nothing to fetch and no hash to
  // verify against. Browsable, not installable, and the button says which.
  const installable = Boolean(extension.latestVersion);
  const listingUrl = `${repositoryOrigin}/extend/${KIND_SEGMENT[extension.kind]}/${extension.slug}`;

  return (
    <div className={cn(CARD_SHELL, "flex h-full flex-col p-5")}>
      <div className="flex items-start gap-3">
        <div className="min-w-0 flex-1">
          <div className="flex flex-wrap items-center gap-2">
            <h3 className="truncate text-base font-semibold text-foreground">
              {extension.name}
            </h3>
            {extension.author.verified && (
              <span
                className="inline-flex items-center gap-1 text-xs text-muted-foreground"
                title="mixos.org has verified this publisher's identity. It is not an audit of the code."
              >
                <ShieldCheck className="h-3.5 w-3.5" aria-hidden />
                Verified publisher
              </span>
            )}
          </div>
          <p className="mt-0.5 truncate text-xs text-muted-foreground">
            {extension.slug} · {extension.author.handle}
          </p>
        </div>
      </div>

      <p className="mt-3 text-sm text-muted-foreground">
        {truncateWords(extension.tagline, TILE_DESCRIPTION_WORDS)}
      </p>

      <div className="mt-3 flex flex-wrap gap-1.5">
        {extension.latestVersion && (
          <Badge tone="neutral">v{extension.latestVersion}</Badge>
        )}
        {extension.license && <Badge tone="neutral">{extension.license}</Badge>}
        {extension.installCount > 0 && (
          <Badge tone="neutral">
            {formatCount(extension.installCount, "install")}
          </Badge>
        )}
      </div>

      {/* Pushed to the floor so tiles in a row align on their action bar even
          when their taglines run to different lengths. */}
      <div className="mt-auto flex flex-wrap items-center gap-x-3 gap-y-2 pt-4">
        {/*
          One button. Installing an app or a connector puts it in
          `.mixos/pending/`, where none of its code runs; registering it, after
          a review of what will run, is when it does; and activating an app is
          per database, after that. A button that did all three would skip the
          review, so there isn't one.
        */}
        {installed ? (
          <>
            <p
              className={cn(
                "inline-flex min-w-0 items-center gap-1.5 text-xs",
                installed.from === "catalogue" ? "text-foreground" : "text-muted-foreground",
              )}
              title={provenanceDetail(installed)}
            >
              {installed.from === "catalogue" &&
                (installed.modified ? (
                  <PencilLine className="h-3.5 w-3.5 shrink-0" aria-hidden />
                ) : (
                  <CheckCircle2 className="h-3.5 w-3.5 shrink-0" aria-hidden />
                ))}
              {provenanceLine(installed)}
            </p>
            {fromHere &&
              (updatePending ? (
                <Button variant="primary" size="sm" onClick={() => onReview(extension)}>
                  Review and register
                </Button>
              ) : onUpdate ? (
                <Button variant={newer ? "primary" : "secondary"} size="sm" onClick={() => onUpdate(extension)}>
                  {newer ? "Update" : "Change release"}
                </Button>
              ) : updateHelpUrl ? (
                <a
                  href={updateHelpUrl}
                  target="_blank"
                  rel="noreferrer noopener"
                  className="inline-flex items-center gap-1 text-xs text-muted-foreground underline underline-offset-2 hover:text-foreground"
                >
                  How to update
                  <ExternalLink className="h-3 w-3" aria-hidden />
                  <span className="sr-only"> (opens in a new tab)</span>
                </a>
              ) : null)}
          </>
        ) : pending ? (
          <Button variant="primary" size="sm" onClick={() => onReview(extension)}>
            Review and register
          </Button>
        ) : (
          <Button
            variant="primary"
            size="sm"
            disabled={!installable}
            onClick={() => onInstall(extension)}
          >
            {installable ? "Install" : "No release"}
          </Button>
        )}
        <a
          href={listingUrl}
          target="_blank"
          rel="noreferrer noopener"
          className="inline-flex items-center gap-1 text-xs text-muted-foreground underline underline-offset-2 hover:text-foreground"
        >
          View listing
          <ExternalLink className="h-3 w-3" aria-hidden />
        </a>
      </div>
    </div>
  );
}
