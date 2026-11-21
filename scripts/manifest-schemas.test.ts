/* This Source Code Form is subject to the terms of the Mozilla Public
 * License, v. 2.0. If a copy of the MPL was not distributed with this
 * file, You can obtain one at https://mozilla.org/MPL/2.0/. */

import { test } from "node:test";
import assert from "node:assert/strict";
import {
  formatZodError,
  RawAppManifestSchema,
  RawConnectorManifestSchema,
  RawThemeManifestSchema,
  searchLinkProblem,
} from "./manifest-schemas";
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
  const parsed = RawAppManifestSchema.safeParse({
    $schema: "https://mixos.org/schemas/app/v1.json",
    registryId: "calls-3f9a2c1b",
    name: "Calls",
    ...manifest,
  });
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
  assert.equal(problems({ connectors: [{ name: "crm-1a2b3c4d", version: "1.2.0" }] }), "");
  assert.equal(problems({ connectors: [{ name: "crm-1a2b3c4d", version: "1.2.0", access: "write" }] }), "");
  assert.equal(problems({ optionalConnectors: [{ name: "slack-5e6f7a8b", version: "0.4.1", access: "read" }] }), "");
  assert.match(problems({ connectors: ["crm-1a2b3c4d"] }), /connectors\.0: Invalid input: expected object, received string/);
  assert.match(problems({ connectors: [{ name: "crm-1a2b3c4d" }] }), /connectors\.0\.version:/);
  for (const version of ["^1.2.0", "v1.2.0", "1.2", "1.2.0-rc.1"]) {
    assert.match(problems({ connectors: [{ name: "crm-1a2b3c4d", version }] }), /a version is three numbers/, version);
  }
  assert.match(problems({ connectors: [{ name: "crm-1a2b3c4d", version: "1.0.0", access: "admin" }] }), /connectors\.0\.access/);
});

test("a connector is declared once across both lists", () => {
  assert.match(
    problems({
      connectors: [{ name: "crm-1a2b3c4d", version: "1.0.0" }],
      optionalConnectors: [{ name: "crm-1a2b3c4d", version: "1.0.0" }],
    }),
    /optionalConnectors\.0\.name: "crm-1a2b3c4d" is already listed/,
  );
  assert.match(
    problems({ connectors: [{ name: "crm-1a2b3c4d", version: "1.0.0" }, { name: "crm-1a2b3c4d", version: "2.0.0" }] }),
    /connectors\.1\.name: "crm-1a2b3c4d" is already listed/,
  );
});

// ── connector manifests ─────────────────────────────────────────────────────

