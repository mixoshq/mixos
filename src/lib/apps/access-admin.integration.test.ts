/* This Source Code Form is subject to the terms of the Mozilla Public
 * License, v. 2.0. If a copy of the MPL was not distributed with this
 * file, You can obtain one at https://mozilla.org/MPL/2.0/. */

/**
 * The Access tab's server actions against a real Postgres, called as the
 * browser calls them: the exported actions in ./grant-actions.ts and
 * ./api-key-actions.ts, with the session stubbed and nothing else.
 *
 * What it proves:
 *
 *   - each one refuses a signed-in user who isn't an admin, and a request with
 *     no session, and writes nothing;
 *   - the grant gate's readiness rule (./connector-gates.ts): a three-legged
 *     tenant connector with a saved client ID blocks granting and activating
 *     until it is connected; a user-scoped one needs only its client
 *     credentials; one that asks for no credentials is ready as installed; a
 *     disabled one blocks until it is enabled; credentials that can't be
 *     decrypted count as not configured;
 *     The gate refuses when the connector switch can't be read, and a page
 *     asking only to show the answer gets the credentials' answer;
 *   - grants, roles and revocation, each audited, and what each refuses: a
 *     global app, an undeclared role, a person who isn't a user, a role for
 *     someone without a grant. A second grant or revoke changes nothing, says
 *     so, and still refreshes the pages;
 *   - a role on a global app is only a role (./grant-rule.ts): once the app
 *     stops being global nobody has it through a role, by any path, until an
 *     admin grants it, which the admin is shown. A grant outlasts the app's
 *     being global, and setting a role on a global app never demotes one;
 *   - an app this build doesn't carry: its grants and keys can be listed and
 *     revoked, by an admin, audited, and nothing else;
 *   - the search behind Grant access: name or email, holders left out, LIKE's
 *     wildcards and its escape character matched literally, ten at most;
 *   - API keys: shown once and stored only as a digest, a label with no
 *     control or invisible characters, scoped to the routes that accept a key
 *     and refused on any other, refused once revoked, refused where the route
 *     can't be named unless it is for every route, and revoked by the release
 *     step when a different extension takes the slug, which the list then
 *     says.
 *
 * Skipped unless MIXOS_TEST_DATABASE_URL names a server this may create and
 * drop a database on. The database's name ends in this run's own suffix, and
 * it is dropped when the run finishes:
 *
 *   docker run -d --name access -e POSTGRES_PASSWORD=pw -p 127.0.0.1:55432:5432 postgres:17
 *   MIXOS_TEST_DATABASE_URL=postgres://postgres:pw@127.0.0.1:55432/postgres \
 *     npx tsx --test src/lib/apps/access-admin.integration.test.ts
 */

import { after, before, describe, test } from "node:test";
import assert from "node:assert/strict";
import { randomBytes, randomUUID } from "node:crypto";
import fs from "node:fs";
import { registerHooks } from "node:module";
import os from "node:os";
import path from "node:path";
import { pathToFileURL } from "node:url";
import postgres, { type Sql } from "postgres";
import type { ConnectorManifest } from "../connectors/types";
import type { RegistryInstall } from "../repository/install-record";
import type { AppManifest, RouteAuth, RouteMethodContract } from "./types";

const REPO = path.resolve(__dirname, "..", "..", "..");
const serverUrl = process.env.MIXOS_TEST_DATABASE_URL;
const skip = serverUrl ? false : "set MIXOS_TEST_DATABASE_URL to run against a real Postgres";

const run = randomBytes(3).toString("hex");
const database = `mixos_access_${run}`;

/** Roles, grants and the search. No key routes. */
const NOTES = `notes-${run}`;
/** Held by everyone. */
const EVERYONE = `everyone-${run}`;
/** Global, until a test says otherwise: roles, and what becomes of them. */
const TEAM = `team-${run}`;
/** In this database and not in this build. */
const GONE = `gone-${run}`;
/** API keys: two key routes and one that takes no key. */
const VAULT = `vault-${run}`;
/** Each requires one connector, for the readiness rule. */
const CRM_APP = `crmapp-${run}`;
const DRIVE_APP = `driveapp-${run}`;
const OPEN_APP = `openapp-${run}`;
const KEYED_APP = `keyedapp-${run}`;
const GHOST_APP = `ghostapp-${run}`;

const CRM = `crm-${run}`;
const DRIVE = `drive-${run}`;
const OPEN = `open-${run}`;
const KEYED = `keyed-${run}`;

const STUBS = new Map<string, string>([
  [
    "@/lib/auth/session",
    `const current = () => (globalThis as { __accessSession?: unknown }).__accessSession ?? null;
export async function getReadOnlySession() { return current(); }
export async function requireReadOnlySession() {
  const session = current();
  if (!session) throw new Error("no session in this test");
  return session;
}
export const requireServerSession = requireReadOnlySession;
`,
  ],
  [
    "next/cache",
    `const seen = () => ((globalThis as { __revalidated?: string[] }).__revalidated ??= []);
export function revalidatePath(path: string) { seen().push(path); }
export function revalidateTag() {}
`,
  ],
]);

/** The paths revalidated since the last call, which clears them. */
function revalidated(): string[] {
  const seen = ((globalThis as { __revalidated?: string[] }).__revalidated ??= []);
  return seen.splice(0, seen.length);
}

/** What every change to who holds an app refreshes. */
const ACCESS_PAGES = ["/admin/apps", "/admin/users", "/apps", "/"];

const LABEL_REFUSED = "A label is plain text on one line, with no hidden characters.";

function method(m: RouteMethodContract["method"], auth: RouteAuth[]): RouteMethodContract {
  return { method: m, auth, roles: [], budget: { connectorCalls: 0, ms: 5000 }, raw: false, hasInput: false, hasOutput: false };
}

function manifest(slug: string, name: string, extra: Partial<AppManifest> = {}): AppManifest {
  return {
    slug,
    name,
    description: "",
    tagline: null,
    icon: "box",
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
    search: [],
    mcp: [],
    ...extra,
  };
}

const APPS: AppManifest[] = [
  manifest(NOTES, "Notes", {
    roles: [
      { key: "editor", label: "Editor" },
      { key: "viewer", label: "Viewer" },
    ],
    defaultRole: "viewer",
    routes: [{ path: "items", params: [], methods: [method("GET", ["session"])] }],
  }),
  manifest(EVERYONE, "Everyone", {
    global: true,
    roles: [
      { key: "member", label: "Member" },
      { key: "lead", label: "Lead" },
    ],
    defaultRole: "member",
  }),
  manifest(TEAM, "Team", {
    global: true,
    roles: [
      { key: "lead", label: "Lead" },
      { key: "member", label: "Member" },
    ],
    defaultRole: "member",
    routes: [{ path: "hello", params: [], methods: [method("GET", ["session"])] }],
  }),
  manifest(VAULT, "Vault", {
    routes: [
      { path: "items", params: [], methods: [method("GET", ["key", "session"]), method("POST", ["key", "session"])] },
      { path: "export", params: [], methods: [method("GET", ["session"])] },
    ],
  }),
  manifest(CRM_APP, "CRM App", { connectors: [CRM] }),
  manifest(DRIVE_APP, "Drive App", { connectors: [DRIVE] }),
  manifest(OPEN_APP, "Open App", { connectors: [OPEN] }),
  manifest(KEYED_APP, "Keyed App", { connectors: [KEYED] }),
  manifest(GHOST_APP, "Ghost App", { connectors: [`ghost-${run}`] }),
];

