/* This Source Code Form is subject to the terms of the Mozilla Public
 * License, v. 2.0. If a copy of the MPL was not distributed with this
 * file, You can obtain one at https://mozilla.org/MPL/2.0/. */

/**
 * What an app asks for, as a set: reordering is no change, only something new
 * is growth, and each capability reads in words.
 */

import { test } from "node:test";
import assert from "node:assert/strict";
import { DENIABLE, addedCapabilities, appCapabilities, capabilityKey, describeCapability } from "./capabilities";
import type { AppManifest } from "./types";

const base = {
  global: false,
  egress: ["api.example.com", "*.cdn.example.com"],
  connectorRequirements: [
    { name: "crm", optional: false, access: "write" as const, version: "1.0.0" },
    { name: "maps", optional: true, access: "read" as const, version: "1.0.0" },
  ],
  consumes: [{ app: "files", service: "list" }],
  provides: [{ name: "summary" }],
  listensTo: [{ app: "files", hook: "file-added" }],
  mcp: [{ name: "find" }],
  search: [{ name: "notes" }],
  notifications: true,
  database: true,
  schedules: [{ name: "sweep" }],
  routes: [
    { path: "a", params: [], methods: [{ method: "GET", auth: ["session", "public"] }] },
    { path: "b", params: [], methods: [{ method: "POST", auth: ["key"] }] },
  ],
  branding: { hooks: ["brand-name"], reason: "x" },
} as unknown as Partial<AppManifest>;

test("every kind the plan names, keyed and sorted", () => {
  assert.deepEqual(appCapabilities(base).map(capabilityKey), [
    "connector-write:crm",
    "connector:crm",
    "consumes:files/list",
    "database:",
    "egress:*.cdn.example.com",
    "egress:api.example.com",
    "listens:files/file-added",
    "mcp:find",
    "notifications:",
    "optional-connector:maps",
    "provides:summary",
    "route-tier:key",
    "route-tier:public",
    "schedule:sweep",
    "search:notes",
    "branding:brand-name",
  ].sort((a, b) => a.localeCompare(b)));
});

test("reordering is no change; something new is the only growth", () => {
  const reordered = {
    ...base,
    egress: [...(base.egress ?? [])].reverse(),
    connectorRequirements: [...(base.connectorRequirements ?? [])].reverse(),
  };
  const approved = new Set(appCapabilities(base).map(capabilityKey));
  assert.deepEqual(addedCapabilities(appCapabilities(reordered), approved), []);
  const grown = { ...base, egress: [...(base.egress ?? []), "evil.example.org"], global: true };
  assert.deepEqual(addedCapabilities(appCapabilities(grown), approved).map(capabilityKey), [
    "egress:evil.example.org",
    "global:",
  ]);
  // Less is no growth.
  assert.deepEqual(addedCapabilities(appCapabilities({ ...base, mcp: [] }), approved), []);
});

test("only the kinds an app runs without can be turned off", () => {
  assert.deepEqual([...DENIABLE].sort(), ["consumes", "egress", "notifications", "optional-connector"]);
});

test("each in words", () => {
  const words = appCapabilities(base).map(describeCapability);
  assert.ok(words.includes("Changes data through crm"));
  assert.ok(words.includes("Reaches api.example.com itself"));
  assert.ok(words.includes("Asks files's list service"));
  assert.ok(words.includes("Has routes anyone can call, signed in or not"));
  assert.ok(words.includes("Changes the install's brand name"));
  assert.equal(describeCapability({ kind: "global", capability: "" }), "Everyone gets it, without a grant");
});
