/* This Source Code Form is subject to the terms of the Mozilla Public
 * License, v. 2.0. If a copy of the MPL was not distributed with this
 * file, You can obtain one at https://mozilla.org/MPL/2.0/. */

import { after, before, test } from "node:test";
import assert from "node:assert/strict";
import { randomBytes } from "node:crypto";
import { decrypt } from "@/lib/connectors/encryption";
import { describeAppSettings, encodeAppSetting } from "./env";
import type { AppEnvField } from "./types";

// ── fixtures ────────────────────────────────────────────────────────────────

const KEY_VAR = "APP_SETTINGS_ENCRYPTION_KEY";
const key = randomBytes(32);
let previous: string | undefined;

before(() => {
  previous = process.env[KEY_VAR];
  process.env[KEY_VAR] = key.toString("hex");
});
after(() => {
  if (previous === undefined) delete process.env[KEY_VAR];
  else process.env[KEY_VAR] = previous;
});

const webhook: AppEnvField = { key: "WEBHOOK_URL", label: "Webhook URL", type: "text", required: true };
const token: AppEnvField = { key: "API_TOKEN", label: "API token", type: "password" };

const saved = "2026-10-07T09:30:00.000Z";

// ── what is stored ──────────────────────────────────────────────────────────

test("a password value is encrypted before it is stored, under the app-settings key", () => {
  const stored = encodeAppSetting(token, "s3cret-token");
  assert.equal(stored.encrypted, true);
  assert.notEqual(stored.value, "s3cret-token");
  assert.ok(!stored.value.includes("s3cret-token"));
  assert.equal(decrypt(stored.value, key), "s3cret-token");
});

test("a text value is stored as written", () => {
  assert.deepEqual(encodeAppSetting(webhook, "https://hooks.example.com/x"), {
    value: "https://hooks.example.com/x",
    encrypted: false,
  });
});

// ── what an admin is shown ──────────────────────────────────────────────────

test("a password setting shows as set, and its value never leaves the server", () => {
  const [status] = describeAppSettings(
    [token],
    [{ key: "API_TOKEN", value: encodeAppSetting(token, "s3cret").value, encrypted: true, updated_at: saved }],
  );
  assert.deepEqual(status, {
    key: "API_TOKEN",
    label: "API token",
    type: "password",
    required: false,
    set: true,
    value: null,
    updatedAt: saved,
  });
});

test("a text setting shows its stored value; an unset one shows nothing", () => {
  const statuses = describeAppSettings(
    [webhook, { key: "REGION", label: "Region", type: "text" }],
    [{ key: "WEBHOOK_URL", value: "https://hooks.example.com/x", encrypted: false, updated_at: new Date(saved) }],
  );
  assert.deepEqual(
    statuses.map((s) => [s.key, s.set, s.value, s.required, s.updatedAt]),
    [
      ["WEBHOOK_URL", true, "https://hooks.example.com/x", true, saved],
      ["REGION", false, null, false, null],
    ],
  );
});

test("a value saved before its field became a password is not shown", () => {
  const [status] = describeAppSettings(
    [token],
    [{ key: "API_TOKEN", value: "saved-as-text", encrypted: false, updated_at: saved }],
  );
  assert.equal(status.set, true);
  assert.equal(status.value, null);
});

test("only declared settings are listed, in manifest order", () => {
  const statuses = describeAppSettings(
    [token, webhook],
    [
      { key: "RETIRED_KEY", value: "old", encrypted: false, updated_at: saved },
      { key: "WEBHOOK_URL", value: "https://x", encrypted: false, updated_at: saved },
    ],
  );
  assert.deepEqual(statuses.map((s) => s.key), ["API_TOKEN", "WEBHOOK_URL"]);
});
