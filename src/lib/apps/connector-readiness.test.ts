/* This Source Code Form is subject to the terms of the Mozilla Public
 * License, v. 2.0. If a copy of the MPL was not distributed with this
 * file, You can obtain one at https://mozilla.org/MPL/2.0/. */

/**
 * The words for a connector that keeps an app from being activated or granted:
 * what to do about each, grouped, and the Connector Registry's labels.
 */

import { test } from "node:test";
import assert from "node:assert/strict";
import {
  BLOCK_LABEL,
  blockDone,
  conjoin,
  groupByBlock,
  missingConnectorSteps,
  type ConnectorBlock,
  type MissingConnector,
} from "./connector-readiness";

const c = (displayName: string, state: ConnectorBlock): MissingConnector => ({
  name: displayName.toLowerCase().replace(/\s+/g, "-"),
  displayName,
  state,
});

test("one unconfigured connector reads as it always did", () => {
  assert.equal(missingConnectorSteps([c("Acme CRM", "unconfigured")]), "Configure Acme CRM");
  assert.equal(
    `${missingConnectorSteps([c("Acme CRM", "unconfigured")])} before activating this app.`,
    "Configure Acme CRM before activating this app.",
  );
});

test("each state says what to do about it, grouped, in the order they first appear", () => {
  assert.equal(missingConnectorSteps([c("Google Drive", "needs-authorization")]), "Connect Google Drive");
  assert.equal(missingConnectorSteps([c("Slack", "disabled")]), "Enable Slack");
  assert.equal(missingConnectorSteps([c("Google Sheets", "read-only")]), "Allow changes in Google Sheets");
  assert.equal(
    missingConnectorSteps([c("Gong", "unconfigured"), c("Google Sheets", "read-only")]),
    "Configure Gong and allow changes in Google Sheets",
  );
  assert.equal(
    missingConnectorSteps([c("Gong", "unconfigured"), c("Google Drive", "needs-authorization"), c("Slack", "disabled")]),
    "Configure Gong, connect Google Drive and enable Slack",
  );
  // Two names in one clause: a comma before the next, so "and" never joins two lists.
  assert.equal(
    missingConnectorSteps([c("Gong", "unconfigured"), c("Slack", "disabled"), c("Acme", "unconfigured")]),
    "Configure Gong and Acme, and enable Slack",
  );
  assert.equal(
    missingConnectorSteps([c("A", "disabled"), c("B", "disabled"), c("C", "disabled")]),
    "Enable A, B and C",
  );
});

test("the labels are the Connector Registry's, and the participles finish the sentence", () => {
  assert.deepEqual(BLOCK_LABEL, {
    unconfigured: "Not configured",
    "needs-authorization": "Needs authorization",
    disabled: "Disabled",
    "read-only": "Read-only",
  });
  assert.deepEqual(
    (["unconfigured", "needs-authorization", "disabled", "read-only"] as const).map(blockDone),
    ["configured", "connected", "enabled", "allowed to change data"],
  );
  assert.deepEqual(
    groupByBlock([c("A", "disabled"), c("B", "unconfigured"), c("C", "disabled")]).map(([s, g]) => [
      s,
      g.map((m) => m.displayName),
    ]),
    [
      ["disabled", ["A", "C"]],
      ["unconfigured", ["B"]],
    ],
  );
  assert.equal(conjoin([]), "");
  assert.equal(conjoin(["A"]), "A");
  assert.equal(conjoin(["A", "B"]), "A and B");
});
