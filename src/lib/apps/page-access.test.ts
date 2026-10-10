/* This Source Code Form is subject to the terms of the Mozilla Public
 * License, v. 2.0. If a copy of the MPL was not distributed with this
 * file, You can obtain one at https://mozilla.org/MPL/2.0/. */

import { test } from "node:test";
import assert from "node:assert/strict";
import { canOpenAppPage } from "./page-access";
import type { RouteAuth } from "./types";

// ── fixtures ────────────────────────────────────────────────────────────────

const app = {
  slug: "directory",
  pageVisibility: {
    people: ["signed-in"],
    both: ["session", "signed-in"],
    admin: ["session"],
    shared: ["public"],
  } satisfies Record<string, RouteAuth[]>,
};

/** Lookups for a user holding no grant to anything, recording what was asked. */
function noGrant({ active }: { active: boolean }) {
  const asked: string[] = [];
  return {
    asked,
    lookups: {
      hasAppGrant: async (_userId: string, slug: string) => {
        asked.push(`grant:${slug}`);
        return false;
      },
      isAppActive: async (slug: string) => {
        asked.push(`active:${slug}`);
        return active;
      },
    },
  };
}

// ── signed-in pages ─────────────────────────────────────────────────────────

test("a signed-in page opens for a user without the app's grant", async () => {
  for (const page of ["people", "both"]) {
    const { asked, lookups } = noGrant({ active: true });
    assert.equal(await canOpenAppPage(app, page, "u1", lookups), true, page);
    assert.deepEqual(asked, ["active:directory"], page);
  }
});

test("a signed-in page of a deactivated app does not open", async () => {
  const { lookups } = noGrant({ active: false });
  assert.equal(await canOpenAppPage(app, "people", "u1", lookups), false);
});

// ── everything else needs the grant ─────────────────────────────────────────

test("session, undeclared and public-only pages need the grant", async () => {
  for (const page of ["admin", "", "typo", "shared"]) {
    const { asked, lookups } = noGrant({ active: true });
    assert.equal(await canOpenAppPage(app, page, "u1", lookups), false, page);
    assert.deepEqual(asked, ["grant:directory"], page);
  }
});

test("an app with no pageVisibility needs the grant on every page", async () => {
  const { lookups } = noGrant({ active: true });
  assert.equal(await canOpenAppPage({ slug: "plain" }, "", "u1", lookups), false);
  assert.equal(
    await canOpenAppPage({ slug: "plain" }, "", "u1", {
      ...lookups,
      hasAppGrant: async () => true,
    }),
    true,
  );
});
