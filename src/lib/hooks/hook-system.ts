/* This Source Code Form is subject to the terms of the Mozilla Public
 * License, v. 2.0. If a copy of the MPL was not distributed with this
 * file, You can obtain one at https://mozilla.org/MPL/2.0/. */

import type { HookRegistrar, ActionHookMap, FilterHookMap } from "./types";
import { BRAND_HOOKS } from "@/lib/branding/types";

// eslint-disable-next-line @typescript-eslint/no-explicit-any
type AnyCallback = (...args: any[]) => any;

const DEFAULT_PRIORITY = 10;

/** All core hook names — these are never auto-prefixed. */
export const CORE_HOOKS = new Set<string>([
  // Actions
  "init",
  "user-login",
  "user-sync",
  // Filters
  "user-display-name",
  ...BRAND_HOOKS,
] satisfies (keyof ActionHookMap | keyof FilterHookMap)[]);

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
 * Resolve the stored hook name.
 * - Core hooks and names already containing `:` pass through unchanged.
 * - Otherwise, prefix with `{appSlug}:` when an appSlug is provided.
 */
function resolveHookName(name: string, appSlug?: string): string {
  if (CORE_HOOKS.has(name) || name.includes(":") || !appSlug) return name;
  return `${appSlug}:${name}`;
}

export class HookSystem {
  private actions = new Map<string, HookRegistration[]>();
  private filters = new Map<string, HookRegistration[]>();
  private activeApps = new Set<string>();
  private entrypointGeneration = 0;

  /**
   * Bumped whenever an app's entrypoint registrations are replaced. Anything
   * cached from the brand filters' results keys on it, so editing a `hooks.ts`
   * in development never leaves the previous version's value being served.
   */
  get generation(): number {
    return this.entrypointGeneration;
  }

  // ── Active app gating ─────────────────────────────────────

  setActiveApps(slugs: string[]): void {
    this.activeApps = new Set(slugs);
  }

  private isActive(reg: HookRegistration): boolean {
    if (!reg.appSlug) return true;
    return this.activeApps.has(reg.appSlug);
  }

  // ── Registration ──────────────────────────────────────────

  addAction(hookName: string, callback: AnyCallback, priority = DEFAULT_PRIORITY, appSlug?: string): void {
    this.register(this.actions, hookName, { callback, priority, appSlug });
  }

  addFilter(hookName: string, callback: AnyCallback, priority = DEFAULT_PRIORITY, appSlug?: string): void {
    this.register(this.filters, hookName, { callback, priority, appSlug });
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
   * A filter's registrations in dispatch order, WITHOUT the process-global
   * active-app gate. For a dispatcher that decides activation itself, per
   * request — see `src/lib/branding/resolve.ts`.
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

  async doAction(hookName: string, ...args: unknown[]): Promise<void> {
    const list = this.actions.get(hookName);
    if (!list) return;

    const sorted = [...list]
      .filter((r) => this.isActive(r))
      .sort((a, b) => a.priority - b.priority);

    for (const reg of sorted) {
      await reg.callback(...args);
    }
  }

  async applyFilters<T>(hookName: string, value: T, ...args: unknown[]): Promise<T> {
    const list = this.filters.get(hookName);
    if (!list) return value;

    const sorted = [...list]
      .filter((r) => this.isActive(r))
      .sort((a, b) => a.priority - b.priority);

    let current: unknown = value;
    for (const reg of sorted) {
      current = await reg.callback(current, ...args);
    }

    return current as T;
  }

  // ── Registrar for apps ────────────────────────────────────

  createRegistrar(appSlug?: string, { entrypoint = false }: { entrypoint?: boolean } = {}): HookRegistrar {
    return {
      addAction: (hookName: string, callback: AnyCallback, priority = DEFAULT_PRIORITY) => {
        // Listening: core hooks and fully-qualified names (containing :) pass through.
        // Custom names get auto-prefixed with appSlug.
        const resolved = resolveHookName(hookName, appSlug);
        this.register(this.actions, resolved, { callback, priority, appSlug, entrypoint });
      },
      addFilter: (hookName: string, callback: AnyCallback, priority = DEFAULT_PRIORITY) => {
        const resolved = resolveHookName(hookName, appSlug);
        this.register(this.filters, resolved, { callback, priority, appSlug, entrypoint });
      },
      doAction: (hookName: string, ...args: unknown[]) => {
        // Firing: auto-prefix so apps can only fire their own hooks or core hooks.
        const resolved = resolveHookName(hookName, appSlug);
        return this.doAction(resolved, ...args);
      },
      applyFilters: <T>(hookName: string, value: T, ...args: unknown[]) => {
        const resolved = resolveHookName(hookName, appSlug);
        return this.applyFilters(resolved, value, ...args);
      },
    } as HookRegistrar;
  }
}

/** Singleton hook system instance */
export const hooks = new HookSystem();
