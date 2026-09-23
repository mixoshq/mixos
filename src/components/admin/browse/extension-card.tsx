/* This Source Code Form is subject to the terms of the Mozilla Public
 * License, v. 2.0. If a copy of the MPL was not distributed with this
 * file, You can obtain one at https://mozilla.org/MPL/2.0/. */

"use client";

import { useState } from "react";
import { ChevronDown, ExternalLink, ShieldCheck } from "lucide-react";
import { Badge } from "@/components/ui/badge";
import { Button } from "@/components/ui/button";
import { CARD_SHELL } from "@/components/ui/card";
import { cn } from "@/lib/utils";
import {
  formatCount,
  truncateWords,
  TILE_DESCRIPTION_WORDS,
} from "@/lib/apps/display";
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
 */
export default function ExtensionCard({
  extension,
  repositoryOrigin,
  installedSlugs,
  onInstall,
}: {
  extension: ExtensionSummary;
  /** Origin of the repository being browsed, for the listing link. */
  repositoryOrigin: string;
  /** Identifiers already present on this instance, for the "Installed" state. */
  installedSlugs: ReadonlySet<string>;
  /** `activate` is only ever true for apps; see the action bar below. */
  onInstall: (extension: ExtensionSummary, activate: boolean) => void;
}) {
  const installed = installedSlugs.has(extension.slug);
  // No version means no published release: nothing to fetch and no hash to
  // verify against. Browsable, not installable, and the button says which.
  const installable = Boolean(extension.latestVersion);
  const canActivate = extension.kind === "app" && !installed && installable;
  const [menuOpen, setMenuOpen] = useState(false);
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
      <div className="mt-auto flex items-center gap-2 pt-4">
        {/*
          A split button, and only for apps. Installing copies the code in;
          activating is what makes it serve anything, and the two are separate
          decisions on purpose — an admin reviewing third-party code wants the
          files before the routes. The common case is still one click, so the
          fast path keeps the fill and the second step lives under the chevron.

          Connectors and themes have no such switch: a connector does nothing
          until an admin configures it, and a theme does nothing until someone
          applies it, so both already have the gate this would duplicate.
        */}
        <div className="flex items-center">
          <Button
            variant="primary"
            size="sm"
            disabled={installed || !installable}
            className={canActivate ? "rounded-r-none" : undefined}
            onClick={() => onInstall(extension, false)}
          >
            {installed ? "Installed" : installable ? "Install" : "No release"}
          </Button>
          {canActivate && (
            <div className="relative">
              <Button
                variant="primary"
                size="sm"
                aria-label={`More install options for ${extension.name}`}
                aria-expanded={menuOpen}
                aria-haspopup="menu"
                className="rounded-l-none border-l border-brand-foreground/25 px-2"
                onClick={() => setMenuOpen((v) => !v)}
              >
                <ChevronDown className="h-4 w-4" aria-hidden />
              </Button>
              {menuOpen && (
                <>
                  {/* Click-away as a sibling rather than a document listener:
                      it cannot leak past unmount, and it swallows the click
                      that dismisses it. */}
                  <div
                    className="fixed inset-0 z-40"
                    onClick={() => setMenuOpen(false)}
                  />
                  <div
                    role="menu"
                    className={cn(
                      "mix-popover",
                      CARD_SHELL,
                      "absolute right-0 top-full z-50 mt-1 w-56 py-1 shadow-lg",
                    )}
                  >
                    <button
                      role="menuitem"
                      className="w-full px-3 py-2 text-left text-sm hover:bg-accent"
                      onClick={() => {
                        setMenuOpen(false);
                        onInstall(extension, true);
                      }}
                    >
                      Install &amp; Activate
                    </button>
                  </div>
                </>
              )}
            </div>
          )}
        </div>
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
