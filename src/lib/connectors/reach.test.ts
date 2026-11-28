/* This Source Code Form is subject to the terms of the Mozilla Public
 * License, v. 2.0. If a copy of the MPL was not distributed with this
 * file, You can obtain one at https://mozilla.org/MPL/2.0/. */

/**
 * What each app can reach on a connector, as Admin → Connectors shows it: the
 * same two keys the app's facade holds a write to, the app's switch, and the
 * connector's.
 */

import { test } from "node:test";
import assert from "node:assert/strict";
import { connectorReach, describeAppReach, describeReach, type ReachApp } from "./reach";
import type { ConnectorTelemetryDefinition } from "./types";

const METHODS: ConnectorTelemetryDefinition[] = [
  { method: "listDeals", operation: "GET /deals" },
  { method: "getDeal", operation: "GET /deals/{id}" },
  { method: "createDeal", operation: "POST /deals", mutates: true },
];
const CRM = { name: "crm", telemetry: METHODS };

const app = (
  slug: string,
  access: "read" | "write",
  { optional = false, connector = "crm" }: { optional?: boolean; connector?: string } = {},
): ReachApp => ({
  slug,
  name: slug[0].toUpperCase() + slug.slice(1),
  connectorRequirements: [{ name: connector, optional, access }],
});

const APPS = [
  app("pipeline", "write"),
  app("reports", "read", { optional: true }),
  app("archive", "write"),
  app("notes", "read", { connector: "other" }),
];
const ALL_ACTIVE = { pipeline: true, reports: true, archive: true, notes: true };

test("only the apps that declare it, required or optional, each with every declared read", () => {
  const reach = connectorReach({ connector: CRM, apps: APPS, active: ALL_ACTIVE, disabled: false, changesAllowed: false });
  assert.deepEqual(
    reach.apps.map((a) => [a.slug, a.optional]),
    [
      ["archive", false],
      ["pipeline", false],
      ["reports", true],
    ],
  );
  for (const a of reach.apps) assert.deepEqual(a.reads, ["listDeals", "getDeal"]);
});

test("a write takes both keys: the app asks for it, and an admin allows changes", () => {
  const off = connectorReach({ connector: CRM, apps: APPS, active: ALL_ACTIVE, disabled: false, changesAllowed: false });
  const byOff = new Map(off.apps.map((a) => [a.slug, a]));
  assert.equal(byOff.get("pipeline")?.write, "read-only");
  assert.deepEqual(byOff.get("pipeline")?.writes, []);
  assert.equal(byOff.get("pipeline")?.canWriteNow, false);
  assert.equal(byOff.get("reports")?.write, "not-asked");
  assert.equal(off.canWriteCount, 0);

  const on = connectorReach({ connector: CRM, apps: APPS, active: ALL_ACTIVE, disabled: false, changesAllowed: true });
  const byOn = new Map(on.apps.map((a) => [a.slug, a]));
  assert.equal(byOn.get("pipeline")?.write, "allowed");
  assert.deepEqual(byOn.get("pipeline")?.writes, ["createDeal"]);
  assert.equal(byOn.get("pipeline")?.canWriteNow, true);
  // Allowing changes gives nothing to an app that didn't ask.
  assert.equal(byOn.get("reports")?.write, "not-asked");
  assert.deepEqual(byOn.get("reports")?.writes, []);
  assert.equal(byOn.get("reports")?.canWriteNow, false);
  assert.equal(on.canWriteCount, 2);
});

test("an inactive app keeps what activating it would hand it, comes last, and can't write now", () => {
  const reach = connectorReach({
    connector: CRM,
    apps: APPS,
    active: { pipeline: true, reports: true, archive: false },
    disabled: false,
    changesAllowed: true,
  });
  assert.deepEqual(
    reach.apps.map((a) => [a.slug, a.active]),
    [
      ["pipeline", true],
      ["reports", true],
      ["archive", false],
    ],
  );
  const archive = reach.apps[2];
  assert.deepEqual(archive.writes, ["createDeal"]);
  assert.equal(archive.canWriteNow, false);
  assert.equal(reach.runningCount, 2);
  assert.equal(reach.canWriteCount, 1);
  assert.equal(describeReach(reach), "Used by 2 active apps · 1 can change data");
});

test("an app with no row is inactive, as the app gate reads it", () => {
  const reach = connectorReach({ connector: CRM, apps: APPS, active: {}, disabled: false, changesAllowed: true });
  assert.ok(reach.apps.every((a) => a.active === false && !a.canWriteNow));
  assert.equal(describeReach(reach), "Declared by 3 apps, none of them active");
});

test("when the switches can't be read, every app counts as running: never less reach than there is", () => {
  const reach = connectorReach({ connector: CRM, apps: APPS, active: null, disabled: false, changesAllowed: true });
  assert.equal(reach.activityKnown, false);
  assert.ok(reach.apps.every((a) => a.active === null));
  assert.equal(reach.runningCount, 3);
  assert.equal(reach.canWriteCount, 2);
  assert.equal(describeReach(reach), "Used by 3 apps · 2 can change data");
});

