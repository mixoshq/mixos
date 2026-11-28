/* This Source Code Form is subject to the terms of the Mozilla Public
 * License, v. 2.0. If a copy of the MPL was not distributed with this
 * file, You can obtain one at https://mozilla.org/MPL/2.0/. */

/**
 * What detection raises, as Admin > Apps shows it: each kind in words, the
 * tile's Unusual activity strip with its two actions, and a route's budget
 * telling detection of the call it refused.
 */

import { test } from "node:test";
import assert from "node:assert/strict";
import { createElement } from "react";
import { renderToStaticMarkup } from "react-dom/server";
import type { AppManifest } from "@/lib/apps/types";
import { describeAnomaly, type Anomaly } from "@/lib/apps/anomaly";
import { withConnectorBudget } from "@/lib/apps/route";
import type { BaseConnector } from "@/lib/connectors/types";
import AppTile from "./app-tile";

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

const anomaly = (kind: Anomaly["kind"], subject: string, over: Partial<Anomaly> = {}): Anomaly => ({
  id: `${kind}-${subject}`,
  kind,
  subject,
  detail: {},
  firstSeenAt: "2026-11-28T00:00:00.000Z",
  lastSeenAt: "2026-11-28T00:00:00.000Z",
  count: 1,
  ...over,
});

test("each kind, in a line an admin can act on", () => {
  assert.equal(describeAnomaly(anomaly("new-write", "crm.deleteDeal")), "First call to crm.deleteDeal, which changes data.");
  assert.equal(
    describeAnomaly(anomaly("new-host", "img.cdn.example.com")),
    "First contact with img.cdn.example.com, which its egress allows only through a wildcard.",
  );
  assert.equal(
    describeAnomaly(anomaly("refused", "connector:crm.deleteDeal:write-not-asked", { count: 4 })),
    "Called crm.deleteDeal, refused 4 times (a write its manifest doesn't ask for).",
  );
  assert.equal(
    describeAnomaly(anomaly("refused", "egress:169.254.169.254:address")),
    "Tried to reach 169.254.169.254, refused once (a private address).",
  );
  assert.equal(
    describeAnomaly(anomaly("spike", "2026-11-28T01", { detail: { lastHour: 1200, hourlyMean: 31.4 } })),
    "1,200 calls in an hour, against about 31 an hour in the week before.",
  );
  assert.match(describeAnomaly(anomaly("too-many-subjects", "subjects")), /More distinct methods and hosts/);
});

const tile = (anomalies: Anomaly[], isActive = true) =>
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
        anomalies,
        onRemove: () => {},
      }),
    ),
  );

test("the tile: Unusual activity, the first three, Deactivate and Mark as expected", () => {
  const four = [
    anomaly("new-write", "crm.deleteDeal"),
    anomaly("refused", "egress:evil.example.org:host"),
    anomaly("new-host", "a.cdn.example.com"),
    anomaly("new-host", "b.cdn.example.com"),
  ];
  const words = tile(four);
  assert.match(words, /Unusual activity/);
  assert.match(words, /First call to crm\.deleteDeal, which changes data\./);
  assert.match(words, /And 1 more\./);
  assert.doesNotMatch(words, /b\.cdn\.example\.com/);
  assert.match(words, /Deactivate Mark as expected/);
  // Already off: nothing to deactivate, and still something to mark.
  const off = tile(four, false);
  assert.match(off, /Mark as expected/);
  assert.doesNotMatch(off, /Deactivate Mark/);
});

test("no anomalies, no strip", () => {
  assert.doesNotMatch(tile([]), /Unusual activity|Mark as expected/);
});

test("a route's connector budget tells detection of the call it refused", async () => {
  const refused: string[] = [];
  const connector = { name: "crm", configured: true, listDeals: async () => [] } as unknown as BaseConnector;
  const wrapped = withConnectorBudget({ crm: connector }, 1, "notes GET /x", (c, m) => refused.push(`${c}.${m}`));
  const crm = wrapped.crm as unknown as { listDeals: () => Promise<unknown> };
  await crm.listDeals();
  assert.throws(() => crm.listDeals(), /exceeded its connector-call budget of 1/);
  assert.deepEqual(refused, ["crm.listDeals"]);
});
