/* This Source Code Form is subject to the terms of the Mozilla Public
 * License, v. 2.0. If a copy of the MPL was not distributed with this
 * file, You can obtain one at https://mozilla.org/MPL/2.0/. */

import type { HookRegistrar } from "./types";
import { CORE_HOOKS, hookOwner, qualifyHookName } from "./scope";

// eslint-disable-next-line @typescript-eslint/no-explicit-any
type AnyCallback = (...args: any[]) => any;

const DEFAULT_PRIORITY = 10;

export interface HookRegistration {
  callback: AnyCallback;
  priority: number;
  appSlug?: string;
  /**
   * Made through the registrar `ensureHooksLoaded()` hands an app's declared
   * `hooks.ts`. Bounded core filters (the brand hooks) count ONLY these: a
   * registration from anywhere else is either unattributed or made per request,
   * and neither is something an admin reviewed at activation.
   */
  entrypoint?: boolean;
}

/**
 * Whether an app is active right now. The platform installs `isAppActive`, the
 * admin's switch, read per request (see `./loader.ts`).
 */
export type ActivationCheck = (appSlug: string) => Promise<boolean>;

/**
 * A hook name used where it is not allowed: firing another app's hook, or
 * listening to one without consent on both sides. See `./scope.ts`.
 */
export class HookConsentError extends Error {
  constructor(message: string) {
    super(message);
    this.name = "HookConsentError";
  }
}

const NO_LISTENS: ReadonlySet<string> = new Set();

/**
 * A name used with no app attached, on the bare `hooks` singleton: core hooks
 * only. Any other name is some app's hook, and reaching it from here would skip
 * every check an app's registrar makes. Firing it would speak for that app;
 * listening to it would skip the consent; and two apps sharing a bare name here
 * would be a cross-app channel neither declared.
 */
function unattributed(name: string): string {
  if (CORE_HOOKS.has(name)) return name;
  throw new HookConsentError(
    `"${name}" is not a core hook, and the bare hooks singleton belongs to no app. ` +
      `An app's hooks go through its own registrar: context.hooks in server code, ` +
      `or the registrar its hooks.ts is called with.`,
  );
}

export class HookSystem {
  private actions = new Map<string, HookRegistration[]>();
  private filters = new Map<string, HookRegistration[]>();
  private activation: ActivationCheck | null = null;
  private entrypointGeneration = 0;

  /**
   * Bumped whenever an app's entrypoint registrations are replaced. Anything
   * cached from the brand filters' results keys on it, so editing a `hooks.ts`
   * in development never leaves the previous version's value being served.
   */
  get generation(): number {
    return this.entrypointGeneration;
  }

  // ── Activation ────────────────────────────────────────────

  /**
   * Install how a dispatch decides whether an app's listeners run. Asked on
   * every dispatch, for each app with a listener on that hook, so it follows
   * the admin's switch for this request rather than anything an earlier
   * request left behind. Until one is installed, an app's listeners do not run.
   */
  setActivation(check: ActivationCheck): void {
    this.activation = check;
  }

  // ── Registration ──────────────────────────────────────────

  /** Unattributed: core hooks only. An app uses its registrar. */
  addAction(hookName: string, callback: AnyCallback, priority = DEFAULT_PRIORITY): void {
    this.register(this.actions, unattributed(hookName), { callback, priority });
  }

  /** Unattributed: core hooks only. An app uses its registrar. */
  addFilter(hookName: string, callback: AnyCallback, priority = DEFAULT_PRIORITY): void {
    this.register(this.filters, unattributed(hookName), { callback, priority });
  }

  private register(map: Map<string, HookRegistration[]>, hookName: string, reg: HookRegistration): void {
    const list = map.get(hookName) ?? [];
    list.push(reg);
    map.set(hookName, list);
  }

  /**
   * Drop everything an app's `hooks.ts` registered, so loading it again
   * replaces its registrations instead of doubling them. Registrations made
   * any other way are left alone.
   */
  clearEntrypoint(appSlug: string): void {
    for (const map of [this.actions, this.filters]) {
      for (const [name, list] of map) {
        map.set(name, list.filter((r) => !(r.entrypoint && r.appSlug === appSlug)));
      }
    }
    this.entrypointGeneration++;
  }

  /**
   * A filter's registrations in dispatch order, WITHOUT the activation check.
   * For a dispatcher that decides activation itself, per request — see
   * `src/lib/branding/resolve.ts`.
   */
  getFilterRegistrations(hookName: string): readonly HookRegistration[] {
    return [...(this.filters.get(hookName) ?? [])].sort((a, b) => a.priority - b.priority);
  }

  removeAction(hookName: string, callback: AnyCallback): void {
    const list = this.actions.get(hookName);
    if (!list) return;
    this.actions.set(hookName, list.filter((r) => r.callback !== callback));
  }

  removeFilter(hookName: string, callback: AnyCallback): void {
    const list = this.filters.get(hookName);
    if (!list) return;
    this.filters.set(hookName, list.filter((r) => r.callback !== callback));
  }

