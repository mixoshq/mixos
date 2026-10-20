/* This Source Code Form is subject to the terms of the Mozilla Public
 * License, v. 2.0. If a copy of the MPL was not distributed with this
 * file, You can obtain one at https://mozilla.org/MPL/2.0/. */

/**
 * The app dialog's MCP tab reads its switches when it is shown, not once per
 * page: the dialog unmounts its panels when it closes, and the tab holds the
 * switches itself, so each opening starts from "not read yet" and reads them.
 * Rendered on the server, where nothing has been read.
 */

import { test } from "node:test";
import assert from "node:assert/strict";
import { createElement } from "react";
import { renderToStaticMarkup } from "react-dom/server";
import type { AppManifest } from "@/lib/apps/types";
import AppDetailsDialog, { McpToolsPanel } from "./app-details-dialog";

const app: AppManifest = {
  slug: "ledger",
  name: "Ledger",
  description: "",
  tagline: null,
  icon: "book",
  connectors: [],
  optionalConnectors: [],
  connectorRequirements: [],
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
  mcp: [
    { name: "peek", description: "Peek at the ledger.", sources: ["mixos"] },
    { name: "poke", description: "Poke the ledger.", sources: ["mixos"] },
  ],
};

test("closed, the dialog renders none of its panels, so none keeps what it read", () => {
  const html = renderToStaticMarkup(
    createElement(AppDetailsDialog, {
      app,
      missingConnectors: [],
      isActive: true,
      grantCount: 0,
      open: false,
      onClose: () => {},
    }),
  );
  assert.equal(html, "");
});

test("the tab starts from unknown: no switch, and a count of tools rather than of enabled ones", () => {
  const html = renderToStaticMarkup(createElement(McpToolsPanel, { app }));
  assert.match(html, /MCP tools — 2 tools/);
  assert.doesNotMatch(html, /enabled/);
  assert.doesNotMatch(html, /role="switch"/);
  assert.match(html, /ledger__peek/);
});
