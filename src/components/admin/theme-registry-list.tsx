/* This Source Code Form is subject to the terms of the Mozilla Public
 * License, v. 2.0. If a copy of the MPL was not distributed with this
 * file, You can obtain one at https://mozilla.org/MPL/2.0/. */

"use client";

import { useState, useTransition } from "react";
import Image from "next/image";
import { Check } from "lucide-react";
import { Button } from "@/components/ui/button";
import { Dialog } from "@/components/ui/dialog";
import { useToast } from "@/components/ui/toast";
import type { ThemeManifest } from "@/lib/themes/types";
import { CARD_SHELL } from "@/components/ui/card";
import { cn } from "@/lib/utils";
import type { ProposalTarget } from "@/lib/github/outcomes";
import { RemoveAction, TileFooter } from "./provenance";
import RemoveDialog, { type RemoveTarget } from "./remove/remove-dialog";

/**
 * The theme picker. There is deliberately no light/dark control beside it.
 *
 * A theme IS the answer to the colour question: one palette, and a dark look
 * ships as its own selectable theme, so it is another tile in this grid. A
 * light/dark/system control beside it would let the theme and the mode answer
 * that question twice.
 *
 * There is no staged selection. Each tile owns its own Apply, confirmed in a
 * modal. Selecting a tile and then applying it from a button below the grid
 * would let the page sit in a state where the ringed tile is not the live
 * theme, with nothing on the tile itself saying which is which.
 *
 * The tile shell is the connector tile's, deliberately: both take `CARD_SHELL`
 * from ui/card.tsx and the same `p-5` inset, so they cannot drift. An admin
 * moving between /admin/connectors and /admin/themes is looking at the same
 * object.
 */
