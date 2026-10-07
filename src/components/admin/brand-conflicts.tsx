/* This Source Code Form is subject to the terms of the Mozilla Public
 * License, v. 2.0. If a copy of the MPL was not distributed with this
 * file, You can obtain one at https://mozilla.org/MPL/2.0/. */

import type { AppManifest } from "@/lib/apps/types";
import type { BrandHook } from "@/lib/branding/types";
import { BRAND_HOOKS } from "@/lib/branding/types";
import type { ThemeBranding } from "@/lib/themes/types";

const SLOT: Record<BrandHook, { label: string; claim: keyof ThemeBranding }> = {
  "brand-name": { label: "The install's name", claim: "name" },
  "menu-bar-logo": { label: "The menu-bar logo", claim: "menuBarLogo" },
  "login-logo": { label: "The sign-in logo", claim: "loginLogo" },
};

/**
 * Brand slots that more than one active app filters.
 *
 * Their filters chain in a fixed order (priority, then slug), so the result is
 * stable — but the order comes from code an admin cannot see, so "which app's
 * name is showing" would otherwise be a question with no visible answer. A
 * slot the active theme claims is left out: no app filter runs for it.
 */
export default function BrandConflicts({
  apps,
  activeBySlug,
  themeBranding,
}: {
  apps: AppManifest[];
  activeBySlug: Record<string, boolean>;
  themeBranding: ThemeBranding;
}) {
  const conflicts = BRAND_HOOKS.flatMap((hook) => {
    if (themeBranding[SLOT[hook].claim] !== null) return [];
    const names = apps
      .filter((a) => activeBySlug[a.slug] && a.branding?.hooks.includes(hook))
      .map((a) => a.name);
    return names.length > 1 ? [{ hook, names }] : [];
  });
  if (conflicts.length === 0) return null;

  return (
    <div className="mb-6 rounded-lg border-l-4 border-brand-accent bg-muted/50 px-4 py-3 text-sm text-foreground">
      <p className="font-medium">More than one active app changes the branding</p>
      <ul className="mt-1 list-disc space-y-0.5 pl-5">
        {conflicts.map(({ hook, names }) => (
          <li key={hook}>
            {SLOT[hook].label}: {names.join(", ")}.
          </li>
        ))}
      </ul>
      <p className="mt-1">
        They run in a fixed order and the last one&apos;s value is shown.
        Deactivate the ones you don&apos;t want, or claim the slot in the
        active theme&apos;s <code className="font-mono text-xs">branding</code>.
      </p>
    </div>
  );
}