const connector = (extra: Record<string, unknown> = {}) => ({
  $schema: "https://mixos.org/schemas/connector/v1.json",
  registryId: "crm-1a2b3c4d",
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

test("the scopes a method needs are ones the connector requests, each named once", () => {
  const auth = {
    strategy: "oauth2_authorization_code",
    authorizeUrl: "https://crm.example/authorize",
    tokenUrl: "https://crm.example/token",
    credentialKeys: ["clientId", "clientSecret"],
    scopes: [
      { scope: "deals:read", requested: true },
      { scope: "deals:write", requested: "write" },
      { scope: "admin", requested: false },
    ],
  };
  const credentialFields = [
    { key: "clientId", label: "Client ID", type: "text" },
    { key: "clientSecret", label: "Client secret", type: "password" },
  ];
  const withMethods = (telemetry: unknown[]) => connectorProblems(connector({ auth, credentialFields, telemetry }));
  const create = { method: "createDeal", operation: "POST /deals", mutates: true, scopes: ["deals:write"] };

  assert.equal(withMethods([{ method: "listDeals", operation: "GET /deals", scopes: ["deals:read"] }, create]), "");
  // Declaring them is optional, method by method.
  assert.equal(withMethods([{ method: "listDeals", operation: "GET /deals" }, create]), "");
  // A read needing a scope asked for only once changes are allowed can be the
  // truth; the generator warns (connector-checks.test.ts), the schema doesn't.
  assert.equal(withMethods([{ method: "searchDeals", operation: "POST /deals/search", scopes: ["deals:write"] }, create]), "");

  assert.match(
    withMethods([{ method: "listDeals", operation: "GET /deals", scopes: ["deals:raed"] }, create]),
    /telemetry\.0\.scopes\.0: "listDeals" needs deals:raed, which is not in auth\.scopes/,
  );
  assert.match(
    withMethods([{ method: "listDeals", operation: "GET /deals", scopes: ["admin"] }, create]),
    /telemetry\.0\.scopes\.0: "listDeals" needs admin, which this connector never requests, so the method could never be called/,
  );
  assert.match(
    withMethods([{ method: "listDeals", operation: "GET /deals", scopes: ["deals:read", "deals:read"] }, create]),
    /telemetry\.0\.scopes\.1: "listDeals" names deals:read twice/,
  );
  assert.match(withMethods([{ method: "listDeals", operation: "GET /deals", scopes: [""] }, create]), /telemetry\.0\.scopes\.0/);
});

test("a scope includes others from auth.scopes, each named once, and never itself", () => {
  const scopes = (includes: unknown) => [
    { scope: "task:add", requested: false },
    { scope: "data:read", requested: true },
    { scope: "data:read_write", requested: "write", includes },
  ];
  const withIncludes = (includes: unknown) =>
    connectorProblems(
      connector({
        auth: {
          strategy: "oauth2_authorization_code",
          authorizeUrl: "https://todo.example/authorize",
          tokenUrl: "https://todo.example/token",
          credentialKeys: ["clientId", "clientSecret"],
          scopes: scopes(includes),
        },
        credentialFields: [
          { key: "clientId", label: "Client ID", type: "text" },
          { key: "clientSecret", label: "Client secret", type: "password" },
        ],
        telemetry: [
          { method: "getTasks", operation: "GET /tasks", scopes: ["data:read"] },
          { method: "createTask", operation: "POST /tasks", mutates: true, scopes: ["data:read_write"] },
        ],
      }),
    );

  // An included scope needn't be requested: task:add isn't.
  assert.equal(withIncludes(["task:add", "data:read"]), "");
  assert.match(
    withIncludes(["data:raed"]),
    /auth\.scopes\.2\.includes\.0: data:read_write includes data:raed, which is not in auth\.scopes/,
  );
  assert.match(withIncludes(["data:read", "data:read"]), /auth\.scopes\.2\.includes\.1: data:read_write includes data:read twice/);
  assert.match(withIncludes(["data:read_write"]), /auth\.scopes\.2\.includes\.0: data:read_write includes itself/);
  assert.match(withIncludes([""]), /auth\.scopes\.2\.includes\.0/);
  assert.match(withIncludes("data:read"), /auth\.scopes\.2\.includes/);
});

test("a connector that authenticates with nothing names no scopes on its methods", () => {
  assert.equal(connectorProblems(connector({ auth: { strategy: "none" } })), "");
  assert.match(
    connectorProblems(
      connector({ auth: { strategy: "none" }, telemetry: [{ method: "listDeals", operation: "GET /deals", scopes: ["deals:read"] }] }),
    ),
    /telemetry\.0\.scopes: "listDeals" names scopes, but auth\.strategy is "none"/,
  );
});

// ── registryId ──────────────────────────────────────────────────────────────

const theme = (extra: Record<string, unknown> = {}) => ({
  $schema: "https://mixos.org/schemas/theme/v1.json",
  registryId: "acme-3f9a2c1b",
  name: "Acme",
  description: "Acme's colours and type.",
  ...extra,
});

/** The problems the schema reports for an app manifest as given, one line each. */
function appProblems(manifest: Record<string, unknown>): string {
  const parsed = RawAppManifestSchema.safeParse(manifest);
  return parsed.success ? "" : formatZodError(parsed.error);
}

/** The problems the schema reports for a theme manifest, one line each. */
function themeProblems(manifest: Record<string, unknown>): string {
  const parsed = RawThemeManifestSchema.safeParse(manifest);
  return parsed.success ? "" : formatZodError(parsed.error);
}

test("every manifest names its registryId: a lowercase name, a hyphen and an 8-character hex id", () => {
  const app = { $schema: "https://mixos.org/schemas/app/v1.json", registryId: "calls-3f9a2c1b", name: "Calls" };
  const kinds = [
    ["app", app, appProblems],
    ["connector", connector(), connectorProblems],
    ["theme", theme(), themeProblems],
  ] as const;
  for (const [kind, manifest, check] of kinds) {
    assert.equal(check(manifest), "", kind);
    const unnamed: Record<string, unknown> = { ...manifest };
    delete unnamed.registryId;
    assert.match(check(unnamed), /registryId: Invalid input: expected string, received undefined/, kind);
    for (const registryId of ["acme", "Acme-3f9a2c1b", "acme-3F9A2C1B", "acme_3f9a2c1b", "3f9a2c1b"]) {
      assert.match(check({ ...manifest, registryId }), /registryId: must be the install name/, `${kind} ${registryId}`);
    }
    assert.match(check({ ...manifest, registryId: `${"a".repeat(40)}-3f9a2c1b` }), /registryId: Too big: expected string to have <=48 characters/, kind);
  }
});

// ── searchLinkProblem ──────────────────────────────────────────────────────

test("the build accepts a page path with placeholders in the query", () => {
  for (const link of ["notes", "notes?id={id}", "?id={id}", "notes/archive?id={id}&tab=details", "a-b/c-d?x={x_y}"]) {
    assert.equal(searchLinkProblem(link), null, link);
  }
});

test("the build refuses a link that could leave the app, or names no page", () => {
  for (const link of [
    "",
    "/notes?id={id}",
    "//evil.example",
    "https://evil.example?id={id}",
    "javascript:alert(1)",
    "../admin?id={id}",
    "notes/../admin",
    "notes/{id}",
    "notes?id={id}#top",
    "notes?id=prefix-{id}",
    "notes\\x?id={id}",
    "Notes?id={id}",
    "notes?{id}",
  ]) {
    assert.notEqual(searchLinkProblem(link), null, link);
  }
});

test("a search object's link, fields and count are held to their limits", () => {
  const object = (extra: Record<string, unknown> = {}) => ({
    name: "notes",
    label: "Notes",
    icon: "notebook",
    fields: [{ key: "title", label: "Title" }],
    link: "notes?id={id}",
    ...extra,
  });
  assert.equal(problems({ search: [object()] }), "");
  assert.match(problems({ search: [object({ link: "/notes" })] }), /search\.0\.link: must be a page path/);
  assert.match(problems({ search: [object({ fields: [] })] }), /search\.0\.fields: a search object must declare at least one/);
  assert.match(
    problems({ search: [object({ fields: Array.from({ length: 7 }, (_, i) => ({ key: `f${i}`, label: "F" })) })] }),
    /search\.0\.fields: a search object may declare at most 6 fields/,
  );
  assert.match(
    problems({ search: Array.from({ length: 6 }, (_, i) => object({ name: `o${i}` })) }),
    /search: an app may declare at most 5 search objects/,
  );
  assert.match(problems({ search: [object({ extra: true })] }), /search\.0/);
});

test("every search object names its icon, as a Lucide name", () => {
  const object = (icon?: string) => ({
    name: "notes",
    label: "Notes",
    ...(icon === undefined ? {} : { icon }),
    fields: [{ key: "title", label: "Title" }],
    link: "notes?id={id}",
  });
  assert.equal(problems({ search: [object("message-circle")] }), "");
  assert.match(problems({ search: [object()] }), /search\.0\.icon: every search object needs an icon/);
  for (const icon of ["MessageCircle", "message_circle", "", "notes icon"]) {
    assert.match(problems({ search: [object(icon)] }), /search\.0\.icon: icon must be a Lucide name/, icon);
  }
});
