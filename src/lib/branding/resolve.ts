/* This Source Code Form is subject to the terms of the Mozilla Public
 * License, v. 2.0. If a copy of the MPL was not distributed with this
 * file, You can obtain one at https://mozilla.org/MPL/2.0/. */

import { cache } from "react";
import { appRegistry } from "@/generated/app-registry";
import { createServiceClient } from "@/lib/db/server";
import { hooks } from "@/lib/hooks";
import { ensureHooksLoaded } from "@/lib/hooks/loader";
import { maintenanceState } from "@/lib/platform/maintenance";
import { getActiveTheme } from "@/lib/themes/active";
import {
  acceptLogo,
  acceptName,
  eligibleFilters,
  LastGood,
  onceReporter,
  runFilters,
  type Accept,
  type BrandProblem,
} from "./bounded";
import { DEFAULT_BRAND_NAME, type BrandHook, type BrandLogo } from "./types";

/**
 * The install's brand, one slot at a time: the name, the menu-bar mark and the
 * sign-in mark.
 *
 * Each slot resolves on its own (see `./types.ts` for the full precedence):
 *
 *   1. If the active theme's `branding` claims the slot, that is the answer,
 *      and no app code runs for it.
 *   2. Otherwise the active apps' filters run (see `./bounded.ts` for the
 *      rules), starting from "MixOS" for the name and the theme's
 *      `assets.logo` for both marks.
 *
 * ONE GETTER PER SLOT, so a page pays only for what it draws. The sign-in page
 * never waits on a menu-bar filter, and the dashboard never on a sign-in one
 * unless the welcome tour is showing it. Each is request-cached: the root
 * layout's metadata and the layout below it ask the same question once.
 */

export const getBrandName = cache(async (): Promise<string> => {
  const { theme } = await getActiveTheme();
  return (
    theme.branding.name ??
    resolveSlot("brand-name", DEFAULT_BRAND_NAME, acceptName, lastGood.name, theme.slug)
  );
});

export const getMenuBarLogo = cache(async (): Promise<BrandLogo | null> => {
  const { theme } = await getActiveTheme();
  return (
    theme.branding.menuBarLogo ??
    resolveSlot("menu-bar-logo", theme.logo, acceptLogo, lastGood.menuBar, theme.slug)
  );
});

export const getLoginLogo = cache(async (): Promise<BrandLogo | null> => {
  const { theme } = await getActiveTheme();
  return (
    theme.branding.loginLogo ??
    resolveSlot("login-logo", theme.logo, acceptLogo, lastGood.login, theme.slug)
  );
});

/**
 * All of a slot's filters together get this long. Long enough for a filter
 * doing real work; short enough that the worst case costs the sign-in page a
 * second, however many apps are slow.
 */
const SLOT_BUDGET_MS = 1000;

/** Per process. See `LastGood` for when a stored value is served. */
const lastGood = {
  name: new LastGood<string>(),
  menuBar: new LastGood<BrandLogo | null>(),
  login: new LastGood<BrandLogo | null>(),
};

async function resolveSlot<T>(
  hook: BrandHook,
  seed: T,
  accept: Accept<T>,
  store: LastGood<T>,
  theme: string,
): Promise<T> {
  try {
    await ensureHooksLoaded();
    const eligible = eligibleFilters(
      hook,
      hooks.getFilterRegistrations(hook),
      appRegistry,
    );
    if (eligible.length === 0) return seed;

    const active = await getActiveBrandApps();
    const filters = eligible.filter((f) => active.has(f.app.slug));
    if (filters.length === 0) return seed;

    // Keyed on the apps SCHEDULED to run, not those that did: a filter skipped
    // for want of budget is exactly the run the stored value is for.
    const scheduled = [...new Set(filters.map((f) => f.app.slug))].join(",");
    const key = `${theme}|${scheduled}|${hooks.generation}`;

    const outcome = await runFilters({
      hook,
      seed,
      accept,
      filters,
      budgetMs: SLOT_BUDGET_MS,
      report,
    });
    return store.settle(key, theme, outcome);
  } catch (error) {
    report({ kind: "lookup", hook, error });
    return store.fallback(theme, seed);
  }
}

/**
 * Which apps that declare brand hooks the app gate would let run, in one
 * query: active, and with their own migrations applied.
 *
 * Not `isAppActive`: that reads a failed lookup as "inactive", which is right
 * for a gate and wrong here — it would turn a database blip into every request
 * showing "MixOS". This throws instead, and `resolveSlot` serves the last good
 * value. A missing row is still inactive, as everywhere else. The update needs
 * no such care: a check that can't tell counts as not behind.
 */
const getActiveBrandApps = cache(async (): Promise<Set<string>> => {
  const slugs = appRegistry.filter((a) => a.branding).map((a) => a.slug);
  if (slugs.length === 0) return new Set();
  const [{ data, error }, { appsBehind }] = await Promise.all([
    createServiceClient().from("apps").select("slug, is_active").in("slug", slugs),
    maintenanceState(),
  ]);
  if (error) throw new Error(`apps lookup failed: ${error.message}`);
  const rows = (data ?? []) as { slug: string; is_active: boolean }[];
  return new Set(
    rows.filter((r) => r.is_active === true && !appsBehind.has(r.slug)).map((r) => r.slug),
  );
});

// ── logging ─────────────────────────────────────────────────────────────────

/**
 * Each distinct problem is logged once per process, and again after any
 * `hooks.ts` is reloaded — an edited filter is a new filter.
 */
let reporter: { generation: number; report: (p: BrandProblem) => void } | null =
  null;

function report(problem: BrandProblem): void {
  if (reporter?.generation !== hooks.generation) {
    reporter = { generation: hooks.generation, report: onceReporter(log) };
  }
  reporter.report(problem);
}

const ONCE = "Logged once per process.";
const DOCS = "See docs/apps/hooks.md#brand-hooks.";

function log(problem: BrandProblem): void {
  const where = `[branding] ${"app" in problem ? `${problem.app} ` : ""}${problem.hook}:`;
  switch (problem.kind) {
    case "threw":
      console.error(`${where} the filter threw; the value before it was kept. ${ONCE}`, problem.error);
      return;
    case "timeout":
      console.error(
        `${where} no answer within the slot's ${problem.budgetMs}ms budget; the value before it was kept. ${ONCE}`,
      );
      return;
    case "rejected":
      console.warn(`${where} returned a value the platform does not accept; the value before it was kept. ${DOCS} ${ONCE}`);
      return;
    case "skipped":
      console.warn(
        `${where} not run: earlier filters spent the slot's ${problem.budgetMs}ms budget. ${ONCE}`,
      );
      return;
    case "conflict":
      console.warn(
        `${where} ${problem.apps.length} active apps filter it (${problem.apps.join(", ")}). ` +
          `They run by priority, then slug, and the last one's value is used. ${ONCE}`,
      );
      return;
    case "lookup":
      console.error(
        `${where} could not resolve app filters; serving the last good value, or the default. ${ONCE}`,
        problem.error,
      );
      return;
  }
}
