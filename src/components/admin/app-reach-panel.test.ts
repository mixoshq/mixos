/* This Source Code Form is subject to the terms of the Mozilla Public
 * License, v. 2.0. If a copy of the MPL was not distributed with this
 * file, You can obtain one at https://mozilla.org/MPL/2.0/. */

/**
 * The app dialog's Reach tab, rendered on the server: the hosts an app's own
 * code may call, from its `egress`, under its connectors, and the empty state
 * for an app that declares none.
 */

import { test } from "node:test";
import assert from "node:assert/strict";
import { createElement } from "react";
import { renderToStaticMarkup } from "react-dom/server";
import type { AppManifest } from "@/lib/apps/types";
import { AppReachPanel } from "./app-details-dialog";

/** The text a reader sees, tags and entities aside. */
const text = (html: string) =>
  html
    .replace(/<[^>]+>/g, " ")
    .replace(/&#x27;|&#39;/g, "'")
    .replace(/&amp;/g, "&")
    .replace(/\s+/g, " ")
    .trim();

function app(extra: Partial<AppManifest>): AppManifest {
  return {
    slug: "notes",
    name: "Notes",
    description: "",
    tagline: null,
    icon: "notebook",
    connectors: [],
    optionalConnectors: [],
    database: false,
    updatedAt: [],
    notifications: false,
    hasPages: true,
    pageCount: 1,
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
    ...extra,
  };
}

const reach = (manifest: AppManifest) =>
  renderToStaticMarkup(createElement(AppReachPanel, { app: manifest, missingConnectors: [] }));

test("an app declaring egress lists each host, in mono, under Network", () => {
  const html = reach(app({ egress: ["api.example.com", "files.example.net"] }));
  const words = text(html);
  assert.match(words, /Connectors This app calls no connector/);
  assert.match(words, /Network The only hosts this app's own code can call\. Each request, and each redirect, is checked against this list\./);
  for (const host of ["api.example.com", "files.example.net"]) {
    assert.ok(html.includes(`font-mono text-xs">${host}</code>`), `${host} isn't listed in mono`);
  }
  assert.doesNotMatch(words, /makes no outbound calls/);
  assert.doesNotMatch(words, /one level of subdomain/);
});

test("a wildcard entry says what it covers", () => {
  const words = text(reach(app({ egress: ["*.example.com"] })));
  assert.match(words, /An entry starting with \*\. covers one level of subdomain under the name after it, and not that name itself\./);
});

test("an app declaring no egress says it reaches outside services only through its connectors", () => {
  const words = text(reach(app({ connectors: ["crm"] })));
  assert.match(words, /Network This app makes no outbound calls of its own\. It reaches outside services only through its connectors\./);
  assert.match(words, /Connectors crm/);
});
