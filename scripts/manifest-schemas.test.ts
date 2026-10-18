/* This Source Code Form is subject to the terms of the Mozilla Public
 * License, v. 2.0. If a copy of the MPL was not distributed with this
 * file, You can obtain one at https://mozilla.org/MPL/2.0/. */

import { test } from "node:test";
import assert from "node:assert/strict";
import { formatZodError, RawAppManifestSchema } from "./manifest-schemas";
import { JOB_TIMEOUT_MS, MAX_SYNC_BUDGET_MS } from "../src/lib/apps/job-limits";

// ── fixtures ────────────────────────────────────────────────────────────────

const sync = (budgetMs = 200_000) => ({
  name: "calls",
  schedule: { everyMinutes: 60 },
  source: "mixos",
  window: { coldStartDays: 30, defaultDays: 7, minDays: 1 },
  budgetMs,
});

/** The problems the schema reports for `manifest`, one line each. */
function problems(manifest: Record<string, unknown>): string {
  const parsed = RawAppManifestSchema.safeParse({ name: "Calls", ...manifest });
  return parsed.success ? "" : formatZodError(parsed.error);
}

// ── sync budget ─────────────────────────────────────────────────────────────

test("a sync budget leaves room under the job timeout", () => {
  assert.ok(MAX_SYNC_BUDGET_MS < JOB_TIMEOUT_MS);
  assert.equal(problems({ database: true, sync: [sync(MAX_SYNC_BUDGET_MS)] }), "");
});

test("a sync budget the scheduler would cut off fails the build", () => {
  for (const budgetMs of [MAX_SYNC_BUDGET_MS + 1, JOB_TIMEOUT_MS, 300_000]) {
    assert.match(
      problems({ database: true, sync: [sync(budgetMs)] }),
      /sync\.0\.budgetMs: budgetMs may be at most/,
      String(budgetMs),
    );
  }
});

// ── sync needs a database ───────────────────────────────────────────────────

test("a sync without a database fails the build", () => {
  for (const database of [undefined, false]) {
    assert.match(
      problems({ ...(database === undefined ? {} : { database }), sync: [sync()] }),
      /sync: a sync keeps its watermark in the app's scoped database — set "database": true/,
      String(database),
    );
  }
});

test("an app with no sync needs no database", () => {
  assert.equal(problems({ database: false, sync: [] }), "");
  assert.equal(problems({}), "");
});

// ── roles ───────────────────────────────────────────────────────────────────

test("role keys must be unique", () => {
  assert.equal(
    problems({
      roles: [
        { key: "admin", label: "Admin" },
        { key: "viewer", label: "Viewer" },
        { key: "admin", label: "Administrator" },
      ],
    }),
    '  - roles.2.key: duplicate role key "admin" — role keys must be unique within the app',
  );
});

test("distinct role keys pass, and a defaultRole still has to name one", () => {
  const roles = [
    { key: "admin", label: "Admin" },
    { key: "viewer", label: "Viewer" },
  ];
  assert.equal(problems({ roles, defaultRole: "viewer" }), "");
  assert.match(problems({ roles, defaultRole: "editor" }), /^ {2}- defaultRole:/);
});
