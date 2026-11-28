/* This Source Code Form is subject to the terms of the Mozilla Public
 * License, v. 2.0. If a copy of the MPL was not distributed with this
 * file, You can obtain one at https://mozilla.org/MPL/2.0/. */

/**
 * Capabilities on Admin > Apps, rendered on the server: "Asks for more" with
 * what is new and the way to approve it, the review leading with it, and what
 * an admin can turn off.
 */

import { test } from "node:test";
import assert from "node:assert/strict";
import { createElement } from "react";
import { renderToStaticMarkup } from "react-dom/server";
import type { AppManifest } from "@/lib/apps/types";
import type { CapabilityStatus } from "@/lib/apps/capability-approvals";
import AppTile from "./app-tile";
import AppReviewDialog from "./app-review-dialog";
import { CapabilityTogglesPanel } from "./app-details-dialog";

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

const status = (over: Partial<CapabilityStatus> = {}): CapabilityStatus => ({
  added: [{ kind: "egress", capability: "new.example.com" }, { kind: "connector-write", capability: "crm" }],
  pendingSince: "2026-11-28T00:00:00.000Z",
  deniable: [],
  ...over,
});

const tile = (capabilities: CapabilityStatus | null, isActive: boolean) =>
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
        capabilities,
        onRemove: () => {},
      }),
    ),
  );

test("a local app on: Asks for more, what is new, and Approve", () => {
  const words = tile(status(), true);
  assert.match(words, /Asks for more/);
  assert.match(words, /It now asks for more than an admin approved: Reaches new\.example\.com itself Changes data through crm Approve/);
});

test("switched off: activating approves them", () => {
  assert.match(tile(status(), false), /Activating it approves them\./);
});

test("nothing new, nothing shown", () => {
  assert.doesNotMatch(tile(status({ added: [] }), true), /Asks for more/);
  assert.doesNotMatch(tile(null, true), /Asks for more/);
});

test("the review leads with what is new since it was approved", () => {
  const words = text(
    renderToStaticMarkup(
      createElement(AppReviewDialog, {
        app: app({}),
        trust: {
          provenance: "mixos.org · acme/notes · 1.1.0",
          version: "1.1.0",
          commitSha: "a".repeat(40),
          sourceUrl: null,
          modified: false,
          codeHash: null,
          reviewed: false,
          reviewedAt: null,
          reviewedBy: null,
          previouslyReviewed: true,
          reviewNeededSince: null,
        },
        added: status().added,
        open: true,
        onClose: () => {},
      }),
    ),
  );
  assert.match(words, /New since it was approved Reaches new\.example\.com itself Changes data through crm Where it came from/);
});

test("what an admin can turn off, each with its state", () => {
  const words = text(
    renderToStaticMarkup(
      createElement(CapabilityTogglesPanel, {
        slug: "notes",
        capabilities: status({
          added: [],
          deniable: [
            { kind: "egress", capability: "api.example.com", denied: false },
            { kind: "notifications", capability: "", denied: true },
          ],
        }),
      }),
    ),
  );
  assert.match(words, /What you can turn off/);
  assert.match(words, /Reaches api\.example\.com itself Turn off/);
  assert.match(words, /Sends push notifications Off Turn on/);
});
