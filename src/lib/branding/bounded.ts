/* This Source Code Form is subject to the terms of the Mozilla Public
 * License, v. 2.0. If a copy of the MPL was not distributed with this
 * file, You can obtain one at https://mozilla.org/MPL/2.0/. */

import type { AppBranding } from "../apps/types";
import { sanitizeBrandName, type BrandHook, type BrandLogo } from "./types";

/**
 * The brand hooks' dispatch rules, with nothing in them that needs a database,
 * a request or the generated registry — `./resolve.ts` supplies those. Kept
 * apart so the rules can be tested directly.
 *
 * What makes these filters BOUNDED rather than ordinary:
 *
 * - Only a registration from an app's `hooks.ts` counts, and only for a hook
 *   the app declares under `branding.hooks`.
 * - They run in a fixed order: priority, then app slug. Never registration
 *   order, which depends on how imports happened to resolve — and in
 *   development moves an app to the back every time its file is saved.
 * - All of a slot's filters share one time budget. Twenty slow apps cost the
 *   page one budget, not twenty.
 * - Every result is re-validated. One the platform does not accept is
 *   discarded, and the value before it carried on.
 * - A run in which any filter failed does not replace the last good value;
 *   see `LastGood`.
 */

/** What the dispatcher needs from a hook registration. */
export interface BrandRegistration {
  callback: (value: unknown) => unknown;
  priority: number;
  appSlug?: string;
  entrypoint?: boolean;
}

/** What the dispatcher needs from an app's manifest. */
export interface BrandApp {
  slug: string;
  branding: AppBranding | null;
}

/** One filter that counts, paired with the app that registered it. */
export interface BrandFilter {
  registration: BrandRegistration;
  app: BrandApp;
}

/**
 * Re-validate one filter's result: the value to carry forward, or `undefined`
 * to discard the result and keep `current`.
 */
export type Accept<T> = (result: unknown, app: BrandApp, current: T) => T | undefined;

export const acceptName: Accept<string> = (result) =>
  sanitizeBrandName(result) ?? undefined;

/**
 * A logo filter may hide the mark (`null`), pass the one it was given, or pick
 * one of its OWN declared marks by `file`. Nothing else — in particular no URL,
 * so every image on the sign-in page is one the build published, and no app can
 * select another app's file.
 */
export const acceptLogo: Accept<BrandLogo | null> = (result, app, current) => {
  if (result === null) return null;
  if (typeof result === "string") {
    const asset = app.branding?.logos.find((l) => l.file === result);
    return asset
      ? { src: asset.url, width: asset.width, height: asset.height }
      : undefined;
  }
  if (
    current &&
    typeof result === "object" &&
    (result as { src?: unknown }).src === current.src
  ) {
    // Our own copy, not the returned object: what was handed out was frozen,
    // but a look-alike object could still carry other dimensions.
    return current;
  }
  return undefined;
};

/** Something that went wrong, for the caller to log. */
export type BrandProblem =
  | { kind: "threw"; hook: BrandHook; app: string; error: unknown }
  | { kind: "timeout"; hook: BrandHook; app: string; budgetMs: number }
  | { kind: "rejected"; hook: BrandHook; app: string }
  | { kind: "skipped"; hook: BrandHook; app: string; budgetMs: number }
  | { kind: "conflict"; hook: BrandHook; apps: string[] }
  | { kind: "lookup"; hook: BrandHook; error: unknown };

/**
 * The registrations that count for `hook`, in the order they run.
 *
 * Activation is not decided here — it needs the database. The caller filters
 * this list by which apps are active.
 */
export function eligibleFilters(
  hook: BrandHook,
  registrations: readonly BrandRegistration[],
  apps: readonly BrandApp[],
): BrandFilter[] {
  const bySlug = new Map(apps.map((a) => [a.slug, a]));
  const out: BrandFilter[] = [];
  for (const registration of registrations) {
    if (!registration.entrypoint || !registration.appSlug) continue;
    const app = bySlug.get(registration.appSlug);
    if (!app?.branding?.hooks.includes(hook)) continue;
    out.push({ registration, app });
  }
  // Array sort is stable, so one app's own registrations keep their order.
  return out.sort(
    (a, b) =>
      a.registration.priority - b.registration.priority ||
      (a.app.slug < b.app.slug ? -1 : a.app.slug > b.app.slug ? 1 : 0),
  );
}

