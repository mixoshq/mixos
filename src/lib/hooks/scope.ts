/* This Source Code Form is subject to the terms of the Mozilla Public
 * License, v. 2.0. If a copy of the MPL was not distributed with this
 * file, You can obtain one at https://mozilla.org/MPL/2.0/. */

import { BRAND_HOOKS } from "../branding/types";
import type { HookEmit, HookListen } from "../apps/types";
import type { FilterHookMap } from "./types";

/**
 * Hook names, and who may use which.
 *
 * A core hook (the brand hooks, all filters) has a bare name and belongs to
 * the platform. Every other hook belongs to one app and lives in
 * its namespace, `<slug>:<name>`. A bare name written by an app means its own.
 *
 *   - Firing: an app fires its own hooks and core hooks, never another app's.
 *     Another app's hook is that app's event, and only it can say it happened.
 *   - Listening: its own hooks and core hooks freely; another app's only with
 *     consent on both sides, the listener's `listensTo` and the emitter's
 *     `emits[].consumers`.
 *
 * One module for the runtime (`hook-system.ts`) and the registry generator
 * (`scripts/hook-checks.ts`), so the build and the request apply the same rule.
 * Relative imports only: the generator runs under tsx, outside Next.
 */

/** All core hook names. These are never prefixed. */
export const CORE_HOOKS: ReadonlySet<string> = new Set<string>([
  ...BRAND_HOOKS,
] satisfies (keyof FilterHookMap)[]);

/**
 * The name a hook is stored under. A core name, or one that already names its
 * namespace (`other-app:thing`), is used as written; any other name is the
 * app's own and gets its slug as a prefix.
 */
export function qualifyHookName(name: string, appSlug: string): string {
  if (CORE_HOOKS.has(name) || name.includes(":")) return name;
  return `${appSlug}:${name}`;
}

/**
 * The app whose namespace a stored name is in: everything before the first
 * `:`. `null` for a core hook, and for a bare name nobody prefixed.
 */
export function hookOwner(name: string): string | null {
  if (CORE_HOOKS.has(name)) return null;
  const colon = name.indexOf(":");
  return colon === -1 ? null : name.slice(0, colon);
}

/** What the consent rule needs from an app's manifest. */
export interface HookWiring {
  slug: string;
  emits: readonly HookEmit[];
  listensTo: readonly HookListen[];
}

/**
 * The other apps' hooks `slug` may listen to, as stored names: each one it
 * declares under `listensTo` whose emitter lists it, or `"*"`, in that hook's
 * `consumers`. The build already refuses a registry where the two disagree;
 * the runtime asks again, as the App Services broker does, rather than trust
 * that the registry it was handed is the one the build checked.
 */
export function consentedListens(
  slug: string,
  apps: readonly HookWiring[],
): Set<string> {
  const allowed = new Set<string>();
  const me = apps.find((a) => a.slug === slug);
  if (!me) return allowed;
  const bySlug = new Map(apps.map((a) => [a.slug, a]));
  for (const dep of me.listensTo) {
    const emit = bySlug.get(dep.app)?.emits.find((e) => e.name === dep.hook);
    if (!emit) continue;
    if (emit.consumers === "*" || emit.consumers.includes(slug)) {
      allowed.add(`${dep.app}:${dep.hook}`);
    }
  }
  return allowed;
}
