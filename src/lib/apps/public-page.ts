/* This Source Code Form is subject to the terms of the Mozilla Public
 * License, v. 2.0. If a copy of the MPL was not distributed with this
 * file, You can obtain one at https://mozilla.org/MPL/2.0/. */

import type { AppGate } from "./app-gate";
import { publicGateFor, type AppManifest } from "./types";

export type PublicPageAccess =
  | { kind: "not-served" }
  | { kind: "open" | "password" | "updating"; manifest: AppManifest };

/**
 * What `/p/<appSlug>/<pageKey>` may serve, before any unlock cookie is read:
 * nothing, the page, the page behind the app's password, or "This app is being
 * updated" in its place.
 *
 * `/p` pages are not served by the API dispatcher, so they do not pass through
 * `resolveAuthTier`. This applies its rule to them: a deactivated app serves
 * nothing at any tier, and is indistinguishable from an app that was never
 * installed. A page the manifest does not open to `public` or `password` is
 * not served either, so a missing or mistyped `pageVisibility` entry fails
 * closed.
 *
 * Activation is the app gate's first question (`./app-gate.ts`), so it is
 * asked here through the gate, whose second is whether the app's own
 * migrations are behind. A page this would otherwise serve is then `updating`,
 * password or not: the form would only lead to the same answer.
 *
 * Its dependencies are parameters so the rule can be tested without a request
 * or a database. Visibility is checked first because it costs nothing.
 */
export async function publicPageAccess(
  appSlug: string,
  pageKey: string,
  apps: readonly AppManifest[],
  appGate: (slug: string) => Promise<AppGate>,
): Promise<PublicPageAccess> {
  const manifest = apps.find((a) => a.slug === appSlug);
  if (!manifest) return { kind: "not-served" };

  // "key" is an API-only auth; the manifest schema rejects it on a page, so
  // reaching it here would mean a registry built from a stale schema.
  const gate = publicGateFor(manifest.pageVisibility?.[pageKey]);
  if (gate === "none" || gate === "key") return { kind: "not-served" };

  const verdict = await appGate(appSlug);
  if (!verdict.open) {
    return verdict.reason === "updating" ? { kind: "updating", manifest } : { kind: "not-served" };
  }

  return { kind: gate, manifest };
}