export interface FilterOutcome<T> {
  value: T;
  /** False when any filter threw, timed out, was refused or was skipped. */
  clean: boolean;
  /** Distinct apps whose filters ran, in order. */
  ran: string[];
}

class FilterTimeout extends Error {}

/**
 * Run a slot's filters in order under one shared budget, re-validating each
 * result. Never throws: every failure is reported and the previous value kept.
 */
export async function runFilters<T>({
  hook,
  seed,
  accept,
  filters,
  budgetMs,
  report,
  now = Date.now,
}: {
  hook: BrandHook;
  seed: T;
  accept: Accept<T>;
  filters: readonly BrandFilter[];
  budgetMs: number;
  report: (problem: BrandProblem) => void;
  now?: () => number;
}): Promise<FilterOutcome<T>> {
  const deadline = now() + budgetMs;
  const ran: string[] = [];
  let current = seed;
  let clean = true;

  for (const { registration, app } of filters) {
    const remaining = deadline - now();
    if (remaining <= 0) {
      clean = false;
      report({ kind: "skipped", hook, app: app.slug, budgetMs });
      continue;
    }
    if (!ran.includes(app.slug)) ran.push(app.slug);

    let result: unknown;
    try {
      const given =
        current && typeof current === "object"
          ? Object.freeze({ ...current })
          : current;
      // Called in a microtask so a synchronous throw lands in the catch below
      // like any other failure.
      result = await withTimeout(
        Promise.resolve().then(() => registration.callback(given)),
        remaining,
      );
    } catch (error) {
      clean = false;
      report(
        error instanceof FilterTimeout
          ? { kind: "timeout", hook, app: app.slug, budgetMs }
          : { kind: "threw", hook, app: app.slug, error },
      );
      continue;
    }

    const next = accept(result, app, current);
    if (next === undefined) {
      clean = false;
      report({ kind: "rejected", hook, app: app.slug });
      continue;
    }
    current = next;
  }

  if (ran.length > 1) report({ kind: "conflict", hook, apps: ran });
  return { value: current, clean, ran };
}

function withTimeout<T>(promise: Promise<T>, ms: number): Promise<T> {
  let timer: ReturnType<typeof setTimeout> | undefined;
  const timeout = new Promise<never>((_, reject) => {
    timer = setTimeout(() => reject(new FilterTimeout()), ms);
  });
  return Promise.race([promise, timeout]).finally(() => clearTimeout(timer));
}

/**
 * The last value a slot resolved to cleanly, so one failed run does not flip
 * the brand.
 *
 * Without it, a filter that misses its budget once under load would show that
 * request "MixOS" and the next one the app's name again. A clean run stores
 * its value; a run with any failure serves the stored value instead, provided
 * it was stored for the same `key` — the theme, the apps that ran, and the hook
 * registrations' generation — so a deactivated app, a theme switch, or an
 * edited `hooks.ts` never brings back a value that no longer applies.
 *
 * A filter that fails EVERY time never stores anything, and its degraded
 * result is served consistently, which is also not a flip.
 */
export class LastGood<T> {
  private entry: { key: string; theme: string; value: T } | null = null;

  settle(key: string, theme: string, outcome: FilterOutcome<T>): T {
    if (outcome.clean) {
      this.entry = { key, theme, value: outcome.value };
      return outcome.value;
    }
    return this.entry?.key === key ? this.entry.value : outcome.value;
  }

  /**
   * After a failure outside the filters (the activation lookup, say), when
   * there is no key to match: the last value served under this theme, or the
   * seed.
   */
  fallback(theme: string, seed: T): T {
    return this.entry?.theme === theme ? this.entry.value : seed;
  }
}

/**
 * Wrap a logger so each distinct problem is logged once. A misbehaving filter
 * fails on every page render; one line says as much as ten thousand.
 */
export function onceReporter(
  log: (problem: BrandProblem) => void,
): (problem: BrandProblem) => void {
  const seen = new Set<string>();
  return (problem) => {
    const who = "app" in problem ? problem.app : "apps" in problem ? problem.apps.join(",") : "";
    const key = `${problem.kind}|${problem.hook}|${who}`;
    if (seen.has(key)) return;
    seen.add(key);
    log(problem);
  };
}
