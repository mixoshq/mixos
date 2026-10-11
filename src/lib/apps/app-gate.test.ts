/* This Source Code Form is subject to the terms of the Mozilla Public
 * License, v. 2.0. If a copy of the MPL was not distributed with this
 * file, You can obtain one at https://mozilla.org/MPL/2.0/. */

/**
 * The app gate's decision, with its two lookups standing in for the database:
 * the admin's switch first, then whether the app's own migrations are behind.
 * `app-gate.integration.test.ts` and `app-maintenance.integration.test.ts`
 * run it against a real Postgres, through every door.
 */

import { test } from "node:test";
import assert from "node:assert/strict";
import type { AppMigrationStatus } from "@/lib/platform/app-migrations";
import {
  cachedMaintenanceState,
  maintenanceStateOf,
  type MaintenanceState,
} from "@/lib/platform/maintenance-gate";
import { appGateOf, type AppGateChecks } from "./app-gate";

const behind = (...slugs: string[]): MaintenanceState => ({
  platformBehind: false,
  appsBehind: new Set(slugs),
});

/** Lookups that record what was asked, in order. */
function checks(active: string[], state: () => Promise<MaintenanceState>) {
  const asked: string[] = [];
  const lookups: AppGateChecks = {
    isAppActive: async (slug) => {
      asked.push(`active:${slug}`);
      return active.includes(slug);
    },
    maintenanceState: async () => {
      asked.push("state");
      return state();
    },
  };
  return { asked, lookups };
}

test("an active app whose migrations are behind is held back as updating", async () => {
  const { lookups } = checks(["notes"], async () => behind("notes"));
  assert.deepEqual(await appGateOf("notes", lookups), { open: false, reason: "updating" });
});

test("another app keeps running while one is behind", async () => {
  const { lookups } = checks(["notes", "tasks"], async () => behind("notes"));
  assert.deepEqual(await appGateOf("tasks", lookups), { open: true });
});

test("a switched-off app is inactive whatever its migrations say, and the update isn't asked", async () => {
  for (const state of [behind("notes"), behind()]) {
    const { asked, lookups } = checks([], async () => state);
    assert.deepEqual(await appGateOf("notes", lookups), { open: false, reason: "inactive" });
    assert.deepEqual(asked, ["active:notes"]);
  }
});

test("an active app with its migrations applied is open", async () => {
  const { asked, lookups } = checks(["notes"], async () => behind());
  assert.deepEqual(await appGateOf("notes", lookups), { open: true });
  assert.deepEqual(asked, ["active:notes", "state"]);
});

test("can't tell is not behind: a check that fails or doesn't answer lets the app run", async () => {
  const failing = cachedMaintenanceState(async () => {
    throw new Error("connect ECONNREFUSED");
  });
  const silent = cachedMaintenanceState(() => new Promise<MaintenanceState>(() => {}), { waitMs: 5 });
  const ledgerUnread: AppMigrationStatus = {
    ok: true,
    pending: [],
    message: "Could not read public._migrations, so app migrations were not checked against this build.",
  };
  const unreadLedger = async () => maintenanceStateOf({ ok: true }, ledgerUnread);
  for (const state of [failing, silent, unreadLedger]) {
    const { lookups } = checks(["notes"], state);
    assert.deepEqual(await appGateOf("notes", lookups), { open: true });
  }
});
