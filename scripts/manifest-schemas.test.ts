/* This Source Code Form is subject to the terms of the Mozilla Public
 * License, v. 2.0. If a copy of the MPL was not distributed with this
 * file, You can obtain one at https://mozilla.org/MPL/2.0/. */

import { test } from "node:test";
import assert from "node:assert/strict";
import { formatZodError, RawAppManifestSchema, RawConnectorManifestSchema } from "./manifest-schemas";
import { JOB_TIMEOUT_MS, MAX_SYNC_BUDGET_MS } from "../src/lib/apps/job-limits";

// ── fixtures ────────────────────────────────────────────────────────────────

const sync = (budgetMs = 200_000) => ({
  name: "calls",
  schedule: { everyMinutes: 60 },
  source: "mixos",
  window: { coldStartDays: 30, defaultDays: 7, minDays: 1 },
  budgetMs,
});

/** The problems the schema reports for `manifest`, one line each. */
function problems(manifest: Record<string, unknown>): string {
  const parsed = RawAppManifestSchema.safeParse({ $schema: "https://mixos.org/schemas/app/v1.json", name: "Calls", ...manifest });
  return parsed.success ? "" : formatZodError(parsed.error);
}

// ── sync budget ─────────────────────────────────────────────────────────────

test("a sync budget leaves room under the job timeout", () => {
  assert.ok(MAX_SYNC_BUDGET_MS < JOB_TIMEOUT_MS);
  assert.equal(problems({ database: true, sync: [sync(MAX_SYNC_BUDGET_MS)] }), "");
});

test("a sync budget the scheduler would cut off fails the build", () => {
  for (const budgetMs of [MAX_SYNC_BUDGET_MS + 1, JOB_TIMEOUT_MS, 300_000]) {
    assert.match(
      problems({ database: true, sync: [sync(budgetMs)] }),
      /sync\.0\.budgetMs: budgetMs may be at most/,
      String(budgetMs),
    );
  }
});

// ── sync needs a database ───────────────────────────────────────────────────

test("a sync without a database fails the build", () => {
  for (const database of [undefined, false]) {
    assert.match(
      problems({ ...(database === undefined ? {} : { database }), sync: [sync()] }),
      /sync: a sync keeps its watermark in the app's scoped database — set "database": true/,
      String(database),
    );
  }
});

test("an app with no sync needs no database", () => {
  assert.equal(problems({ database: false, sync: [] }), "");
  assert.equal(problems({}), "");
});

// ── roles ───────────────────────────────────────────────────────────────────

test("role keys must be unique", () => {
  assert.equal(
    problems({
      roles: [
        { key: "admin", label: "Admin" },
        { key: "viewer", label: "Viewer" },
        { key: "admin", label: "Administrator" },
      ],
    }),
    '  - roles.2.key: duplicate role key "admin" — role keys must be unique within the app',
  );
});

test("distinct role keys pass, and a defaultRole still has to name one", () => {
  const roles = [
    { key: "admin", label: "Admin" },
    { key: "viewer", label: "Viewer" },
  ];
  assert.equal(problems({ roles, defaultRole: "viewer" }), "");
  assert.match(problems({ roles, defaultRole: "editor" }), /^ {2}- defaultRole:/);
});

// ── connector entries ───────────────────────────────────────────────────────

test("a connector entry names the connector and the version the app was built against", () => {
  assert.equal(problems({ connectors: [{ name: "crm", version: "1.2.0" }] }), "");
  assert.equal(problems({ connectors: [{ name: "crm", version: "1.2.0", access: "write" }] }), "");
  assert.equal(problems({ optionalConnectors: [{ name: "slack", version: "0.4.1", access: "read" }] }), "");
  assert.match(problems({ connectors: ["crm"] }), /connectors\.0: Invalid input: expected object, received string/);
  assert.match(problems({ connectors: [{ name: "crm" }] }), /connectors\.0\.version:/);
  for (const version of ["^1.2.0", "v1.2.0", "1.2", "1.2.0-rc.1"]) {
    assert.match(problems({ connectors: [{ name: "crm", version }] }), /a version is three numbers/, version);
  }
  assert.match(problems({ connectors: [{ name: "crm", version: "1.0.0", access: "admin" }] }), /connectors\.0\.access/);
});

