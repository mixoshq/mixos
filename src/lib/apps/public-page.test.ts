/* This Source Code Form is subject to the terms of the Mozilla Public
 * License, v. 2.0. If a copy of the MPL was not distributed with this
 * file, You can obtain one at https://mozilla.org/MPL/2.0/. */

import { test } from "node:test";
import assert from "node:assert/strict";
import { publicPageAccess } from "./public-page";
import type { AppManifest, RouteAuth } from "./types";

// ── fixtures ────────────────────────────────────────────────────────────────

/** Only what the gate reads; the rest of a manifest is irrelevant to it. */
function app(slug: string, pageVisibility: Record<string, RouteAuth[]>): AppManifest {
  return { slug, name: `App ${slug}`, pageVisibility } as unknown as AppManifest;
}

const apps = [
  app("survey", {
    "": ["public"],
    results: ["password"],
    admin: ["session"],
    both: ["session", "public"],
  }),
];

/** An activation lookup that records what it was asked. */
function activation(active: string[]) {
  const asked: string[] = [];
  return {
    asked,
    isAppActive: async (slug: string) => {
      asked.push(slug);
      return active.includes(slug);
    },
  };
}

// ── a deactivated app serves nothing ────────────────────────────────────────

test("a deactivated app's public page is not served", async () => {
  const { isAppActive } = activation([]);
  const access = await publicPageAccess("survey", "", apps, isAppActive);
  assert.deepEqual(access, { kind: "not-served" });
});

test("a deactivated app's password page is not served, so no gate is shown", async () => {
  const { isAppActive } = activation([]);
  const access = await publicPageAccess("survey", "results", apps, isAppActive);
  assert.deepEqual(access, { kind: "not-served" });
});

test("an active app's pages are served as their manifest declares", async () => {
  const { isAppActive } = activation(["survey"]);
  const open = await publicPageAccess("survey", "", apps, isAppActive);
  const locked = await publicPageAccess("survey", "results", apps, isAppActive);
  const mixed = await publicPageAccess("survey", "both", apps, isAppActive);
  assert.ok(open.kind !== "not-served");
  assert.equal(open.manifest.slug, "survey");
  assert.equal(open.kind, "open");
  assert.equal(locked.kind, "password");
  assert.equal(mixed.kind, "open");
});

// ── what fails closed before any lookup ─────────────────────────────────────

test("a session-only or undeclared page is not served, without asking the database", async () => {
  const { asked, isAppActive } = activation(["survey"]);
  assert.deepEqual(await publicPageAccess("survey", "admin", apps, isAppActive), {
    kind: "not-served",
  });
  assert.deepEqual(await publicPageAccess("survey", "typo", apps, isAppActive), {
    kind: "not-served",
  });
  assert.deepEqual(asked, []);
});

test("an app that is not installed is not served", async () => {
  const { asked, isAppActive } = activation(["ghost"]);
  assert.deepEqual(await publicPageAccess("ghost", "", apps, isAppActive), {
    kind: "not-served",
  });
  assert.deepEqual(asked, []);
});
