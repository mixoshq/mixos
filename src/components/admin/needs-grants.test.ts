/* This Source Code Form is subject to the terms of the Mozilla Public
 * License, v. 2.0. If a copy of the MPL was not distributed with this
 * file, You can obtain one at https://mozilla.org/MPL/2.0/. */

/**
 * The Needs grants mark, rendered on the server: an app's tile and the Access
 * tab's banner, worded for why people lost the app, and nothing when nobody
 * did.
 */

import { test } from "node:test";
import assert from "node:assert/strict";
import { createElement } from "react";
import { renderToStaticMarkup } from "react-dom/server";
import type { NeedsGrants } from "@/lib/apps/access";
import type { AppManifest } from "@/lib/apps/types";
import AppTile from "./app-tile";
import { NeedsGrantsBanner } from "./app-access-panel";

/** The text a reader sees, tags and entities aside. */
const text = (html: string) =>
  html
    .replace(/<[^>]+>/g, " ")
    .replace(/&#x27;|&#39;/g, "'")
    .replace(/&amp;/g, "&")
    .replace(/\s+/g, " ")
    .replace(/ ([.,;])/g, "$1")
    .trim();

const app: AppManifest = {
  slug: "team",
  name: "Team",
  description: "",
  tagline: null,
  icon: "box",
  connectors: [],
  optionalConnectors: [],
  database: false,
  updatedAt: [],
  notifications: false,
  hasPages: false,
  pageCount: 0,
  global: false,
  roles: [],
  defaultRole: null,
  hookCounts: { actions: 0, filters: 0 },
  hooks: { emits: { actions: [], filters: [] }, listens: { actions: [], filters: [] } },
  authors: [],
  keywords: [],
  screenshots: [],
  license: null,
  appUrl: null,
  appSupportUrl: null,
  lastUpdated: null,
  escapes: [],
  env: [],
  egress: [],
  sync: [],
  routes: [],
  widgets: [],
  schedules: [],
  telemetry: [],
  provides: [],
  consumes: [],
  emits: [],
  listensTo: [],
  branding: null,
  mcp: [],
};

const tile = (needsGrants: NeedsGrants | null) =>
  text(
    renderToStaticMarkup(
      createElement(AppTile, {
        app,
        missingConnectors: [],
        grantCount: 1,
        tableCount: 0,
        isActive: true,
        returnedChangedAt: null,
        needsGrants,
        replacement: null,
        onRemove: () => {},
      }),
    ),
  );

const since = "2026-10-15T12:00:00.000Z";

test("a tile says the app needs grants because it stopped being global", () => {
  const words = tile({ since, reason: "global-ended" });
  assert.match(words, /Needs grants/);
  assert.match(
    words,
    /This app isn't global any more, so only the people granted it have it\. People who had it without a grant don't now; their roles were kept, and give no access\. Grant it from its Access tab, under Details\./,
  );
});

test("a tile says the app needs grants because roles from before were only roles", () => {
  const words = tile({ since, reason: "roles-decided" });
  assert.match(words, /Needs grants/);
  assert.match(
    words,
    /Some people had this app through a role and no grant\. A role isn't access, so they don't have it now; their roles were kept\. Grant it from its Access tab, under Details\./,
  );
  assert.doesNotMatch(words, /global/);
});

test("a tile nobody lost says nothing about grants", () => {
  const words = tile(null);
  assert.doesNotMatch(words, /Needs grants|granted it have it|through a role/);
});

test("the Access tab's banner, for each reason", () => {
  const banner = (needsGrants: NeedsGrants, roleOnly: number) =>
    text(renderToStaticMarkup(createElement(NeedsGrantsBanner, { appName: "Team", needsGrants, roleOnly })));
  assert.equal(
    banner({ since, reason: "global-ended" }, 2),
    "Team isn't global any more, so only the people granted it have it. 2 people have a role from before, listed below, and no access.",
  );
  assert.equal(
    banner({ since, reason: "roles-decided" }, 1),
    "Some people had Team through a role and no grant. A role isn't access, so they don't have it now. One person has a role from before, listed below, and no access.",
  );
});
