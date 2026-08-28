/* This Source Code Form is subject to the terms of the Mozilla Public
 * License, v. 2.0. If a copy of the MPL was not distributed with this
 * file, You can obtain one at https://mozilla.org/MPL/2.0/. */

"use client";

import { useState, useTransition } from "react";
import { Check } from "lucide-react";
import { Card, CardBody, CardHeader } from "@/components/ui/card";
import { Button } from "@/components/ui/button";
import { Badge } from "@/components/ui/badge";
import type { ThemeManifest } from "@/lib/themes/types";

/**
 * The theme picker. There is deliberately no light/dark control beside it.
 *
 * This used to be two axes — pick a theme, then pick light/dark/system — and a
 * theme could answer the colour question twice. Now a theme IS the answer: one
 * palette, and a dark look ships as its own selectable theme. What was a mode
 * toggle is now just another card in this grid.
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
  const [slug, setSlug] = useState(activeSlug);

  const dirty = slug !== activeSlug;

  function apply() {
    startTransition(async () => {
      await action(slug);
    });
  }

  return (
    <div className="space-y-4">
      <Card>
        <CardHeader title="Appearance" />
        <CardBody divided>
          <p className="text-sm text-muted-foreground">
            One theme is active for everyone. It paints the sign-in page and
            public app links as well as every signed-in page, so there is no
            per-person setting to fall back on.
          </p>

          <div className="mt-4 grid gap-3 sm:grid-cols-2 lg:grid-cols-3">
            {themes.map((theme) => {
              const selected = theme.slug === slug;
              return (
                <button
                  key={theme.slug}
                  type="button"
                  aria-pressed={selected}
                  onClick={() => setSlug(theme.slug)}
                  className={`rounded-lg border p-3 text-left transition-colors ${
                    selected
                      ? "border-primary ring-2 ring-ring"
                      : "border-border hover:bg-accent hover:text-accent-foreground"
                  }`}
                >
                  <span className="flex items-center gap-2">
                    <span className="font-medium text-foreground">{theme.name}</span>
                    {theme.slug === activeSlug && (
                      <Badge tone="success">
                        <Check className="h-3 w-3" aria-hidden /> Active
                      </Badge>
                    )}
                  </span>

                  {/* The palette, not a screenshot: a swatch row is honest about
                      what will actually change, and never goes stale the way a
                      captured image does. */}
                  <span className="mt-2 flex h-6 overflow-hidden rounded">
                    {theme.swatches.map((sw) => (
                      <span
                        key={sw.token}
                        title={`--${sw.token}: ${sw.value}`}
                        className="flex-1 border-r border-border last:border-r-0"
                        style={{ backgroundColor: sw.value }}
                      />
                    ))}
                  </span>

                  <span className="mt-2 block text-xs text-muted-foreground">
                    {theme.description}
                  </span>
                  {theme.fonts.length > 0 && (
                    <span className="mt-1 block text-xs text-muted-foreground">
                      {[...new Set(theme.fonts.map((f) => f.family))].join(", ")}
                    </span>
                  )}
                </button>
              );
            })}
          </div>
        </CardBody>
      </Card>

      <div className="flex items-center gap-3">
        <Button
          variant="primary"
          onClick={apply}
          disabled={!dirty}
          busy={pending}
          busyLabel="Applying…"
        >
          Apply to everyone
        </Button>
        {dirty && (
          <span className="text-sm text-muted-foreground">
            Not applied yet — this changes what every user sees.
          </span>
        )}
      </div>
    </div>
  );
}
