/* This Source Code Form is subject to the terms of the Mozilla Public
 * License, v. 2.0. If a copy of the MPL was not distributed with this
 * file, You can obtain one at https://mozilla.org/MPL/2.0/. */

/**
 * Which apps an analytics event is recorded for, with the grant and the app
 * gate standing in for the database. `ingest.integration.test.ts` sends both
 * routes real requests against a real Postgres.
 */

import { test } from "node:test";
import assert from "node:assert/strict";
import type { AppGate } from "@/lib/apps/app-gate";
import type { AppManifest } from "@/lib/apps/types";
import { appNotFound, openAppFor } from "./ingest";

const notes = { slug: "notes", telemetry: [] } as unknown as AppManifest;

/** Lookups for `notes`, recording what was asked, in order. */
function lookups({ held, gate }: { held: boolean; gate: AppGate }) {
  const asked: string[] = [];
  return {
    asked,
    lookups: {
      apps: [notes],
      hasAppGrant: async (userId: string, slug: string) => {
        asked.push(`grant:${userId}:${slug}`);
        return held;
      },
      checkAppGate: async (slug: string) => {
        asked.push(`gate:${slug}`);
        return gate;
      },
    },
  };
}

test("an app the user holds, while it may run, is the app", async () => {
  const { asked, lookups: l } = lookups({ held: true, gate: { open: true } });
  assert.equal(await openAppFor("u1", "notes", l), notes);
  assert.deepEqual(asked, ["grant:u1:notes", "gate:notes"]);
});

test("a name that is no app is refused without asking anything", async () => {
  for (const slug of ["nope", "", "NOTES", "notes/"]) {
    const { asked, lookups: l } = lookups({ held: true, gate: { open: true } });
    assert.equal(await openAppFor("u1", slug, l), null, slug);
    assert.deepEqual(asked, [], slug);
  }
});

test("an app the user doesn't hold is refused, and the gate isn't asked", async () => {
  const { asked, lookups: l } = lookups({ held: false, gate: { open: true } });
  assert.equal(await openAppFor("u1", "notes", l), null);
  assert.deepEqual(asked, ["grant:u1:notes"]);
});

test("an app the gate holds back, switched off or being updated, is refused", async () => {
  for (const reason of ["inactive", "updating"] as const) {
    const { lookups: l } = lookups({ held: true, gate: { open: false, reason } });
    assert.equal(await openAppFor("u1", "notes", l), null, reason);
  }
});

test("a refusal is the gateway's 404 for an app that isn't there", async () => {
  const res = appNotFound();
  assert.equal(res.status, 404);
  assert.deepEqual(await res.json(), { error: "Not found", code: "NOT_FOUND" });
});
