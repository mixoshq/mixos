/* This Source Code Form is subject to the terms of the Mozilla Public
 * License, v. 2.0. If a copy of the MPL was not distributed with this
 * file, You can obtain one at https://mozilla.org/MPL/2.0/. */

/**
 * A Registry app's tile and review dialog, rendered on the server: the
 * Third-party pill with where it came from, Review in Activate's place until
 * an admin here has reviewed its code, and the declarations a reviewer reads.
 */

import { test } from "node:test";
import assert from "node:assert/strict";
import { createElement } from "react";
import { renderToStaticMarkup } from "react-dom/server";
import type { AppManifest } from "@/lib/apps/types";
import type { AppTrust } from "@/lib/apps/app-review";
import AppTile from "./app-tile";
import AppReviewDialog, { declarationLines } from "./app-review-dialog";

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
    connectorRequirements: [],
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
    search: [],
    mcp: [],
    ...extra,
  };
}

const trust = (over: Partial<AppTrust> = {}): AppTrust => ({
  provenance: "mixos.org · acme/mixos-notes · 1.2.0",
  version: "1.2.0",
  commitSha: "a".repeat(40),
  sourceUrl: `https://github.com/acme/mixos-notes/tree/${"a".repeat(40)}`,
  modified: false,
  codeHash: "sha256-abcdefghijklmnopqrstuvwxyz0123456789ABCDEFG=",
  reviewed: false,
  reviewedAt: null,
  reviewedBy: null,
  previouslyReviewed: false,
  reviewNeededSince: null,
  ...over,
});

const tile = (t: AppTrust | null, isActive = false) =>
  text(
    renderToStaticMarkup(
      createElement(AppTile, {
        app: app({}),
        missingConnectors: [],
        grantCount: 0,
        tableCount: 0,
        isActive,
        returnedChangedAt: null,
        needsGrants: null,
        replacement: null,
        trust: t,
        onRemove: () => {},
      }),
    ),
  );

test("an unreviewed Registry app: Third-party, Unreviewed, and Review in Activate's place", () => {
  const words = tile(trust());
  assert.match(words, /Inactive Third-party Unreviewed/);
  assert.match(words, /From mixos\.org · acme\/mixos-notes · 1\.2\.0\. Nobody here has reviewed its code yet\. Review what it can do, then activate it\./);
  assert.match(words, /Review Details/);
  assert.doesNotMatch(words, /Activate/);
});

test("updated since its review, and switched off for it", () => {
  const words = tile(trust({ previouslyReviewed: true, reviewNeededSince: "2026-11-28T00:00:00.000Z", modified: true }));
  assert.match(words, /Updated, needs review/);
  assert.match(words, /modified locally\. Its code changed since an admin here reviewed it, so it was switched off\./);
});

test("reviewed: Activate is back, and the Third-party pill stays", () => {
  const words = tile(trust({ reviewed: true }));
  assert.match(words, /Third-party/);
  assert.doesNotMatch(words, /Unreviewed|needs review/);
  assert.match(words, /Activate Details/);
});

test("a local app shows nothing new", () => {
  const words = tile(null, true);
  assert.doesNotMatch(words, /Third-party|Unreviewed|Review /);
  assert.match(words, /Deactivate Details/);
});

test("the review lists everything the manifest lets it do", () => {
  const lines = declarationLines(
    app({
      global: true,
      connectorRequirements: [
        { name: "crm", optional: false, access: "write", version: "1.0.0" },
        { name: "maps", optional: true, access: "read", version: "1.0.0" },
      ],
      egress: ["api.example.com"],
      database: true,
      env: [{ key: "REGION", label: "Region", type: "text" }],
      notifications: true,
      mcp: [{ name: "find" } as AppManifest["mcp"][number]],
      consumes: [{ app: "files", service: "list" }],
      escapes: [{ rule: "raw-response", reason: "Streams a CSV." }],
    }),
  );
  assert.deepEqual(lines, [
    "Everyone on this instance gets it, without a grant.",
    "Calls the crm connector, and asks to change data in it.",
    "Calls the maps connector, reading only (optional).",
    "Reaches these hosts itself: api.example.com.",
    "Has tables of its own, in its own schema, reached as its own database role.",
    "Reads a setting an admin fills in: REGION.",
    "Sends push notifications to people who have it.",
    "Answers an MCP tool, read-only.",
    "Asks other apps' services: files (list).",
    "Declares the escape raw-response: Streams a CSV.",
  ]);
  assert.deepEqual(declarationLines(app({})), ["Declares nothing beyond its own pages and widgets."]);
});

test("the dialog: where from, the source at its commit, a local modification, and migrations already run", () => {
  const html = renderToStaticMarkup(
    createElement(AppReviewDialog, { app: app({ database: true }), trust: trust({ modified: true }), open: true, onClose: () => {} }),
  );
  const words = text(html);
  assert.match(words, /Review Notes/);
  assert.match(words, /mixos\.org · acme\/mixos-notes · 1\.2\.0 Third-party Modified locally/);
  assert.match(html, /href="https:\/\/github\.com\/acme\/mixos-notes\/tree\/a{40}"/);
  assert.match(words, /what runs here isn't the release as published/);
  assert.match(words, /Its database migrations have already run/);
  assert.match(words, /Record my review/);
});