test("a disabled connector: nothing can change data through it", () => {
  const reach = connectorReach({ connector: CRM, apps: APPS, active: ALL_ACTIVE, disabled: true, changesAllowed: true });
  assert.equal(reach.canWriteCount, 0);
  assert.ok(reach.apps.every((a) => !a.canWriteNow));
  assert.equal(describeReach(reach), "Used by 3 active apps · none can change data");
});

test("a connector with no write: nothing to allow, and the tile doesn't count writers", () => {
  const reads = { name: "crm", telemetry: METHODS.filter((m) => !m.mutates) };
  const reach = connectorReach({ connector: reads, apps: APPS, active: ALL_ACTIVE, disabled: false, changesAllowed: true });
  assert.ok(reach.apps.every((a) => a.write === "none" && a.writes.length === 0 && !a.canWriteNow));
  assert.equal(reach.declaresWrites, false);
  assert.equal(describeReach(reach), "Used by 3 active apps");
  assert.equal(describeAppReach(reach.apps[0], 0), "Can call 2 methods, none of which changes data.");
});

test("no app declares it: the tile says nothing", () => {
  const reach = connectorReach({ connector: CRM, apps: [app("notes", "read", { connector: "other" })], active: ALL_ACTIVE, disabled: false, changesAllowed: false });
  assert.deepEqual(reach.apps, []);
  assert.equal(describeReach(reach), null);
});

test("each row says what the app may call, and why a write is out of reach", () => {
  const off = connectorReach({ connector: CRM, apps: APPS, active: ALL_ACTIVE, disabled: false, changesAllowed: false });
  const on = connectorReach({ connector: CRM, apps: APPS, active: ALL_ACTIVE, disabled: false, changesAllowed: true });
  const row = (r: typeof off, slug: string) => describeAppReach(r.apps.find((a) => a.slug === slug)!, 1);
  assert.equal(row(on, "pipeline"), "Can call 3 methods, 1 of which changes data.");
  assert.equal(
    row(off, "pipeline"),
    "Can call 2 methods that read. It asks to change data, and the method that changes data is off while this connector is read-only.",
  );
  assert.equal(
    row(on, "reports"),
    "Can call 2 methods that read. It doesn't ask to change data, so the method that changes data is refused.",
  );
  const many = { name: "crm", telemetry: [METHODS[0], { ...METHODS[2] }, { method: "deleteDeal", operation: "DELETE /deals/{id}", mutates: true }] };
  const one = connectorReach({ connector: many, apps: [app("reports", "read")], active: ALL_ACTIVE, disabled: false, changesAllowed: true });
  assert.equal(
    describeAppReach(one.apps[0], 2),
    "Can call 1 method that reads. It doesn't ask to change data, so the 2 methods that change data are refused.",
  );
});

test("an admin's limit only narrows: writes taken away, or a list of methods", () => {
  const denied = connectorReach({
    connector: CRM,
    apps: APPS,
    active: ALL_ACTIVE,
    disabled: false,
    changesAllowed: true,
    narrowings: { pipeline: { writes: "deny", methods: null } },
  });
  const pipeline = denied.apps.find((a) => a.slug === "pipeline")!;
  assert.equal(pipeline.write, "denied");
  assert.deepEqual(pipeline.writes, []);
  assert.equal(pipeline.canWriteNow, false);
  assert.equal(
    describeAppReach(pipeline, 1),
    "Can call 2 methods that read. It asks to change data, and an admin took its writes away here.",
  );
  // Archive, unlimited, still writes.
  assert.equal(denied.apps.find((a) => a.slug === "archive")!.canWriteNow, true);

  const listed = connectorReach({
    connector: CRM,
    apps: APPS,
    active: ALL_ACTIVE,
    disabled: false,
    changesAllowed: true,
    narrowings: { pipeline: { writes: "inherit", methods: ["listDeals", "createDeal"] } },
  });
  const limited = listed.apps.find((a) => a.slug === "pipeline")!;
  assert.deepEqual(limited.reads, ["listDeals"]);
  assert.deepEqual(limited.writes, ["createDeal"]);
  assert.match(describeAppReach(limited, 1), /An admin limited it to those\.$/);

  // A limit with no write in it: no write, though it asks and changes are allowed.
  const readsOnly = connectorReach({
    connector: CRM,
    apps: APPS,
    active: ALL_ACTIVE,
    disabled: false,
    changesAllowed: true,
    narrowings: { pipeline: { writes: "inherit", methods: ["getDeal"] } },
  }).apps.find((a) => a.slug === "pipeline")!;
  assert.equal(readsOnly.canWriteNow, false);
  assert.deepEqual([readsOnly.reads, readsOnly.writes], [["getDeal"], []]);
});