const template = (name: string) =>
  JSON.parse(fs.readFileSync(path.join(REPO, "connectors", name, "connector.json"), "utf8")) as ConnectorManifest;

const CONNECTORS: ConnectorManifest[] = [
  // Three-legged OAuth, connected once by an admin for everyone.
  { ...template("_template-oauth"), name: CRM, displayName: "Acme CRM" },
  // The same, but each person connects their own account.
  { ...template("_template-oauth"), name: DRIVE, displayName: "Drive", userScoped: true },
  // A public API: nothing to configure.
  { ...template("_template"), name: OPEN, displayName: "Open Data", auth: { strategy: "none" }, credentialFields: [] },
  { ...template("_template"), name: KEYED, displayName: "Keyed" },
];

/** What a release step reads about each app, for the registry mirror: now, since a test changes `global`. */
/**
 * The next build's entry for `slug`, with `change`: a new object, as a build
 * makes one. The entry in place can't be written to once a context has been
 * built from it, since that freezes it (src/lib/apps/freeze.ts). Swapped into
 * the fixtures and the registry alike; the function it returns puts the old
 * entry back in both.
 */
function rebuilt(registry: AppManifest[], slug: string, change: Partial<AppManifest>): () => void {
  const before = APPS.find((a) => a.slug === slug)!;
  const swap = (entry: AppManifest) => {
    for (const list of [APPS, registry] as AppManifest[][]) {
      const at = list.findIndex((a) => a.slug === slug);
      if (at >= 0) list[at] = entry;
    }
  };
  swap({ ...before, ...change });
  return () => swap(before);
}

const mirrored = () =>
  APPS.map((a) => ({ slug: a.slug, name: a.name, description: a.description, icon: a.icon, global: a.global }));

function installOf(slug: string): RegistryInstall {
  return {
    kind: "app",
    slug,
    version: "1.0.0",
    gitTag: "v1.0.0",
    commitSha: "b".repeat(40),
    source: "https://mixos.org",
    repository: { owner: "someone-else", name: "mixos-vault", subpath: null },
    requiresMixOS: null,
    modified: false,
  };
}

/** What `fn` wrote to `console.error`, while keeping it out of the output. */
async function quietErrors<T>(fn: () => Promise<T>): Promise<{ result: T; lines: string[] }> {
  const { error } = console;
  const lines: string[] = [];
  console.error = (...args: unknown[]) => {
    lines.push(args.map(String).join(" "));
  };
  try {
    return { result: await fn(), lines };
  } finally {
    console.error = error;
  }
}

