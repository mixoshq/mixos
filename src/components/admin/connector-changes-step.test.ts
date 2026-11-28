/* This Source Code Form is subject to the terms of the Mozilla Public
 * License, v. 2.0. If a copy of the MPL was not distributed with this
 * file, You can obtain one at https://mozilla.org/MPL/2.0/. */

/**
 * The Configure wizard's step for whether a connector can change data,
 * rendered on the server: which methods it is about, who asked, what Connect
 * asks for once it is allowed, and when the checklist stops at it.
 */

import { test } from "node:test";
import assert from "node:assert/strict";
import { createElement } from "react";
import { renderToStaticMarkup } from "react-dom/server";
import ConnectorConfigureDialog from "./connector-configure-dialog";
import type { ConnectorWithStatus } from "./connector-registry-list";
import { connectorReach } from "@/lib/connectors/reach";

/** The text a reader sees, tags and entities aside. */
const text = (html: string) =>
  html
    .replace(/<[^>]+>/g, " ")
    .replace(/&#x27;|&#39;|&apos;/g, "'")
    .replace(/&amp;/g, "&")
    .replace(/\s+/g, " ")
    .trim();

function connector(over: Partial<ConnectorWithStatus> = {}): ConnectorWithStatus {
  const telemetry = over.telemetry ?? [
    { method: "listDeals", operation: "GET /deals", description: "Listed deals" },
    { method: "createDeal", operation: "POST /deals", description: "Created a deal", mutates: true },
  ];
  const reach = connectorReach({
    connector: { name: "crm", telemetry },
    apps: [{ slug: "pipeline", name: "Pipeline", connectorRequirements: [{ name: "crm", optional: false, access: "write" }] }],
    active: { pipeline: false },
    disabled: false,
    changesAllowed: over.changesAllowed ?? false,
  });
  return {
    name: "crm",
    displayName: "Acme CRM",
    version: "1.4.0",
    description: "A CRM.",
    credentialFields: [{ key: "apiKey", label: "API Key", type: "password" }],
    authors: [],
    lastUpdated: null,
    telemetry: [
      { method: "listDeals", operation: "GET /deals", description: "Listed deals" },
      { method: "createDeal", operation: "POST /deals", description: "Created a deal", mutates: true },
    ],
    auth: { strategy: "apiKey", credentialKeys: ["apiKey"] },
    state: "ready",
    verification: { verifiedAt: null, detail: null, configuredAt: null, configuredBy: null },
    access: { granted: [], grantedKnown: false, log: [] },
    scopeStatus: [],
    dependents: { required: ["Pipeline"], optional: [], writes: ["Pipeline"] },
    reach,
    disabledAt: null,
    replacement: null,
    changesAllowed: false,
    oauth: null,
    ...over,
  } as ConnectorWithStatus;
}

const dialog = (c: ConnectorWithStatus) =>
  text(
    renderToStaticMarkup(
      createElement(ConnectorConfigureDialog, {
        connector: c,
        open: true,
        onClose: () => {},
        initialTab: "configure",
        configureAction: async () => true,
        testAction: async () => ({ ok: true as const, detail: null }),
        changesAction: async () => {},
      }),
    ),
  );

test("an app asking to change data stops the checklist at the step, and says who asked", () => {
  const words = dialog(connector());
  assert.match(words, /Choose whether it can change data/);
  assert.match(words, /Read-only Apps can read, and nothing calls these methods\./);
  assert.match(words, /createDeal Created a deal/);
  assert.doesNotMatch(words, /listDeals Listed deals/, "a read is not what the step is about");
  assert.match(words, /Pipeline asks to change data in Acme CRM, and can't be activated until changes are allowed\./);
  assert.match(words, /Allow changes/);
});

test("allowed, the step says so, and offers the way back to read-only", () => {
  const words = dialog(connector({ changesAllowed: true, verification: { verifiedAt: 1, detail: null, configuredAt: null, configuredBy: null } }));
  // Every step is done, so the summary shows, with a way into the step.
  assert.match(words, /Change access/);
});

test("a connector with no write method has no such step", () => {
  const words = dialog(
    connector({
      telemetry: [{ method: "listDeals", operation: "GET /deals" }],
      dependents: { required: ["Pipeline"], optional: [], writes: [] },
    }),
  );
  assert.doesNotMatch(words, /Choose whether it can change data|Allow changes|Change access/);
});

test("the Details tab lists every method with the operation it calls", () => {
  const words = text(
    renderToStaticMarkup(
      createElement(ConnectorConfigureDialog, {
        connector: connector(),
        open: true,
        onClose: () => {},
        initialTab: "details",
        configureAction: async () => true,
        testAction: async () => ({ ok: true as const, detail: null }),
        changesAction: async () => {},
      }),
    ),
  );
  assert.match(words, /What apps can call Version 1\.4\.0 · 2 methods, 1 of which changes data, off while it is read-only\./);
});
