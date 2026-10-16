/* This Source Code Form is subject to the terms of the Mozilla Public
 * License, v. 2.0. If a copy of the MPL was not distributed with this
 * file, You can obtain one at https://mozilla.org/MPL/2.0/. */

/**
 * The App Access tab of a user's dialog on /admin/users, rendered on the
 * server: the role select's Default, which stores no role so the person
 * follows the app's defaultRole; a stored role the app no longer declares; and
 * a role kept from when an app was global, which isn't access.
 */

import { test } from "node:test";
import assert from "node:assert/strict";
import { createElement } from "react";
import { renderToStaticMarkup } from "react-dom/server";
import type { AppManifest } from "@/lib/apps/types";
import { AppAccessPanel, RoleSelect } from "./user-dialog";
import type { UserRow } from "./user-table";

const roles = [
  { key: "editor", label: "Editor" },
  { key: "viewer", label: "Viewer" },
];

const select = (current: string, defaultRole: string | null = "viewer") =>
  renderToStaticMarkup(
    createElement(RoleSelect, {
      userId: "u1",
      slug: "notes",
      appName: "Notes",
      userName: "Alice",
      roles,
      defaultRole,
      current,
      action: () => {},
    }),
  );

/** Each option as [value, label, selected, disabled]. */
function options(html: string): [string, string, boolean, boolean][] {
  return [...html.matchAll(/<option([^>]*)>([^<]*)<\/option>/g)].map(([, attrs, label]) => [
    /value="([^"]*)"/.exec(attrs)?.[1] ?? "",
    label,
    /selected/.test(attrs),
    /disabled/.test(attrs),
  ]);
}

test("Default comes first, names today's default, and is what a person with no role of their own shows", () => {
  assert.deepEqual(options(select("")), [
    ["", "Default (Viewer)", true, false],
    ["editor", "Editor", false, false],
    ["viewer", "Viewer", false, false],
  ]);
  // Choosing Viewer stores Viewer, which stops following the default.
  assert.deepEqual(options(select("viewer")).find(([, , selected]) => selected), ["viewer", "Viewer", true, false]);
  assert.equal(options(select("", null))[0][1], "Default (no role)");
});

test("a stored role the app no longer declares is shown as such, and can't be chosen again", () => {
  assert.deepEqual(options(select("author")), [
    ["", "Default (Viewer)", false, false],
    ["author", "author (no longer declared)", true, true],
    ["editor", "Editor", false, false],
    ["viewer", "Viewer", false, false],
  ]);
});

const notes = {
  slug: "notes",
  name: "Notes",
  description: "Shared notes.",
  global: false,
  roles,
  defaultRole: "viewer",
} as AppManifest;

function user(extra: Partial<UserRow>): UserRow {
  return {
    id: "u1",
    display_name: "Alice",
    email: "alice@example.com",
    is_admin: false,
    grantedSlugs: [],
    grantedActiveCount: 0,
    installedActiveCount: 0,
    roleBySlug: {},
    assignedRoleBySlug: {},
    roleOnlyBySlug: {},
    ...extra,
  };
}

const panel = (row: UserRow) =>
  renderToStaticMarkup(
    createElement(AppAccessPanel, {
      user: row,
      registeredApps: [notes],
      blockedBySlug: {},
      toggleAction: async () => ({ changed: true }),
      setRoleAction: () => {},
    }),
  );

test("a role kept from when the app was global is no grant: Not Granted, and granting keeps the role", () => {
  const html = panel(user({ roleOnlyBySlug: { notes: "editor" } }));
  assert.match(html, />Not Granted</);
  assert.match(html, /Editor role kept from when it was global, with no access\. Granting keeps the role\./);
  assert.match(html, /<input type="hidden" name="role" value="editor"\/>/);
  // No role select: there's no grant to give a role to.
  assert.doesNotMatch(html, /<select/);
});

test("a kept role the app no longer declares isn't sent: granting gives the default", () => {
  const html = panel(user({ roleOnlyBySlug: { notes: "author" } }));
  assert.match(html, /A role kept from when it was global, with no access\. Granting gives the default role\./);
  assert.doesNotMatch(html, /name="role"/);
});

test("someone granted the app on the default shows Default selected", () => {
  const html = panel(
    user({
      grantedSlugs: ["notes"],
      roleBySlug: { notes: "viewer" },
      assignedRoleBySlug: { notes: null },
    }),
  );
  assert.match(html, />Granted</);
  assert.deepEqual(options(html)[0], ["", "Default (Viewer)", true, false]);
});
