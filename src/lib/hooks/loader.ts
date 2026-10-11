/* This Source Code Form is subject to the terms of the Mozilla Public
 * License, v. 2.0. If a copy of the MPL was not distributed with this
 * file, You can obtain one at https://mozilla.org/MPL/2.0/. */

import { hookLoaders } from "@/generated/app-hook-loaders";
import { appRegistry } from "@/generated/app-registry";
import { checkAppGate } from "@/lib/apps/app-gate";
import { hooks } from "./hook-system";
import { consentedListens } from "./scope";
import type { HookRegistrar } from "./types";

/**
 * Load every app's declared hook entrypoint, `apps/<slug>/hooks.ts`.
 *
 * WHY THIS EXISTS. Listeners used to register as an import side effect, which
 * meant a hook was live only on a request that happened to import the app's
 * module. Nothing imports app code on `/login` or in the main layout, so a
 * filter on the brand would never have run where the brand renders. A declared
 * entrypoint, imported here before any dispatch that needs it, is what makes a
 * registration a fact about the install rather than about the request.
 *
 * Each entrypoint is called with a registrar attributed to its app and marked
 * `entrypoint`, which is the only kind of registration a bounded core filter
 * counts.
 *
 * Called on every dispatch, deliberately. `import()` of an already-loaded
 * module is a resolved promise, and an entrypoint is only re-run when the
 * module's default export is a different function than last time — which in
 * production is never, and in development is exactly when the file was edited.
 * Before re-running, the app's previous entrypoint registrations are dropped,
 * so a reload replaces rather than doubles them. The compare-and-register step
 * runs synchronously after the import resolves, so two concurrent requests
 * cannot both register the same new module.
 *
 * Only an app the app gate lets through is loaded (src/lib/apps/app-gate.ts):
 * importing `hooks.ts` runs its top-level code, and then its entrypoint, so the
 * `hooks.ts` of an inactive app, or of one whose own migrations are behind this
 * build, never runs. The gate is asked for each app on every call, because the
 * admin's switch can flip at any time and a process outlives many flips: an
 * app activated, or brought up to date by the release step, since the last
 * call loads on this one, with no restart.
 *
 * An app the gate closes on after it loaded keeps its registrations, and they
 * do not run: dispatch asks the gate per request for each app with a listener
 * on the hook (installed below), and the brand filters check activation and
 * the update themselves (src/lib/branding/resolve.ts). Once the gate opens
 * again they run. They are not dropped here, because the gate reads a failed
 * lookup as "off" too, and dropping them on that would turn a database blip
 * into the default brand on every page, where `resolve.ts` would have served
 * the last good one.
 */

type Entrypoint = (hooks: HookRegistrar) => void;

const registered = new Map<string, Entrypoint>();

/**
 * How `hooks.doAction` and `hooks.applyFilters` decide whether an app's
 * listener runs: the app gate, asked per dispatch and request-cached.
 * Installed here because an app's listeners come only from the two registrars
 * this module hands out, so it is in place before any of them can exist.
 */
hooks.setActivation(async (slug) => (await checkAppGate(slug)).open);

export async function ensureHooksLoaded(): Promise<void> {
  await Promise.all(
    Object.entries(hookLoaders).map(async ([slug, load]) => {
      if (!(await checkAppGate(slug)).open) return;

      let entry: unknown;
      try {
        entry = (await load()).default;
      } catch (err) {
        console.error(`[hooks] apps/${slug}/hooks.ts failed to import:`, err);
        return;
      }
      if (typeof entry !== "function") {
        console.error(
          `[hooks] apps/${slug}/hooks.ts must default-export a function (hooks) => void; skipping it.`,
        );
        return;
      }
      if (registered.get(slug) === entry) return;

      registered.set(slug, entry as Entrypoint);
      hooks.clearEntrypoint(slug);
      try {
        (entry as Entrypoint)(
          hooks.createRegistrar(slug, {
            entrypoint: true,
            listens: consentedListens(slug, appRegistry),
          }),
        );
      } catch (err) {
        // Whatever it registered before throwing is dropped too: half an
        // entrypoint is not what anyone reviewed. That includes a listener on
        // another app's hook the registrar refused for want of consent.
        hooks.clearEntrypoint(slug);
        console.error(`[hooks] apps/${slug}/hooks.ts threw while registering:`, err);
      }
    }),
  );
}

/**
 * The registrar an app's server code gets as `context.hooks`: attributed to the
 * app, holding the other apps' hooks it may listen to, and loading every
 * `hooks.ts` before it fires, so a listener declared in one runs whichever
 * request happens to come first.
 */
export function appRegistrar(slug: string): HookRegistrar {
  return hooks.createRegistrar(slug, {
    listens: consentedListens(slug, appRegistry),
    beforeDispatch: ensureHooksLoaded,
  });
}
