/* This Source Code Form is subject to the terms of the Mozilla Public
 * License, v. 2.0. If a copy of the MPL was not distributed with this
 * file, You can obtain one at https://mozilla.org/MPL/2.0/. */

import { publicGateFor, type AppManifest } from "./types";

export type PublicPageAccess =
  | { kind: "not-served" }
  | { kind: "open" | "password"; manifest: AppManifest };

/**
 * What `/p/<appSlug>/<pageKey>` may serve, before any unlock cookie is read:
 * nothing, the page, or the page behind the app's password.
 *
 * `/p` pages are not served by the API dispatcher, so they do not pass through
 * `resolveAuthTier`. This applies its rule to them: a deactivated app serves
 * nothing at any tier, and is indistinguishable from an app that was never
 * installed. A page the manifest does not open to `public` or `password` is
 * not served either, so a missing or mistyped `pageVisibility` entry fails
 * closed.
 *
 * Its dependencies are parameters so the rule can be tested without a request
 * or a database. Visibility is checked first because it costs nothing.
 */
export async function publicPageAccess(
  appSlug: string,
  pageKey: string,
  apps: readonly AppManifest[],
  isAppActive: (slug: string) => Promise<boolean>,
): Promise<PublicPageAccess> {
  const manifest = apps.find((a) => a.slug === appSlug);
  if (!manifest) return { kind: "not-served" };

  // "key" is an API-only auth; the manifest schema rejects it on a page, so
  // reaching it here would mean a registry built from a stale schema.
  const gate = publicGateFor(manifest.pageVisibility?.[pageKey]);
  if (gate === "none" || gate === "key") return { kind: "not-served" };

  if (!(await isAppActive(appSlug))) return { kind: "not-served" };

  return { kind: gate, manifest };
}