  // ── Dispatching ───────────────────────────────────────────

  /** Unattributed: core hooks only. An app uses its registrar. */
  async doAction(hookName: string, ...args: unknown[]): Promise<void> {
    await this.runActions(unattributed(hookName), args);
  }

  /** Unattributed: core hooks only. An app uses its registrar. */
  async applyFilters<T>(hookName: string, value: T, ...args: unknown[]): Promise<T> {
    return this.runFilters(unattributed(hookName), value, args);
  }

  private async runActions(hookName: string, args: unknown[]): Promise<void> {
    for (const reg of await this.runnable(this.actions.get(hookName))) {
      await reg.callback(...args);
    }
  }

  private async runFilters<T>(hookName: string, value: T, args: unknown[]): Promise<T> {
    let current: unknown = value;
    for (const reg of await this.runnable(this.filters.get(hookName))) {
      current = await reg.callback(current, ...args);
    }
    return current as T;
  }

  /**
   * The registrations that run on this dispatch, in priority order: every
   * unattributed one, and an app's only while that app is active. A check that
   * fails counts as inactive.
   */
  private async runnable(list: HookRegistration[] | undefined): Promise<HookRegistration[]> {
    if (!list || list.length === 0) return [];
    const snapshot = [...list];
    const check = this.activation;
    const slugs = [...new Set(snapshot.flatMap((r) => (r.appSlug ? [r.appSlug] : [])))];
    const verdicts = await Promise.all(
      slugs.map(async (slug) => {
        if (!check) return false;
        try {
          return await check(slug);
        } catch {
          return false;
        }
      }),
    );
    const active = new Set(slugs.filter((_, i) => verdicts[i]));
    return snapshot
      .filter((r) => !r.appSlug || active.has(r.appSlug))
      .sort((a, b) => a.priority - b.priority);
  }

  // ── Registrar for apps ────────────────────────────────────

  /**
   * The registrar an app is handed: as `context.hooks`, and as the argument to
   * its `hooks.ts`. Everything it registers is attributed to `appSlug`, and a
   * bare name means the app's own hook (`ready` is `<slug>:ready`).
   *
   * - It fires the app's own hooks and core hooks. Another app's hook, named in
   *   full, is refused.
   * - It listens to the app's own hooks and core hooks, and to another app's
   *   hook only when `listens` holds it: `consentedListens()` from `./scope`,
   *   both halves of the consent. Anything else is refused when it is made.
   *
   * `beforeDispatch` runs before each fire; the platform loads every app's
   * `hooks.ts` there, so a listener declared in one is registered whichever
   * request comes first.
   */
  createRegistrar(
    appSlug: string,
    {
      entrypoint = false,
      listens = NO_LISTENS,
      beforeDispatch,
    }: {
      entrypoint?: boolean;
      listens?: ReadonlySet<string>;
      beforeDispatch?: () => Promise<void>;
    } = {},
  ): HookRegistrar {
    const toListen = (hookName: string): string => {
      const name = qualifyHookName(hookName, appSlug);
      const owner = hookOwner(name);
      if (owner === null || owner === appSlug || listens.has(name)) return name;
      const hook = name.slice(owner.length + 1);
      throw new HookConsentError(
        `"${appSlug}" may not listen to "${name}", a hook of "${owner}", without consent on both sides: ` +
          `{ "app": "${owner}", "hook": "${hook}" } under \`listensTo\` in apps/${appSlug}/app.json, ` +
          `and "${appSlug}" in that hook's \`consumers\` under \`emits\` in apps/${owner}/app.json.`,
      );
    };
    const toFire = (hookName: string): string => {
      const name = qualifyHookName(hookName, appSlug);
      const owner = hookOwner(name);
      if (owner === null || owner === appSlug) return name;
      throw new HookConsentError(
        `"${appSlug}" may not fire "${name}", a hook of "${owner}". ` +
          `An app fires its own hooks and core hooks.`,
      );
    };

    return {
      addAction: (hookName: string, callback: AnyCallback, priority = DEFAULT_PRIORITY) => {
        this.register(this.actions, toListen(hookName), { callback, priority, appSlug, entrypoint });
      },
      addFilter: (hookName: string, callback: AnyCallback, priority = DEFAULT_PRIORITY) => {
        this.register(this.filters, toListen(hookName), { callback, priority, appSlug, entrypoint });
      },
      doAction: async (hookName: string, ...args: unknown[]) => {
        const name = toFire(hookName);
        await beforeDispatch?.();
        await this.runActions(name, args);
      },
      applyFilters: async <T>(hookName: string, value: T, ...args: unknown[]) => {
        const name = toFire(hookName);
        await beforeDispatch?.();
        return this.runFilters(name, value, args);
      },
    } as HookRegistrar;
  }
}

/** Singleton hook system instance */
export const hooks = new HookSystem();