test("a connector is declared once across both lists", () => {
  assert.match(
    problems({
      connectors: [{ name: "crm", version: "1.0.0" }],
      optionalConnectors: [{ name: "crm", version: "1.0.0" }],
    }),
    /optionalConnectors\.0\.name: "crm" is already listed/,
  );
  assert.match(
    problems({ connectors: [{ name: "crm", version: "1.0.0" }, { name: "crm", version: "2.0.0" }] }),
    /connectors\.1\.name: "crm" is already listed/,
  );
});

// ── connector manifests ─────────────────────────────────────────────────────

const connector = (extra: Record<string, unknown> = {}) => ({
  $schema: "https://mixos.org/schemas/connector/v1.json",
  name: "crm",
  displayName: "CRM",
  version: "1.0.0",
  telemetry: [{ method: "listDeals", operation: "GET /deals" }],
  ...extra,
});

/** The problems the schema reports for a connector manifest, one line each. */
function connectorProblems(manifest: Record<string, unknown>): string {
  const parsed = RawConnectorManifestSchema.safeParse(manifest);
  return parsed.success ? "" : formatZodError(parsed.error);
}

test("a connector declares its version", () => {
  assert.equal(connectorProblems(connector()), "");
  const unversioned: Record<string, unknown> = connector();
  delete unversioned.version;
  assert.match(connectorProblems(unversioned), /version: Invalid input: expected string, received undefined/);
  assert.match(connectorProblems(connector({ version: "1.0" })), /version: a version is three numbers/);
});

test("each method names the provider operation it calls, and no two name the same one", () => {
  assert.match(connectorProblems(connector({ telemetry: [{ method: "listDeals" }] })), /telemetry\.0\.operation/);
  assert.match(connectorProblems(connector({ telemetry: [{ method: "listDeals", operation: "  " }] })), /telemetry\.0\.operation/);
  assert.match(
    connectorProblems(
      connector({
        telemetry: [
          { method: "listDeals", operation: "GET /deals" },
          { method: "listOpenDeals", operation: "get  /deals" },
        ],
      }),
    ),
    /telemetry\.1\.operation: "listOpenDeals" names the operation "get  \/deals", as "listDeals" does\. One method per provider operation/,
  );
});

test("a scope requested once changes are allowed needs a method that changes data", () => {
  const auth = {
    strategy: "oauth2_authorization_code",
    authorizeUrl: "https://crm.example/authorize",
    tokenUrl: "https://crm.example/token",
    credentialKeys: ["clientId", "clientSecret"],
    scopes: [
      { scope: "deals:read", requested: true },
      { scope: "deals:write", requested: "write" },
    ],
  };
  const credentialFields = [
    { key: "clientId", label: "Client ID", type: "text" },
    { key: "clientSecret", label: "Client secret", type: "password" },
  ];
  assert.match(
    connectorProblems(connector({ auth, credentialFields })),
    /auth\.scopes: requests deals:write once changes are allowed, but declares no method with "mutates": true/,
  );
  assert.equal(
    connectorProblems(
      connector({
        auth,
        credentialFields,
        telemetry: [
          { method: "listDeals", operation: "GET /deals" },
          { method: "createDeal", operation: "POST /deals", mutates: true },
        ],
      }),
    ),
    "",
  );
  assert.match(
    connectorProblems(connector({ auth: { ...auth, scopes: [{ scope: "deals:read", requested: "yes" }] }, credentialFields })),
    /auth\.scopes\.0\.requested/,
  );
});