export default function ThemeRegistryList({
  themes,
  activeSlug,
  action,
  proposal = null,
}: {
  themes: ThemeManifest[];
  activeSlug: string;
  action: (slug: string) => Promise<void>;
  /** On a built deployment with the GitHub App linked: where a removal can be proposed instead. */
  proposal?: ProposalTarget | null;
}) {
  const [pending, startTransition] = useTransition();
  /** The theme awaiting confirmation, or null when the dialog is closed. */
  const [confirming, setConfirming] = useState<ThemeManifest | null>(null);
  /** The theme whose Remove dialog is open, or null. */
  const [removing, setRemoving] = useState<RemoveTarget | null>(null);
  const toast = useToast();

  function confirmApply() {
    if (!confirming) return;
    const applied = confirming;
    startTransition(async () => {
      await action(applied.slug);
      setConfirming(null);
      // The repaint is the loudest feedback, but it says "something changed",
      // not "your change succeeded" — a toast names the theme that won.
      toast.show("success", `${applied.name} is now active for everyone.`);
    });
  }

  return (
    <>
      <div className="grid grid-cols-1 gap-4 sm:grid-cols-2 lg:grid-cols-3">
        {themes.map((theme) => {
          const active = theme.slug === activeSlug;
          return (
            <div
              key={theme.slug}
              className={cn(
                CARD_SHELL,
                "flex h-full flex-col p-5 transition-colors",
                active && "border-primary",
              )}
            >
              <h3 className="font-medium text-foreground">{theme.name}</h3>

              {/* `assets.preview`, when the theme ships one: for what colour
                  and type cannot show, such as a texture, a shadow treatment
                  or a border language. Cropped to one shape so a row of tiles
                  lines up, keeping the top-left corner, where a capture of
                  the UI starts. */}
              {theme.assets.preview && (
                <div className="relative mt-2 aspect-video overflow-hidden rounded border border-border bg-muted">
                  <Image
                    src={`${theme.assetBase}/${theme.assets.preview}`}
                    alt={`Preview of the ${theme.name} theme`}
                    fill
                    sizes="(min-width: 1024px) 33vw, (min-width: 640px) 50vw, 100vw"
                    className="object-cover object-left-top"
                  />
                </div>
              )}

              {/* The palette, always, and never replaced by the preview: a
                  swatch row is honest about what will actually change, and
                  never goes stale the way a captured image does. */}
              <div className="mt-2 flex h-6 overflow-hidden rounded">
                {theme.swatches.map((sw) => (
                  <span
                    key={sw.token}
                    title={`--${sw.token}: ${sw.value}`}
                    className="flex-1 border-r border-border last:border-r-0"
                    style={{ backgroundColor: sw.value }}
                  />
                ))}
              </div>

              <p className="mt-2 text-xs text-muted-foreground">
                {theme.description}
              </p>

              {/* Same argument as the swatches, for type. The family name IS
                  the specimen — set in the face it names — so the tile shows
                  the typeface rather than only asserting it. Every installed
                  theme's @font-face ships in themes.css (an @font-face cannot
                  be scoped to a [data-theme] selector), so a theme that is not
                  the active one still renders in its own families here. */}
              {theme.typefaces.length > 0 && (
                <dl className="mt-3 space-y-1">
                  {theme.typefaces.map((tf) => (
                    <div key={tf.token} className="flex items-baseline gap-2">
                      <dt className="w-12 shrink-0 text-[10px] font-semibold leading-none text-muted-foreground">
                        {tf.label}
                      </dt>
                      <dd
                        className="truncate text-sm leading-none text-foreground"
                        style={{ fontFamily: tf.stack }}
                      >
                        {tf.family}
                      </dd>
                    </div>
                  ))}
                </dl>
              )}

              {/* mt-auto, so the action and the provenance band sit on the
                  tile's floor and line up across a row whose descriptions
                  differ in length.

                  Delete starts the row, opposite Apply. A theme has no
                  details dialog to carry it in its footer, as an app's and a
                  connector's do, and the band below carries provenance alone,
                  the same on every tile. Removing the applied theme is
                  allowed, with a warning; removing the last one is refused. */}
              <div className="mt-auto flex items-center justify-between gap-3 pt-4">
                <RemoveAction
                  name={theme.name}
                  onClick={() => setRemoving({ kind: "theme", slug: theme.slug, name: theme.name })}
                />
                <div className="flex shrink-0 items-center gap-2">
                  {active ? (
                    // Not a disabled Apply button: there is no action here to be
                    // temporarily unavailable, so this is a status, and rendering
                    // it as a greyed control would invite clicks that can never
                    // do anything. It is also the ONLY place the tile says it is
                    // live, so a badge would say the same thing twice.
                    <p className="flex shrink-0 items-center gap-1.5 text-sm font-medium text-success">
                      <Check className="h-4 w-4" aria-hidden /> Activated
                    </p>
                  ) : (
                    // The connector tile's Configure button, exactly: size="sm"
                    // and the variant carrying the state — primary while there
                    // is still something to do, secondary once there isn't. A
                    // theme that is not live is the "still to do" case.
                    <Button
                      size="sm"
                      variant="primary"
                      className="shrink-0"
                      onClick={() => setConfirming(theme)}
                      disabled={pending}
                    >
                      Apply
                    </Button>
                  )}
                </div>
              </div>

              {/* The app and connector tiles' band. */}
              <TileFooter lastUpdated={theme.lastUpdated} authors={theme.authors} />
            </div>
          );
        })}
      </div>

      <Dialog
        open={confirming !== null}
        onClose={() => setConfirming(null)}
        title={confirming ? `Apply ${confirming.name}?` : ""}
        size="sm"
        footer={
          <div className="flex justify-end gap-2">
            <Button
              variant="ghost"
              onClick={() => setConfirming(null)}
              disabled={pending}
            >
              Cancel
            </Button>
            <Button
              variant="primary"
              onClick={confirmApply}
              busy={pending}
              busyLabel="Applying…"
            >
              Apply to everyone
            </Button>
          </div>
        }
      >
        <p className="text-sm text-muted-foreground">
          This changes the look for every user immediately — including the
          sign-in page and public app links. There is no per-person setting to
          fall back on.
        </p>
      </Dialog>

      {removing && <RemoveDialog target={removing} propose={proposal} onClose={() => setRemoving(null)} />}
    </>
  );
}
