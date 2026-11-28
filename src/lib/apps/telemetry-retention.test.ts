/* This Source Code Form is subject to the terms of the Mozilla Public
 * License, v. 2.0. If a copy of the MPL was not distributed with this
 * file, You can obtain one at https://mozilla.org/MPL/2.0/. */

/** MIXOS_CONNECTOR_TELEMETRY_DAYS, read (./telemetry-retention.ts). */

import { test } from "node:test";
import assert from "node:assert/strict";
import {
  CONNECTOR_TELEMETRY_DAYS_SETTING,
  CONNECTOR_TELEMETRY_MIN_DAYS,
  connectorTelemetryCutoff,
  connectorTelemetryProblem,
  parseConnectorTelemetryDays,
} from "./telemetry-retention";
import { WRITE_EXPIRY_DAYS } from "./capability-approvals";

test("unset or empty, connector calls are kept for 90 days", () => {
  for (const raw of [undefined, "", "  "]) {
    assert.deepEqual(parseConnectorTelemetryDays(raw), { days: 90, problem: null });
  }
});

test("a whole number of days at least 90 is kept as given, with no upper limit", () => {
  assert.deepEqual(parseConnectorTelemetryDays("90"), { days: 90, problem: null });
  assert.deepEqual(parseConnectorTelemetryDays(" 365 "), { days: 365, problem: null });
  assert.deepEqual(parseConnectorTelemetryDays("0090"), { days: 90, problem: null });
  assert.equal(parseConnectorTelemetryDays("36500000").days, 36_500_000);
  assert.equal(parseConnectorTelemetryDays("9".repeat(400)).days, Infinity);
});

test("0 keeps every connector call, as before", () => {
  assert.deepEqual(parseConnectorTelemetryDays("0"), { days: null, problem: null });
  assert.deepEqual(parseConnectorTelemetryDays("000"), { days: null, problem: null });
});

test("below 90 counts as 90, and says why", () => {
  for (const raw of ["1", "30", "89"]) {
    const r = parseConnectorTelemetryDays(raw);
    assert.equal(r.days, 90, raw);
    assert.match(r.problem ?? "", /is under 90, so connector calls are kept for 90 days/);
  }
});

test("a value that isn't a whole number deletes nothing, and says so", () => {
  for (const raw of ["365d", "-1", "30.5", "1e3", "forever", "ninety"]) {
    const r = parseConnectorTelemetryDays(raw);
    assert.equal(r.days, null, raw);
    assert.match(r.problem ?? "", /is not a whole number of days, so no connector calls are deleted/);
  }
});

test("the floor is never under write expiry, which these rows decide", () => {
  assert.ok(CONNECTOR_TELEMETRY_MIN_DAYS >= WRITE_EXPIRY_DAYS);
});

test("the cutoff: days before now, and none when nothing is deleted or nothing is that old", () => {
  const now = Date.UTC(2026, 10, 28);
  assert.equal(connectorTelemetryCutoff(90, now)?.toISOString(), "2026-08-30T00:00:00.000Z");
  assert.equal(connectorTelemetryCutoff(null, now), null);
  assert.equal(connectorTelemetryCutoff(36_500_000, now), null);
  assert.equal(connectorTelemetryCutoff(Infinity, now), null);
});

test("the release step and the admin page read the problem from the environment", () => {
  const before = process.env[CONNECTOR_TELEMETRY_DAYS_SETTING];
  try {
    process.env[CONNECTOR_TELEMETRY_DAYS_SETTING] = "30";
    assert.match(connectorTelemetryProblem() ?? "", /^MIXOS_CONNECTOR_TELEMETRY_DAYS=30 is under 90/);
    process.env[CONNECTOR_TELEMETRY_DAYS_SETTING] = "180";
    assert.equal(connectorTelemetryProblem(), null);
  } finally {
    if (before === undefined) delete process.env[CONNECTOR_TELEMETRY_DAYS_SETTING];
    else process.env[CONNECTOR_TELEMETRY_DAYS_SETTING] = before;
  }
});