describe("the Access tab's server actions", { skip }, () => {
  let admin: Sql;
  let sql: Sql;
  let work: string;
  let resolver: ReturnType<typeof registerHooks> | undefined;
  let p: {
    access: typeof import("./access");
    myApps: typeof import("./actions");
    grants: typeof import("./grant-actions");
    keys: typeof import("./api-key-actions");
    apiKeys: typeof import("./api-keys");
    authTier: typeof import("./auth-tier");
    gates: typeof import("./connector-gates");
    adminActions: typeof import("./admin-actions");
    config: typeof import("../connectors/config");
    connectorSwitch: typeof import("../connectors/switch");
    sync: typeof import("../../../scripts/sync-app-registry");
    registry: typeof import("../../generated/app-registry");
    connectors: typeof import("../../generated/connector-registry");
    db: typeof import("../db/client");
  };

  const ids: Record<"admin" | "member" | "alice" | "bob" | "carol" | "dave", string> = {
    admin: "",
    member: "",
    alice: "",
    bob: "",
    carol: "",
    dave: "",
  };

  const signIn = (who: keyof typeof ids | null) => {
    (globalThis as { __accessSession?: unknown }).__accessSession =
      who === null
        ? null
        : { user: { id: ids[who], email: `${who}-${run}@example.com`, name: who, isAdmin: who === "admin" } };
  };

  async function count(table: string, where = "true"): Promise<number> {
    const [{ n }] = await sql.unsafe<{ n: number }[]>(`select count(*)::int as n from public.${table} where ${where}`);
    return n;
  }

  async function audited(action: string, targetId?: string) {
    const rows = await sql`
      select actor_id, actor_email, target_type, target_id, details from public.admin_audit_log
      where action = ${action} ${targetId ? sql`and target_id = ${targetId}` : sql``}
      order by created_at
    `;
    return rows.map((r) => ({ ...r }));
  }

  async function grantRow(userId: string, slug: string) {
    const [row] = await sql`
      select role, granted_by from public.user_app_grants where user_id = ${userId} and app_slug = ${slug}
    `;
    return row ? { ...row } : undefined;
  }

  before(async () => {
    admin = postgres(serverUrl!, { max: 1, onnotice: () => {} });
    await admin.unsafe(`create database ${database}`);
    const u = new URL(serverUrl!);
    u.pathname = `/${database}`;
    sql = postgres(u.toString(), { max: 1, onnotice: () => {} });
    const { migratePlatform } = await import("../../../scripts/platform-migrations");
    await migratePlatform(sql, path.join(REPO, "supabase", "migrations"), () => {});

    work = fs.mkdtempSync(path.join(os.tmpdir(), "mixos-access-admin-"));
    const urls = new Map<string, string>();
    for (const [specifier, source] of STUBS) {
      const file = path.join(work, "stubs", `${specifier.replace(/[^a-z]+/g, "-")}.ts`);
      fs.mkdirSync(path.dirname(file), { recursive: true });
      fs.writeFileSync(file, source);
      urls.set(specifier, pathToFileURL(file).href);
    }
    resolver = registerHooks({
      resolve(specifier, context, nextResolve) {
        const stub = urls.get(specifier);
        return stub ? nextResolve(stub, context) : nextResolve(specifier, context);
      },
    });

    // The platform's own pool reads these on its first query.
    process.env.DATABASE_URL = u.toString();
    process.env.PGSSLMODE = u.searchParams.get("sslmode") ?? "disable";
    process.env.NEXTAUTH_URL ??= "http://localhost:3000";
    process.env.CONNECTOR_ENCRYPTION_KEY = randomBytes(32).toString("hex");
    process.env.USER_OAUTH_ENCRYPTION_KEY = randomBytes(32).toString("hex");
    process.env.APP_API_KEY_SECRET = randomBytes(32).toString("hex");

    p = {
      access: await import("./access"),
      myApps: await import("./actions"),
      grants: await import("./grant-actions"),
      keys: await import("./api-key-actions"),
      apiKeys: await import("./api-keys"),
      authTier: await import("./auth-tier"),
      gates: await import("./connector-gates"),
      adminActions: await import("./admin-actions"),
      config: await import("../connectors/config"),
      connectorSwitch: await import("../connectors/switch"),
      sync: await import("../../../scripts/sync-app-registry"),
      registry: await import("../../generated/app-registry"),
      connectors: await import("../../generated/connector-registry"),
      db: await import("../db/client"),
    };
    p.registry.appRegistry.push(...APPS);
    p.connectors.connectorRegistry.push(...CONNECTORS);

    // The release step's mirror, for these apps; then every app but CRM_APP is
    // switched on, so activating that one can be refused.
    for (const a of APPS) {
      fs.mkdirSync(path.join(work, "apps", a.slug), { recursive: true });
      fs.writeFileSync(path.join(work, "apps", a.slug, "app.json"), `{ "name": "${a.name}" }\n`);
    }
    await p.sync.syncAppRegistry(sql, mirrored(), path.join(work, "apps"), []);
    await sql`update public.apps set is_active = true where slug = any(${APPS.map((a) => a.slug).filter((s) => s !== CRM_APP)})`;

    for (const who of Object.keys(ids) as (keyof typeof ids)[]) {
      const name = who.charAt(0).toUpperCase() + who.slice(1);
      const [row] = await sql`
        insert into public.users (email, display_name, is_admin)
        values (${`${who}-${run}@example.com`}, ${name}, ${who === "admin"}) returning id
      `;
      ids[who] = row.id as string;
    }
  });

  after(async () => {
    try {
      if (p) {
        for (const a of APPS) {
          const at = p.registry.appRegistry.findIndex((r) => r.slug === a.slug);
          if (at >= 0) p.registry.appRegistry.splice(at, 1);
        }
        for (const c of CONNECTORS) {
          const at = p.connectors.connectorRegistry.findIndex((r) => r.name === c.name);
          if (at >= 0) p.connectors.connectorRegistry.splice(at, 1);
        }
        await p.db.sql.end();
      }
      resolver?.deregister();
    } finally {
      await sql?.end();
      if (admin) {
        await admin.unsafe(`drop database if exists ${database} with (force)`);
        await admin.end();
      }
      if (work) fs.rmSync(work, { recursive: true, force: true });
    }
  });

  // ── an admin first ───────────────────────────────────────────────────────

  test("every action refuses a signed-in user who isn't an admin, and no session at all, and writes nothing", async () => {
    const keyId = randomUUID();
    const calls: [string, () => Promise<unknown>][] = [
      ["listAppAccess", () => p.grants.listAppAccess(NOTES)],
      ["searchUsersForGrant", () => p.grants.searchUsersForGrant(NOTES, "a")],
      ["grantAppAccess", () => p.grants.grantAppAccess(NOTES, ids.alice)],
      ["revokeAppAccess", () => p.grants.revokeAppAccess(NOTES, ids.alice)],
      ["setAppRoleAction", () => p.grants.setAppRoleAction(EVERYONE, ids.alice, "lead")],
      ["listAppApiKeys", () => p.keys.listAppApiKeys(VAULT)],
      ["mintAppApiKey", () => p.keys.mintAppApiKey(VAULT, { label: "x", scopes: ["*"], expiresInDays: null })],
      ["revokeAppApiKey", () => p.keys.revokeAppApiKey(VAULT, keyId)],
      // An app out of the build is no exception.
      ["listAppAccess, out of the build", () => p.grants.listAppAccess(GONE)],
      ["revokeAppAccess, out of the build", () => p.grants.revokeAppAccess(GONE, ids.alice)],
      ["listAppApiKeys, out of the build", () => p.keys.listAppApiKeys(GONE)],
      ["revokeAppApiKey, out of the build", () => p.keys.revokeAppApiKey(GONE, keyId)],
    ];
    const tables = ["user_app_grants", "app_api_keys", "admin_audit_log", "user_apps"];
    const before = await Promise.all(tables.map((t) => count(t)));

    signIn("member");
    for (const [name, call] of calls) {
      await assert.rejects(call(), /Admin access required/, `${name} let a non-admin through`);
    }
    signIn(null);
    for (const [name, call] of calls) {
      await assert.rejects(call(), /no session/, `${name} ran without a session`);
    }
    assert.deepEqual(await Promise.all(tables.map((t) => count(t))), before);
  });

  // ── the grant gate ───────────────────────────────────────────────────────

  test("a three-legged tenant connector blocks granting and activating until it is connected", async () => {
    signIn("admin");
    assert.deepEqual(await p.gates.getMissingTenantConfigConnectors(CRM_APP), [
      { name: CRM, displayName: "Acme CRM", state: "unconfigured" },
    ]);
    assert.deepEqual(await p.grants.grantAppAccess(CRM_APP, ids.alice), {
      ok: false,
      message: "Configure Acme CRM before granting CRM App.",
    });

    // The client ID and secret saved, and nobody has pressed Connect: a row
    // exists, which is all the old check asked for.
    await p.config.saveConnectorConfig(CRM, { clientId: "cid", clientSecret: "secret" }, ids.admin);
    assert.deepEqual(await p.gates.getMissingTenantConfigConnectors(CRM_APP), [
      { name: CRM, displayName: "Acme CRM", state: "needs-authorization" },
    ]);
    assert.deepEqual(await p.grants.grantAppAccess(CRM_APP, ids.alice), {
      ok: false,
      message: "Connect Acme CRM before granting CRM App.",
    });
    await assert.rejects(p.adminActions.setAppActiveAction(CRM_APP, true), {
      message: "Connect Acme CRM before activating this app.",
    });
    assert.equal(await grantRow(ids.alice, CRM_APP), undefined);
    assert.equal(await count("apps", `slug = '${CRM_APP}' and is_active`), 0);

    // Connected: a grant is stored.
    await p.config.saveConnectorTokens(CRM, { accessToken: "at", refreshToken: "rt", expiresAt: Date.now() + 3_600_000 });
    assert.deepEqual(await p.gates.getMissingTenantConfigConnectors(CRM_APP), []);
    assert.deepEqual(await p.grants.grantAppAccess(CRM_APP, ids.alice), { ok: true, changed: true });
    await p.adminActions.setAppActiveAction(CRM_APP, true);
    assert.equal(await count("apps", `slug = '${CRM_APP}' and is_active`), 1);
  });

  test("a user-scoped connector needs only its client credentials; a public one, nothing", async () => {
    signIn("admin");
    assert.deepEqual(
      (await p.gates.getMissingTenantConfigConnectors(DRIVE_APP)).map((m) => m.state),
      ["unconfigured"],
    );
    await p.config.saveConnectorConfig(DRIVE, { clientId: "cid", clientSecret: "secret" }, ids.admin);
    // No tenant grant, and none needed: each person connects their own.
    assert.deepEqual(await p.gates.getMissingTenantConfigConnectors(DRIVE_APP), []);
    assert.deepEqual(await p.grants.grantAppAccess(DRIVE_APP, ids.alice), { ok: true, changed: true });

    assert.equal(await count("connector_configs", `connector_name = '${OPEN}'`), 0);
    assert.deepEqual(await p.gates.getMissingTenantConfigConnectors(OPEN_APP), []);
  });

  test("a disabled connector blocks until it is enabled, and unreadable credentials count as not configured", async () => {
    signIn("admin");
    await p.connectorSwitch.setConnectorDisabled(OPEN, true);
    assert.deepEqual(await p.gates.getMissingTenantConfigConnectors(OPEN_APP), [
      { name: OPEN, displayName: "Open Data", state: "disabled" },
    ]);
    assert.deepEqual(await p.grants.grantAppAccess(OPEN_APP, ids.bob), {
      ok: false,
      message: "Enable Open Data before granting Open App.",
    });
    await p.connectorSwitch.setConnectorDisabled(OPEN, false);
    assert.deepEqual(await p.grants.grantAppAccess(OPEN_APP, ids.bob), { ok: true, changed: true });

    await sql`insert into public.connector_configs (connector_name, encrypted_credentials) values (${KEYED}, 'not-a-sealed-blob')`;
    const { result, lines } = await quietErrors(() => p.gates.getMissingTenantConfigConnectors(KEYED_APP));
    assert.deepEqual(result, [{ name: KEYED, displayName: "Keyed", state: "unconfigured" }]);
    assert.equal(lines.length, 1);
    assert.match(lines[0], new RegExp(`${KEYED}: stored credentials unreadable`));
    assert.doesNotMatch(lines[0], /not-a-sealed-blob/);

    // A connector the app names and this build doesn't have.
    assert.deepEqual(await p.gates.getMissingTenantConfigConnectors(GHOST_APP), [
      { name: `ghost-${run}`, displayName: `ghost-${run}`, state: "unconfigured" },
    ]);
  });

  test("when the connector switch can't be read, the gate fails and a page showing it gets the credentials' answer", async () => {
    signIn("admin");
    // Disabled, and then unreadable: nothing may pass on the guess that it's on.
    await p.connectorSwitch.setConnectorDisabled(OPEN, true);
    await sql`alter table public.platform_settings rename to platform_settings_away`;
    try {
      await assert.rejects(p.gates.getMissingTenantConfigConnectors(OPEN_APP));
      await assert.rejects(p.grants.grantAppAccess(OPEN_APP, ids.carol));

      const { result, lines } = await quietErrors(() =>
        p.gates.getMissingTenantConfigConnectors(OPEN_APP, { forDisplay: true }),
      );
      assert.deepEqual(result, []);
      assert.equal(lines.length, 1);
      assert.match(lines[0], new RegExp(`${OPEN_APP}: could not read which connectors are disabled`));
    } finally {
      await sql`alter table public.platform_settings_away rename to platform_settings`;
      await p.connectorSwitch.setConnectorDisabled(OPEN, false);
    }
    assert.equal(await grantRow(ids.carol, OPEN_APP), undefined);
  });

  // ── grants and roles ─────────────────────────────────────────────────────

  test("granting stores no role, so the person follows the default, and is audited once; a second grant changes nothing and says so", async () => {
    signIn("admin");
    revalidated();
    assert.deepEqual(await p.grants.grantAppAccess(NOTES, ids.alice), { ok: true, changed: true });
    assert.deepEqual(revalidated(), ACCESS_PAGES);
    assert.deepEqual(await grantRow(ids.alice, NOTES), { role: null, granted_by: ids.admin });
    const grants = await audited("user.grant.add", ids.alice);
    assert.deepEqual(grants.at(-1), {
      actor_id: ids.admin,
      actor_email: `admin-${run}@example.com`,
      target_type: "user",
      target_id: ids.alice,
      details: { appSlug: NOTES, role: null },
    });

    // A second grant changes nothing, not even the role, and isn't audited.
    // It says so, and the pages are refreshed anyway: the one that asked was
    // out of date.
    await p.grants.setAppRoleAction(NOTES, ids.alice, "viewer");
    const before = await count("admin_audit_log");
    revalidated();
    assert.deepEqual(await p.grants.grantAppAccess(NOTES, ids.alice, "editor"), { ok: true, changed: false });
    assert.deepEqual(revalidated(), ACCESS_PAGES);
    assert.deepEqual(await p.grants.grantAppAccess(NOTES, ids.alice), { ok: true, changed: false });
    assert.deepEqual(await grantRow(ids.alice, NOTES), { role: "viewer", granted_by: ids.admin });
    assert.equal(await count("admin_audit_log"), before);
    await p.grants.setAppRoleAction(NOTES, ids.alice, null);

    assert.deepEqual(await p.grants.grantAppAccess(NOTES, ids.bob, "editor"), { ok: true, changed: true });
    assert.equal((await grantRow(ids.bob, NOTES))?.role, "editor");
  });

  test("a grant is refused for a global app, an undeclared role, someone who isn't a user, and anything malformed", async () => {
    signIn("admin");
    const before = await Promise.all([count("user_app_grants"), count("admin_audit_log")]);
    for (const [args, message] of [
      [[EVERYONE, ids.carol], "Everyone already has Everyone. A global app isn't granted one person at a time."],
      [[NOTES, ids.carol, "owner"], `"owner" is not a role Notes declares.`],
      [[NOTES, randomUUID()], "That person isn't a user here."],
      [[`missing-${run}`, ids.carol], "That app isn't in this build."],
      [[NOTES, "not-a-user-id"], "That request isn't valid."],
      [[NOTES, ids.carol, ""], "That request isn't valid."],
      [[{ slug: NOTES }, ids.carol], "That request isn't valid."],
    ] as [unknown[], string][]) {
      const result = await (p.grants.grantAppAccess as (...a: unknown[]) => Promise<unknown>)(...args);
      assert.deepEqual(result, { ok: false, message }, JSON.stringify(args));
    }
    assert.deepEqual(await Promise.all([count("user_app_grants"), count("admin_audit_log")]), before);
  });

  test("the list shows each holder's effective role, where it came from, and who granted it", async () => {
    signIn("admin");
    const list = await p.grants.listAppAccess(NOTES);
    assert.equal(list.global, false);
    assert.deepEqual(
      list.rows.map((r) => [r.name, r.role, r.roleSource, r.roleStale, r.grantedBy, typeof r.grantedAt]),
      [
        ["Alice", "viewer", "default", false, "Admin", "string"],
        ["Bob", "editor", "assigned", false, "Admin", "string"],
      ],
    );
    assert.deepEqual([list.inBuild, list.needsGrants, list.roleOnly], [true, null, []]);
  });

  test("a role is set, cleared back to the default, and never grants on its own", async () => {
    signIn("admin");
    assert.deepEqual(await p.grants.setAppRoleAction(NOTES, ids.alice, "editor"), { ok: true, changed: true });
    assert.equal((await grantRow(ids.alice, NOTES))?.role, "editor");
    assert.deepEqual((await audited("user.role.set", ids.alice)).at(-1)?.details, { appSlug: NOTES, role: "editor" });

    assert.deepEqual(await p.grants.setAppRoleAction(NOTES, ids.alice, null), { ok: true, changed: true });
    assert.equal((await grantRow(ids.alice, NOTES))?.role, null);
    assert.equal((await p.grants.listAppAccess(NOTES)).rows.find((r) => r.userId === ids.alice)?.roleSource, "default");

    // Dave has no grant: a role would have been access by the back door.
    const before = await count("admin_audit_log");
    assert.deepEqual(await p.grants.setAppRoleAction(NOTES, ids.dave, "editor"), {
      ok: false,
      message: "Grant this person Notes before setting their role.",
    });
    assert.equal(await grantRow(ids.dave, NOTES), undefined);
    assert.deepEqual(await p.grants.setAppRoleAction(NOTES, ids.alice, "owner"), {
      ok: false,
      message: `"owner" is not a role Notes declares.`,
    });
    assert.equal(await count("admin_audit_log"), before);
  });

  test("a global app lists every user, and its roles are set without a grant, as roles", async () => {
    signIn("admin");
    assert.deepEqual(await p.grants.setAppRoleAction(EVERYONE, ids.dave, "lead"), { ok: true, changed: true });
    assert.equal(await count("user_app_grants", `user_id = '${ids.dave}' and app_slug = '${EVERYONE}' and role_only`), 1);
    const list = await p.grants.listAppAccess(EVERYONE);
    assert.equal(list.global, true);
    assert.deepEqual(
      list.rows.map((r) => r.name),
      ["Admin", "Alice", "Bob", "Carol", "Dave", "Member"],
    );
    const dave = list.rows.find((r) => r.userId === ids.dave)!;
    assert.deepEqual([dave.role, dave.roleSource, dave.grantedAt, dave.grantedBy], ["lead", "assigned", null, null]);
    assert.equal(list.rows.find((r) => r.userId === ids.carol)?.roleSource, "default");
    assert.deepEqual(await p.grants.revokeAppAccess(EVERYONE, ids.dave), {
      ok: false,
      message: "Everyone has Everyone. A global app isn't revoked one person at a time.",
    });
    assert.deepEqual(await p.grants.searchUsersForGrant(EVERYONE, "a"), []);

    // Back to the default: on a global app, that is no row at all.
    assert.deepEqual(await p.grants.setAppRoleAction(EVERYONE, ids.dave, null), { ok: true, changed: true });
    assert.equal(await grantRow(ids.dave, EVERYONE), undefined);
    assert.deepEqual(await p.grants.setAppRoleAction(EVERYONE, ids.dave, "lead"), { ok: true, changed: true });
  });

  test("a role the manifest no longer declares is flagged, under no declared role", async () => {
    signIn("admin");
    await sql`update public.user_app_grants set role = 'author' where user_id = ${ids.bob} and app_slug = ${NOTES}`;
    const bob = (await p.grants.listAppAccess(NOTES)).rows.find((r) => r.userId === ids.bob)!;
    assert.deepEqual([bob.role, bob.roleSource, bob.roleStale], ["author", "assigned", true]);
    // Back to a declared one.
    assert.deepEqual(await p.grants.setAppRoleAction(NOTES, ids.bob, "editor"), { ok: true, changed: true });
  });

  test("the search matches a name or an email, leaves holders out, takes wildcards and the escape literally and stops at ten", async () => {
    signIn("admin");
    const names = [
      "100% Sure",
      "snake_case",
      "Hey!",
      "back\\slash",
      ...Array.from({ length: 12 }, (_, i) => `Tester ${i + 1}`),
    ];
    for (const name of names) {
      await sql`
        insert into public.users (email, display_name)
        values (${`${name.toLowerCase().replace(/[^a-z0-9]+/g, ".")}-${run}@example.org`}, ${name})
      `;
    }
    // Alice and Bob hold Notes; Carol doesn't.
    const forNotes = async (q: string) => (await p.grants.searchUsersForGrant(NOTES, q)).map((u) => u.name);
    assert.deepEqual(await forNotes("ALICE"), []);
    assert.deepEqual(await forNotes("carol"), ["Carol"]);
    assert.deepEqual(await forNotes(`carol-${run}@example`), ["Carol"]);
    assert.deepEqual(await forNotes("100%"), ["100% Sure"]);
    assert.deepEqual(await forNotes("e_c"), ["snake_case"]);
    // `!` is LIKE's escape character here, and still matches itself.
    assert.deepEqual(await forNotes("y!"), ["Hey!"]);
    assert.deepEqual(await forNotes("!"), ["Hey!"]);
    assert.deepEqual(await forNotes("!%"), []);
    assert.deepEqual(await forNotes("\\"), ["back\\slash"]);
    assert.deepEqual(await forNotes("   "), []);
    const testers = await forNotes("tester");
    assert.equal(testers.length, 10);
    assert.ok(testers.every((n) => n.startsWith("Tester ")));
    assert.deepEqual(await forNotes("x".repeat(201)), []);
    assert.deepEqual(await p.grants.searchUsersForGrant(NOTES, { q: "a" } as never), []);
    await assert.rejects(p.grants.searchUsersForGrant(`missing-${run}`, "a"), /App not found/);
  });

  test("revoking takes the grant, the install and the widgets, is audited, and a second revoke changes nothing and says so", async () => {
    signIn("admin");
    await sql`insert into public.user_apps (user_id, app_slug) values (${ids.alice}, ${NOTES})`;
    await sql`insert into public.dashboard_widgets (user_id, app_slug, widget_id) values (${ids.alice}, ${NOTES}, 'latest')`;
    assert.deepEqual(await p.grants.revokeAppAccess(NOTES, ids.alice), { ok: true, changed: true });
    assert.equal(await grantRow(ids.alice, NOTES), undefined);
    assert.equal(await count("user_apps", `user_id = '${ids.alice}' and app_slug = '${NOTES}'`), 0);
    assert.equal(await count("dashboard_widgets", `user_id = '${ids.alice}' and app_slug = '${NOTES}'`), 0);
    assert.deepEqual((await audited("user.grant.revoke", ids.alice)).at(-1)?.details, { appSlug: NOTES });

    // Revoking again leaves things as they are, and records nothing, and the
    // pages are refreshed anyway.
    const before = await count("admin_audit_log");
    revalidated();
    assert.deepEqual(await p.grants.revokeAppAccess(NOTES, ids.alice), { ok: true, changed: false });
    assert.deepEqual(revalidated(), ACCESS_PAGES);
    assert.equal(await count("admin_audit_log"), before);
  });

  // ── a role is never access ───────────────────────────────────────────────

  test("a role on a global app is only a role: once the app stops being global, nobody has it through one", async () => {
    signIn("admin");
    const appsDir = path.join(work, "apps");
    const roleOnly = async () =>
      Object.fromEntries(
        (await sql`select user_id, role_only from public.user_app_grants where app_slug = ${TEAM}`).map((r) => [
          r.user_id,
          r.role_only,
        ]),
      );
    /** What a signed-in person gets from Team's session route. */
    const route = async (who: keyof typeof ids) => {
      signIn(who);
      try {
        return (await p.authTier.resolveAuthTier({ appSlug: TEAM, accepted: ["session"], mount: "authenticated" })).kind;
      } finally {
        signIn("admin");
      }
    };

    // Roles set while it's global: rows that record only a role.
    assert.deepEqual(await p.grants.setAppRoleAction(TEAM, ids.alice, "lead"), { ok: true, changed: true });
    assert.deepEqual(await p.grants.setAppRoleAction(TEAM, ids.bob, "member"), { ok: true, changed: true });
    assert.deepEqual(await p.grants.setAppRoleAction(TEAM, ids.carol, "lead"), { ok: true, changed: true });
    assert.deepEqual(await roleOnly(), { [ids.alice]: true, [ids.bob]: true, [ids.carol]: true });

    // A release step while it's global changes none of them.
    const first = await p.sync.syncAppRegistry(sql, mirrored(), appsDir, []);
    assert.deepEqual(first.globalEnded, []);
    assert.deepEqual(await roleOnly(), { [ids.alice]: true, [ids.bob]: true, [ids.carol]: true });
    // While it's global, everyone has it.
    assert.equal(await route("dave"), "resolved");

    let restore = rebuilt(p.registry.appRegistry, TEAM, { global: false });
    try {
      const ended = await p.sync.syncAppRegistry(sql, mirrored(), appsDir, []);
      // Alice, Bob and Carol had it, by a role, and have no grant: it needs
      // grants, because the app stopped being global.
      assert.deepEqual(ended.globalEnded, [{ slug: TEAM, roleOnly: 3, lost: 3 }]);
      assert.deepEqual((await audited("app.global.ended", TEAM)).map((r) => r.details), [{ roleOnly: 3, lost: 3 }]);
      const endedAt = (await p.access.getAppBuildStatus()).needsGrants[TEAM];
      assert.equal(endedAt?.reason, "global-ended");
      assert.equal(typeof endedAt?.since, "string");

      // Nobody has it now, by any path: not the people with a role, and not
      // anyone else.
      for (const who of ["alice", "bob", "carol", "dave"] as const) {
        assert.equal(await p.access.hasAppGrant(ids[who], TEAM), false, who);
        assert.ok(!(await p.access.getUserGrantedSlugs(ids[who])).includes(TEAM), who);
        assert.deepEqual(await p.access.filterHeldApps(ids[who], [TEAM, NOTES]).then((s) => s.includes(TEAM)), false, who);
        assert.equal(await route(who), "forbidden", who);
      }
      assert.equal((await p.adminActions.getAppGrantCounts())[TEAM], undefined);

      // The Access tab: nobody with access, three with a role and none.
      const list = await p.grants.listAppAccess(TEAM);
      assert.deepEqual([list.global, list.rows, list.needsGrants], [false, [], endedAt]);
      assert.deepEqual(
        list.roleOnly.map((r) => [r.name, r.role, r.roleStale]),
        [
          ["Alice", "lead", false],
          ["Bob", "member", false],
          ["Carol", "lead", false],
        ],
      );

      // A role can be cleared, not changed: that would be a role for someone
      // without the app.
      assert.deepEqual(await p.grants.setAppRoleAction(TEAM, ids.alice, "member"), {
        ok: false,
        message: "This person has a role in Team but no access. Grant it first.",
      });
      assert.deepEqual(await p.grants.setAppRoleAction(TEAM, ids.bob, null), { ok: true, changed: true });
      assert.equal(await grantRow(ids.bob, TEAM), undefined);

      // Someone with only a role is offered by the search, and granting makes
      // the role a grant.
      assert.deepEqual((await p.grants.searchUsersForGrant(TEAM, "alice")).map((u) => u.name), ["Alice"]);
      assert.deepEqual(await p.grants.grantAppAccess(TEAM, ids.alice, "lead"), { ok: true, changed: true });
      assert.deepEqual(await grantRow(ids.alice, TEAM), { role: "lead", granted_by: ids.admin });
      assert.deepEqual((await audited("user.grant.add", ids.alice)).at(-1)?.details, { appSlug: TEAM, role: "lead" });
      assert.equal(await p.access.hasAppGrant(ids.alice, TEAM), true);
      assert.equal(await route("alice"), "resolved");
      assert.deepEqual(await p.grants.searchUsersForGrant(TEAM, "alice"), []);
      // Someone has it, so the reminder that nobody did goes.
      assert.equal((await p.grants.listAppAccess(TEAM)).needsGrants, null);
      assert.equal((await p.access.getAppBuildStatus()).needsGrants[TEAM], undefined);
      // Carol still has only her role.
      assert.equal(await route("carol"), "forbidden");
    } finally {
      restore();
    }

    // Global again: Alice's grant stays a grant, and a role set on it now
    // doesn't make it a role. Back to Default, it's still a grant.
    const again = await p.sync.syncAppRegistry(sql, mirrored(), appsDir, []);
    assert.deepEqual(again.globalEnded, []);
    assert.deepEqual(await roleOnly(), { [ids.alice]: false, [ids.carol]: true });
    assert.equal(await route("dave"), "resolved");
    assert.deepEqual(await p.grants.setAppRoleAction(TEAM, ids.alice, "member"), { ok: true, changed: true });
    assert.deepEqual(await p.grants.setAppRoleAction(TEAM, ids.alice, null), { ok: true, changed: true });
    assert.deepEqual(await grantRow(ids.alice, TEAM), { role: null, granted_by: ids.admin });
    assert.deepEqual(await roleOnly(), { [ids.alice]: false, [ids.carol]: true });
    // Default for Carol, who has only a role: the row goes.
    assert.deepEqual(await p.grants.setAppRoleAction(TEAM, ids.carol, null), { ok: true, changed: true });
    assert.equal(await grantRow(ids.carol, TEAM), undefined);

    // Not global once more: Alice, granted, keeps it. Nobody who had it is
    // left without a grant, so it needs none: recorded, and not marked.
    restore = rebuilt(p.registry.appRegistry, TEAM, { global: false });
    try {
      const nobody = await p.sync.syncAppRegistry(sql, mirrored(), appsDir, []);
      assert.deepEqual(nobody.globalEnded, [{ slug: TEAM, roleOnly: 0, lost: 0 }]);
      assert.deepEqual((await audited("app.global.ended", TEAM)).at(-1)?.details, { roleOnly: 0, lost: 0 });
      assert.equal((await p.access.getAppBuildStatus()).needsGrants[TEAM], undefined);
      assert.equal(await route("alice"), "resolved");
      assert.equal(await route("dave"), "forbidden");
    } finally {
      restore();
    }
    await p.sync.syncAppRegistry(sql, mirrored(), appsDir, []);
  });

  test("a role change that a revoke beats records nothing", async () => {
    signIn("admin");
    await sql`delete from public.user_app_grants where app_slug = ${NOTES} and user_id = ${ids.dave}`;
    assert.deepEqual(await p.grants.grantAppAccess(NOTES, ids.dave, "viewer"), { ok: true, changed: true });
    // Dave's grant is gone the moment the role is written: a trigger skips
    // the update, as a revoke landing first leaves it nothing to update.
    await sql.unsafe(`
      create function public.skip_role_update_${run}() returns trigger language plpgsql as $$ begin return null; end $$;
      create trigger skip_role_update_${run} before update on public.user_app_grants
        for each row when (old.user_id = '${ids.dave}') execute function public.skip_role_update_${run}();
    `);
    const before = await count("admin_audit_log", `action = 'user.role.set'`);
    try {
      assert.deepEqual(await p.grants.setAppRoleAction(NOTES, ids.dave, "editor"), { ok: true, changed: false });
    } finally {
      await sql.unsafe(`
        drop trigger skip_role_update_${run} on public.user_app_grants;
        drop function public.skip_role_update_${run}();
      `);
    }
    assert.equal(await count("admin_audit_log", `action = 'user.role.set'`), before);
    assert.equal((await grantRow(ids.dave, NOTES))?.role, "viewer");
    // And a revoke that really landed first: refused, nothing recorded.
    assert.deepEqual(await p.grants.revokeAppAccess(NOTES, ids.dave), { ok: true, changed: true });
    assert.deepEqual(await p.grants.setAppRoleAction(NOTES, ids.dave, "editor"), {
      ok: false,
      message: "Grant this person Notes before setting their role.",
    });
    assert.equal(await count("admin_audit_log", `action = 'user.role.set'`), before);
  });

  // ── the menu bar, with an install of an app the user doesn't hold ────────

  test("the menu bar reorders the apps a person holds, and an install they don't hold keeps its place", async () => {
    signIn("admin");
    // Bob holds Notes and Vault, and has an install of Drive App, which he no
    // longer holds once it is switched off.
    assert.equal((await p.grants.grantAppAccess(VAULT, ids.bob)).ok, true);
    await sql`delete from public.user_apps where user_id = ${ids.bob}`;
    await sql`
      insert into public.user_apps (user_id, app_slug, position)
      values (${ids.bob}, ${NOTES}, 0), (${ids.bob}, ${DRIVE_APP}, 1), (${ids.bob}, ${VAULT}, 2)
    `;
    await sql`
      insert into public.user_app_grants (user_id, app_slug, granted_by, role_only)
      values (${ids.bob}, ${DRIVE_APP}, ${ids.admin}, false)
      on conflict (user_id, app_slug) do nothing
    `;
    await sql`update public.apps set is_active = false where slug = ${DRIVE_APP}`;
    try {
      signIn("bob");
      assert.deepEqual((await p.myApps.getMyInstalledApps()).map((a) => a.slug), [NOTES, VAULT]);
      await p.myApps.reorderMyApps([VAULT, NOTES]);
      assert.deepEqual((await p.myApps.getMyInstalledApps()).map((a) => a.slug), [VAULT, NOTES]);
      const order = await sql`select app_slug from public.user_apps where user_id = ${ids.bob} order by position, app_slug`;
      assert.deepEqual(order.map((r) => r.app_slug), [VAULT, DRIVE_APP, NOTES]);
      // The list it checks against is the held one.
      await assert.rejects(p.myApps.reorderMyApps([VAULT, DRIVE_APP, NOTES]), /does not match/);
      await assert.rejects(p.myApps.reorderMyApps([VAULT, VAULT]), /Duplicate app/);
    } finally {
      await sql`update public.apps set is_active = true where slug = ${DRIVE_APP}`;
      signIn("admin");
    }
    // Switched on again, it's back where it was.
    signIn("bob");
    assert.deepEqual((await p.myApps.getMyInstalledApps()).map((a) => a.slug), [VAULT, DRIVE_APP, NOTES]);
    signIn("admin");
  });

  test("when grants can't be read, the dashboard and the menu bar still show the global apps", async () => {
    signIn("bob");
    await sql`insert into public.user_apps (user_id, app_slug, position) values (${ids.bob}, ${EVERYONE}, 3) on conflict do nothing`;
    await sql`alter table public.user_app_grants rename to user_app_grants_away`;
    try {
      const { result, lines } = await quietErrors(() => p.myApps.getMyInstalledApps());
      assert.deepEqual(result.map((a) => a.slug), [EVERYONE]);
      assert.ok(lines.some((l) => l.includes("could not read the user's grants")), lines.join("\n"));
      const held = await quietErrors(() => p.access.filterHeldApps(ids.bob, [NOTES, EVERYONE, VAULT]));
      assert.deepEqual(held.result, [EVERYONE]);
      const installed = await quietErrors(() => p.access.getUserApps(ids.bob));
      assert.deepEqual(installed.result, [EVERYONE]);
      // A grant that can't be read is no grant.
      const one = await quietErrors(() => p.access.hasAppGrant(ids.bob, NOTES));
      assert.equal(one.result, false);
    } finally {
      await sql`alter table public.user_app_grants_away rename to user_app_grants`;
      signIn("admin");
    }
  });

  // ── an app out of the build ──────────────────────────────────────────────

  test("an app this build doesn't carry: an admin can list and revoke its grants and keys, audited, and nothing else", async () => {
    signIn("admin");
    await sql`insert into public.apps (slug, name, is_active) values (${GONE}, 'Gone App', true)`;
    await sql`insert into public.user_app_grants (user_id, app_slug, granted_by, role_only) values (${ids.carol}, ${GONE}, ${ids.admin}, false)`;
    const key = await p.apiKeys.mintApiKey({ appSlug: GONE, label: "Old sync", scopes: ["*"], createdBy: ids.admin, expiresAt: null });

    const list = await p.grants.listAppAccess(GONE);
    assert.deepEqual([list.global, list.inBuild, list.needsGrants, list.roleOnly], [false, false, null, []]);
    assert.deepEqual(list.rows.map((r) => [r.name, r.role, r.roleSource]), [["Carol", null, "none"]]);
    assert.deepEqual((await p.keys.listAppApiKeys(GONE)).map((k) => k.label), ["Old sync"]);

    // Granting, roles and keys need the manifest.
    const notInBuild = { ok: false, message: "That app isn't in this build." };
    assert.deepEqual(await p.grants.grantAppAccess(GONE, ids.dave), notInBuild);
    assert.deepEqual(await p.grants.setAppRoleAction(GONE, ids.carol, null), notInBuild);
    assert.deepEqual(await p.keys.mintAppApiKey(GONE, { label: "x", scopes: ["*"], expiresInDays: null }), notInBuild);

    assert.deepEqual(await p.grants.revokeAppAccess(GONE, ids.carol), { ok: true, changed: true });
    assert.equal(await grantRow(ids.carol, GONE), undefined);
    assert.deepEqual((await audited("user.grant.revoke", ids.carol)).at(-1)?.details, { appSlug: GONE, notInBuild: true });
    assert.deepEqual(await p.keys.revokeAppApiKey(GONE, key.id), { ok: true });
    assert.equal(await count("app_api_keys", `app_slug = '${GONE}' and revoked_at is null`), 0);
    assert.deepEqual((await audited("app.apikey.revoke", GONE)).at(-1)?.details, { keyId: key.id, notInBuild: true });

    // A slug this database has never had.
    const unknown = { ok: false, message: "That app isn't known here." };
    assert.deepEqual(await p.grants.revokeAppAccess(`unknown-${run}`, ids.carol), unknown);
    assert.deepEqual(await p.keys.revokeAppApiKey(`unknown-${run}`, key.id), unknown);
    await assert.rejects(p.grants.listAppAccess(`unknown-${run}`), /App not found/);
    await assert.rejects(p.keys.listAppApiKeys(`unknown-${run}`), /App not found/);
  });

  // ── API keys ─────────────────────────────────────────────────────────────

  /** What the gateway decides for a request presenting `key` to VAULT's `pattern` route. */
  const keyed = (key: string | null, verb: string, pattern: string) =>
    p.authTier.resolveAuthTier({
      appSlug: VAULT,
      accepted: ["key"],
      mount: "public",
      request: new Request(`http://localhost/api/p/${VAULT}/${pattern}`, {
        headers: key ? { authorization: `Bearer ${key}` } : {},
      }),
      method: verb,
      routePattern: pattern,
    });

  let scopedKey = "";
  let scopedId = "";
  /** A live key for every key route. */
  let everyKey = "";

  test("a key is shown once, stored only as its digest, and audited without it", async () => {
    signIn("admin");
    const result = await p.keys.mintAppApiKey(VAULT, { label: "  Billing sync  ", scopes: ["GET /items"], expiresInDays: 90 });
    assert.equal(result.ok, true);
    if (!result.ok) return;
    scopedKey = result.minted.key;
    scopedId = result.minted.id;
    assert.match(scopedKey, /^mixk_[A-Za-z0-9_-]{43}$/);
    assert.equal(result.minted.hint, scopedKey.slice(0, 11));

    const [row] = await sql`select row_to_json(k)::text as row, label, scopes, expires_at, created_by from public.app_api_keys k where id = ${scopedId}`;
    assert.ok(!String(row.row).includes(scopedKey.slice(5)), "the key is stored");
    assert.equal(row.label, "Billing sync");
    assert.deepEqual(row.scopes, ["GET /items"]);
    assert.equal(row.created_by, ids.admin);
    const days = (new Date(row.expires_at).getTime() - Date.now()) / 86_400_000;
    assert.ok(days > 89.9 && days <= 90, `expires in ${days} days`);

    const [audit] = await audited("app.apikey.create", VAULT);
    assert.equal(audit.actor_id, ids.admin);
    assert.deepEqual(Object.keys(audit.details as object).sort(), ["expiresAt", "keyId", "label", "scopes"]);
    assert.deepEqual((audit.details as { scopes: string[] }).scopes, ["GET /items"]);
    const [{ log }] = await sql`select string_agg(row_to_json(l)::text, '\n') as log from public.admin_audit_log l`;
    assert.ok(!String(log).includes(scopedKey.slice(5)), "the key reached the audit log");
  });

  test("a key reaches the routes it is scoped to and no others, and only its own app's", async () => {
    signIn("admin");
    assert.deepEqual(await keyed(scopedKey, "GET", "items"), { kind: "resolved", tier: "key", dbUser: null });
    assert.deepEqual(await keyed(scopedKey, "POST", "items"), { kind: "not-served" });
    assert.deepEqual(await keyed(scopedKey, "GET", "export"), { kind: "not-served" });
    assert.deepEqual(await keyed(null, "GET", "items"), { kind: "not-served" });
    assert.deepEqual(await keyed(`${scopedKey}x`, "GET", "items"), { kind: "not-served" });
    assert.equal(await p.apiKeys.resolveApiKey(scopedKey, NOTES), null);
  });

  test("minting refuses no scope, a route that takes no key, every route beside a route, and a bad label or expiry", async () => {
    signIn("admin");
    const before = await Promise.all([count("app_api_keys"), count("admin_audit_log")]);
    const mint = (req: Record<string, unknown>, slug = VAULT) =>
      p.keys.mintAppApiKey(slug, { label: "CI", scopes: ["GET /items"], expiresInDays: null, ...req } as never);
    for (const [req, message, slug] of [
      [{ scopes: [] }, "Pick at least one route for the key."],
      [{ scopes: ["GET /export"] }, "A scope names a route that doesn't accept an API key."],
      [{ scopes: ["DELETE /items"] }, "A scope names a route that doesn't accept an API key."],
      [{ scopes: ["*", "GET /items"] }, "Choose every key route, or particular routes, not both."],
      [{ label: "   " }, "Give the key a label, so it can be told apart later."],
      [{ label: "x".repeat(81) }, "Keep the label to 80 characters."],
      [{ label: "two\nlines" }, LABEL_REFUSED],
      // A line or paragraph separator, a direction override that would show
      // the label back to front, and a zero-width space.
      [{ label: "two\u2028lines" }, LABEL_REFUSED],
      [{ label: "two\u2029paragraphs" }, LABEL_REFUSED],
      [{ label: "invoice\u202Etxt.exe" }, LABEL_REFUSED],
      [{ label: "zero\u200Bwidth" }, LABEL_REFUSED],
      [{ expiresInDays: 7 }, "Expiry must be 30, 90 or 365 days, or never."],
      [{ scopes: "GET /items" }, undefined],
      [{}, "Notes has no route that accepts an API key.", NOTES],
      [{}, "That app isn't in this build.", `missing-${run}`],
    ] as [Record<string, unknown>, string | undefined, string?][]) {
      const result = await mint(req, slug);
      assert.equal(result.ok, false, JSON.stringify(req));
      if (message && !result.ok) assert.equal(result.message, message, JSON.stringify(req));
    }
    assert.deepEqual(await Promise.all([count("app_api_keys"), count("admin_audit_log")]), before);
  });

  test("every key route is a scope of its own; a revoked key is refused on its next request", async () => {
    signIn("admin");
    const every = await p.keys.mintAppApiKey(VAULT, { label: "Everything", scopes: ["*"], expiresInDays: null });
    assert.ok(every.ok);
    if (!every.ok) return;
    everyKey = every.minted.key;
    assert.deepEqual(await keyed(every.minted.key, "POST", "items"), { kind: "resolved", tier: "key", dbUser: null });

    assert.deepEqual(await p.keys.revokeAppApiKey(VAULT, scopedId), { ok: true });
    assert.deepEqual(await keyed(scopedKey, "GET", "items"), { kind: "not-served" });
    assert.deepEqual((await audited("app.apikey.revoke", VAULT)).at(-1)?.details, { keyId: scopedId });

    const before = await count("admin_audit_log");
    assert.deepEqual(await p.keys.revokeAppApiKey(VAULT, scopedId), {
      ok: false,
      message: "That key is already revoked, or isn't one of this app's.",
    });
    // Another app's screen can't revoke it.
    assert.deepEqual(await p.keys.revokeAppApiKey(NOTES, every.minted.id), {
      ok: false,
      message: "That key is already revoked, or isn't one of this app's.",
    });
    assert.deepEqual(await p.keys.revokeAppApiKey(VAULT, "not-an-id"), { ok: false, message: "That request isn't valid." });
    assert.equal(await count("admin_audit_log"), before);
    assert.deepEqual(await keyed(every.minted.key, "GET", "items"), { kind: "resolved", tier: "key", dbUser: null });
  });

  test("where the route can't be named, a key scoped to routes is refused and a key for every route isn't", async () => {
    signIn("admin");
    const scoped = await p.keys.mintAppApiKey(VAULT, { label: "Items only", scopes: ["GET /items"], expiresInDays: null });
    assert.ok(scoped.ok);
    if (!scoped.ok) return;
    const unnamed = (key: string, at: { method?: string; routePattern?: string }) =>
      p.authTier.resolveAuthTier({
        appSlug: VAULT,
        accepted: ["key"],
        mount: "public",
        request: new Request(`http://localhost/api/p/${VAULT}/items`, { headers: { authorization: `Bearer ${key}` } }),
        ...at,
      });
    for (const at of [{}, { method: "GET" }, { routePattern: "items" }]) {
      assert.deepEqual(await unnamed(scoped.minted.key, at), { kind: "not-served" }, JSON.stringify(at));
      assert.deepEqual(await unnamed(everyKey, at), { kind: "resolved", tier: "key", dbUser: null }, JSON.stringify(at));
    }
    assert.deepEqual(await unnamed(scoped.minted.key, { method: "GET", routePattern: "items" }), {
      kind: "resolved",
      tier: "key",
      dbUser: null,
    });
  });

  test("a different extension under the slug revokes its keys, and the list says which revocations that was", async () => {
    signIn("admin");
    const result = await p.sync.syncAppRegistry(sql, mirrored(), path.join(work, "apps"), [installOf(VAULT)]);
    assert.deepEqual(
      result.replaced.map((r) => [r.slug, r.apiKeysRevoked]),
      [[VAULT, 2]],
    );

    const keys = await p.keys.listAppApiKeys(VAULT);
    assert.deepEqual(
      keys.map((k) => [k.label, k.revokedAt !== null, k.revokedOnIdentityChange, k.createdByName]),
      [
        ["Items only", true, true, "Admin"],
        ["Everything", true, true, "Admin"],
        ["Billing sync", true, false, "Admin"],
      ],
    );
    assert.ok(keys.every((k) => !("digest" in k)), "the list carries a digest");
    assert.equal(await count("app_api_keys", `app_slug = '${VAULT}' and revoked_at is null`), 0);
    assert.equal(await count("apps", `slug = '${VAULT}' and is_active`), 0);
  });
});
