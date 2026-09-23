/* This Source Code Form is subject to the terms of the Mozilla Public
 * License, v. 2.0. If a copy of the MPL was not distributed with this
 * file, You can obtain one at https://mozilla.org/MPL/2.0/. */

"use client";

import { useState, useTransition } from "react";
import { Check } from "lucide-react";
import { Button } from "@/components/ui/button";
import { Dialog } from "@/components/ui/dialog";
import { useToast } from "@/components/ui/toast";
import { renderAuthors, formatLastUpdated } from "@/lib/apps/display";
import type { ThemeManifest } from "@/lib/themes/types";
import { CARD_SHELL } from "@/components/ui/card";
import { cn } from "@/lib/utils";

/**
 * The theme picker. There is deliberately no light/dark control beside it.
 *
 * This used to be two axes — pick a theme, then pick light/dark/system — and a
 * theme could answer the colour question twice. Now a theme IS the answer: one
 * palette, and a dark look ships as its own selectable theme. What was a mode
 * toggle is now just another tile in this grid.
 *
 * There is no staged selection. It used to take two steps — click a tile to
 * select, then press one "Apply to everyone" button below the grid — which
 * meant the page could sit in a state where the ringed tile was not the live
 * theme, and nothing on the tile itself said which was which. Now each tile
 * owns its own Apply, and the confirmation that used to be the second step is
 * the modal.
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
}: {
  themes: ThemeManifest[];
  activeSlug: string;
  action: (slug: string) => Promise<void>;
}) {
  const [pending, startTransition] = useTransition();
  /** The theme awaiting confirmation, or null when the dialog is closed. */
  const [confirming, setConfirming] = useState<ThemeManifest | null>(null);
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
      <div className="grid gap-4 sm:grid-cols-2 lg:grid-cols-3">
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

              {/* The palette, not a screenshot: a swatch row is honest about
                  what will actually change, and never goes stale the way a
                  captured image does. */}
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

              {/* mt-auto, so the action and the provenance row sit on the
                  tile's floor and line up across a row whose descriptions
                  differ in length. */}
              <div className="mt-auto flex items-center justify-between gap-3 pt-4">
                {/* Where this theme's source lives — the same third
                    provenance fact the app details dialog puts beside its
                    footer, in the same mono treatment: the row below says
                    when it changed and who changed it, this says where to go
                    to change it yourself. */}
                <code className="min-w-0 truncate font-mono text-xs text-muted-foreground">
                  /themes/{theme.slug}/
                </code>
                {active ? (
                  // Not a disabled Apply button: there is no action here to be
                  // temporarily unavailable, so this is a status, and rendering
                  // it as a greyed control would invite clicks that can never
                  // do anything. It is also the ONLY place the tile says it is
                  // live — the badge this replaced said the same thing twice.
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

              <div className="mt-3 flex items-baseline justify-between gap-3 border-t border-border pt-3 text-[10px] leading-none text-muted-foreground">
                <p className="min-w-0 truncate">
                  {theme.authors.length > 0 && (
                    <>
                      <strong className="font-semibold">Authored By</strong>{" "}
                      {renderAuthors(theme.authors)}
                    </>
                  )}
                </p>
                <p className="shrink-0">
                  <strong className="font-semibold">Updated</strong>{" "}
                  {/* Stamped by the pre-commit hook, so a theme edited but not
                      yet committed says so rather than showing a stale date. */}
                  {formatLastUpdated(theme.lastUpdated, "Not yet committed")}
                </p>
              </div>
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
    </>
  );
}
