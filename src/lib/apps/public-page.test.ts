/* This Source Code Form is subject to the terms of the Mozilla Public
 * License, v. 2.0. If a copy of the MPL was not distributed with this
 * file, You can obtain one at https://mozilla.org/MPL/2.0/. */

import { test } from "node:test";
import assert from "node:assert/strict";
import type { AppGate } from "./app-gate";
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

/**
 * An app gate that records what it was asked: open for `active`, closed for
 * `updating` on the apps in `updating` that are also active, as the real gate
 * orders its two questions.
 */
function gate(active: string[], updating: string[] = []) {
  const asked: string[] = [];
  return {
    asked,
    appGate: async (slug: string): Promise<AppGate> => {
      asked.push(slug);
      if (!active.includes(slug)) return { open: false, reason: "inactive" };
      if (updating.includes(slug)) return { open: false, reason: "updating" };
      return { open: true };
    },
  };
}

// ── a deactivated app serves nothing ────────────────────────────────────────

test("a deactivated app's public page is not served", async () => {
  const { appGate } = gate([]);
  const access = await publicPageAccess("survey", "", apps, appGate);
  assert.deepEqual(access, { kind: "not-served" });
});

test("a deactivated app's password page is not served, so no gate is shown", async () => {
  const { appGate } = gate([]);
  const access = await publicPageAccess("survey", "results", apps, appGate);
  assert.deepEqual(access, { kind: "not-served" });
});

test("an active app's pages are served as their manifest declares", async () => {
  const { appGate } = gate(["survey"]);
  const open = await publicPageAccess("survey", "", apps, appGate);
  const locked = await publicPageAccess("survey", "results", apps, appGate);
  const mixed = await publicPageAccess("survey", "both", apps, appGate);
  assert.ok(open.kind !== "not-served");
  assert.equal(open.manifest.slug, "survey");
  assert.equal(open.kind, "open");
  assert.equal(locked.kind, "password");
  assert.equal(mixed.kind, "open");
});

// ── an app being updated ────────────────────────────────────────────────────

test("an active app being updated answers updating for every page it would serve", async () => {
  const { appGate } = gate(["survey"], ["survey"]);
  for (const page of ["", "results", "both"]) {
    const access = await publicPageAccess("survey", page, apps, appGate);
    assert.ok(access.kind === "updating", page);
    // Named, so the page's title can still say whose page this is.
    assert.equal(access.manifest.slug, "survey");
  }
});

test("a deactivated app being updated is still not served", async () => {
  const { appGate } = gate([], ["survey"]);
  for (const page of ["", "results"]) {
    assert.deepEqual(await publicPageAccess("survey", page, apps, appGate), {
      kind: "not-served",
    });
  }
});

test("a page an app being updated doesn't open is still not served, without asking", async () => {
  const { asked, appGate } = gate(["survey"], ["survey"]);
  for (const page of ["admin", "typo"]) {
    assert.deepEqual(await publicPageAccess("survey", page, apps, appGate), {
      kind: "not-served",
    });
  }
  assert.deepEqual(asked, []);
});

// ── what fails closed before any lookup ─────────────────────────────────────

test("a session-only or undeclared page is not served, without asking the database", async () => {
  const { asked, appGate } = gate(["survey"]);
  assert.deepEqual(await publicPageAccess("survey", "admin", apps, appGate), {
    kind: "not-served",
  });
  assert.deepEqual(await publicPageAccess("survey", "typo", apps, appGate), {
    kind: "not-served",
  });
  assert.deepEqual(asked, []);
});

test("an app that is not installed is not served", async () => {
  const { asked, appGate } = gate(["ghost"]);
  assert.deepEqual(await publicPageAccess("ghost", "", apps, appGate), {
    kind: "not-served",
  });
  assert.deepEqual(asked, []);
});
