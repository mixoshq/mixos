/* This Source Code Form is subject to the terms of the Mozilla Public
 * License, v. 2.0. If a copy of the MPL was not distributed with this
 * file, You can obtain one at https://mozilla.org/MPL/2.0/. */

/**
 * The MCP tab's per-tool switches against a real Postgres, through the doors a
 * client and an admin actually use: the MCP route (`POST /api/mcp`) with a
 * token issued before any switch moved, the consent screen's list and its
 * action, and the exported server actions in ./tool-settings-actions.ts with
 * the session stubbed.
 *
 * What it proves:
 *
 *   - the platform schema makes the switches' table, with RLS on and no policy;
 *   - both actions refuse a signed-in user who isn't an admin, and no session,
 *     and write nothing;
 *   - every tool starts off: `tools/list` is empty, the consent screen offers
 *     nothing, and `tools/call` answers a disabled tool exactly as it answers a
 *     tool the app never declared, after reading the switches for both;
 *   - someone without the app gets the same refusal whatever tool they name,
 *     disabled, enabled or undeclared;
 *   - switching one tool on lists it and makes it callable, on the token issued
 *     before; its sibling stays off; switching it off again refuses its next
 *     call on that same token;
 *   - the consent action keeps only apps with an enabled tool, whatever a
 *     crafted form names;
 *   - a switch the database can't read is an off switch, and the admin screen
 *     says it couldn't read rather than showing every tool off;
 *   - each change is audited, and a tool the manifest doesn't declare is
 *     refused;
 *   - revoking a grant takes that app's tools off the token on its next call,
 *     and leaves the token, and the user's other apps, alone;
 *   - an app that stops being global takes its tools from everyone it wasn't
 *     granted to, a role kept from when it was global included.
 *
 * Skipped unless MIXOS_TEST_DATABASE_URL names a server this may create and
 * drop databases on. Every name ends in this run's own suffix, and both
 * databases are dropped when the run finishes:
 *
 *   docker run -d --name tools -e POSTGRES_PASSWORD=pw -p 127.0.0.1:55432:5432 postgres:17
 *   MIXOS_TEST_DATABASE_URL=postgres://postgres:pw@127.0.0.1:55432/postgres \
 *     npx tsx --test src/lib/mcp/tool-switches.integration.test.ts
 */

import { after, before, describe, test } from "node:test";
import assert from "node:assert/strict";
import { randomBytes } from "node:crypto";
import fs from "node:fs";
import { registerHooks } from "node:module";
import os from "node:os";
import path from "node:path";
import { pathToFileURL } from "node:url";
import postgres, { type Sql } from "postgres";
import { z } from "zod";
import { NextRequest } from "next/server";
import type { AppManifest } from "../apps/types";

const REPO = path.resolve(__dirname, "..", "..", "..");
const MIGRATIONS = path.join(REPO, "supabase", "migrations");
const serverUrl = process.env.MIXOS_TEST_DATABASE_URL;
const skip = serverUrl ? false : "set MIXOS_TEST_DATABASE_URL to run against a real Postgres";

const run = randomBytes(3).toString("hex");
const database = `mixos_tools_${run}`;

/** Two tools, granted to Alice. */
const LEDGER = `ledger-${run}`;
/** Held by everyone, one tool. */
const ALMANAC = `almanac-${run}`;

const STUBS = new Map<string, string>([
  [
    "@/lib/auth/session",
    `const current = () => (globalThis as { __toolsSession?: unknown }).__toolsSession ?? null;
export async function getReadOnlySession() { return current(); }
export async function requireReadOnlySession() {
  const session = current();
  if (!session) throw new Error("no session in this test");
  return session;
}
export const requireServerSession = requireReadOnlySession;
`,
  ],
  ["next/cache", `export function revalidatePath() {}\nexport function revalidateTag() {}\n`],
]);

/** A tool module: a zod input schema the route can describe, and a handler. */
const toolModule = (name: string) => `
const z = (globalThis as { __toolsZod?: any }).__toolsZod;
export const inputSchema = z.object({ q: z.string().optional() });
export default async function handler() { return { from: ${JSON.stringify(name)} }; }
`;

function manifest(slug: string, name: string, extra: Partial<AppManifest>): AppManifest {
  return {
    slug,
    name,
    description: "",
    tagline: null,
    icon: "book",
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
    mcp: [],
    ...extra,
  };
}

const APPS = [
  manifest(LEDGER, "Ledger", {
    mcp: [
      { name: "peek", description: "Peek at the ledger.", sources: ["mixos"] },
      { name: "poke", description: "Poke the ledger.", sources: ["mixos"] },
    ],
  }),
  manifest(ALMANAC, "Almanac", {
    global: true,
    mcp: [{ name: "glance", description: "Glance at the almanac.", sources: ["mixos"] }],
  }),
];

/** The runner reports every step; the tests read the database instead. */
async function quietly<T>(fn: () => Promise<T>): Promise<T> {
  const { log, error } = console;
  console.log = () => {};
  console.error = () => {};
  try {
    return await fn();
  } finally {
    console.log = log;
    console.error = error;
  }
}

describe("per-tool MCP switches", { skip }, () => {
  let admin: Sql;
  let sql: Sql;
  let work: string;
  let resolver: ReturnType<typeof registerHooks> | undefined;
  let p: {
    actions: typeof import("./tool-settings-actions");
    grants: typeof import("../apps/grant-actions");
    tools: typeof import("./tools");
    store: typeof import("./store");
    route: typeof import("../../app/api/mcp/route");
    authorize: typeof import("../../app/(main)/oauth/authorize/authorize-action");
    registry: typeof import("../../generated/app-registry");
    db: typeof import("../db/client");
  };

  const ids = { admin: "", alice: "", bob: "" };
  let clientId = "";
  /** Issued to Alice before any switch moved, consenting to both apps. */
  let token = "";

  const signIn = (who: keyof typeof ids | null) => {
    (globalThis as { __toolsSession?: unknown }).__toolsSession =
      who === null ? null : { user: { id: ids[who], email: `${who}-${run}@example.com`, name: who, isAdmin: who === "admin" } };
  };

  /** One JSON-RPC call to the MCP route, as a client sends it: Alice's token unless another is given. */
  async function rpc(method: string, params?: unknown, bearer = token) {
    const res = await p.route.POST(
      new NextRequest("http://localhost/api/mcp", {
        method: "POST",
        headers: { authorization: `Bearer ${bearer}`, "content-type": "application/json" },
        body: JSON.stringify({ jsonrpc: "2.0", id: 1, method, params }),
      }),
    );
    assert.equal(res.status, 200);
    return ((await res.json()) as { result: Record<string, unknown> }).result;
  }

  const listed = async () => ((await rpc("tools/list")).tools as { name: string }[]).map((t) => t.name);
  const call = async (name: string, bearer = token) => {
    const result = await rpc("tools/call", { name, arguments: {} }, bearer);
    const text = (result.content as { text: string }[])[0].text;
    return result.isError ? { error: text } : { ok: JSON.parse(text) as unknown };
  };

  /** What `fn` wrote to `console.error`, kept out of the output. */
  async function errorsFrom<T>(fn: () => Promise<T>): Promise<{ result: T; lines: string[] }> {
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

  async function switches(slug = LEDGER) {
    const rows = await sql`
      select tool_name, enabled, updated_by from public.app_mcp_tool_settings where app_slug = ${slug} order by tool_name
    `;
    return rows.map((r) => ({ ...r }));
  }

  async function audited(prefix: string) {
    const rows = await sql`
      select actor_id, action, target_type, target_id, details from public.admin_audit_log
      where action like ${`${prefix}%`} order by created_at
    `;
    return rows.map((r) => ({ ...r }));
  }

  before(async () => {
    admin = postgres(serverUrl!, { max: 1, onnotice: () => {} });
    await admin.unsafe(`create database ${database}`);
    const u = new URL(serverUrl!);
    u.pathname = `/${database}`;
    sql = postgres(u.toString(), { max: 1, onnotice: () => {} });
    const { migratePlatform } = await import("../../../scripts/platform-migrations");
    await migratePlatform(sql, MIGRATIONS, () => {});

    work = fs.mkdtempSync(path.join(os.tmpdir(), "mixos-tool-switches-"));
    const urls = new Map<string, string>();
    for (const [specifier, source] of STUBS) {
      const file = path.join(work, "stubs", `${specifier.replace(/[^a-z]+/g, "-")}.ts`);
      fs.mkdirSync(path.dirname(file), { recursive: true });
      fs.writeFileSync(file, source);
      urls.set(specifier, pathToFileURL(file).href);
    }
    for (const app of APPS) {
      for (const tool of app.mcp) {
        const file = path.join(work, "apps", app.slug, "mcp", `${tool.name}.ts`);
        fs.mkdirSync(path.dirname(file), { recursive: true });
        fs.writeFileSync(file, toolModule(tool.name));
      }
    }
    (globalThis as { __toolsZod?: unknown }).__toolsZod = z;
    const prefixes = APPS.map((a) => [`@apps/${a.slug}/`, a.slug] as const);
    resolver = registerHooks({
      resolve(specifier, context, nextResolve) {
        const stub = urls.get(specifier);
        if (stub) return nextResolve(stub, context);
        for (const [prefix, slug] of prefixes) {
          if (specifier.startsWith(prefix)) {
            const file = path.join(work, "apps", slug, `${specifier.slice(prefix.length)}.ts`);
            return nextResolve(pathToFileURL(file).href, context);
          }
        }
        return nextResolve(specifier, context);
      },
    });

    process.env.DATABASE_URL = u.toString();
    process.env.PGSSLMODE = u.searchParams.get("sslmode") ?? "disable";
    process.env.NEXTAUTH_URL ??= "http://localhost:3000";
    process.env.MCP_TOKEN_KEY = randomBytes(32).toString("hex");

    p = {
      actions: await import("./tool-settings-actions"),
      grants: await import("../apps/grant-actions"),
      tools: await import("./tools"),
      store: await import("./store"),
      route: await import("../../app/api/mcp/route"),
      authorize: await import("../../app/(main)/oauth/authorize/authorize-action"),
      registry: await import("../../generated/app-registry"),
      db: await import("../db/client"),
    };
    p.registry.appRegistry.push(...APPS);

    for (const app of APPS) {
      await sql`insert into public.apps (slug, name, is_active) values (${app.slug}, ${app.name}, true)`;
    }
    for (const who of Object.keys(ids) as (keyof typeof ids)[]) {
      const [row] = await sql`
        insert into public.users (email, display_name, is_admin)
        values (${`${who}-${run}@example.com`}, ${who}, ${who === "admin"}) returning id
      `;
      ids[who] = row.id as string;
    }
    await sql`insert into public.user_app_grants (user_id, app_slug, granted_by, role_only) values (${ids.alice}, ${LEDGER}, ${ids.admin}, false)`;

    const client = await p.store.registerClient({ clientName: "Claude", redirectUris: ["https://claude.example/cb"] });
    clientId = client.clientId;
    token = (await p.store.issueTokens({ clientId, userId: ids.alice, grantedApps: [LEDGER, ALMANAC] })).accessToken;
  });

  after(async () => {
    try {
      if (p) {
        for (const a of APPS) {
          const at = p.registry.appRegistry.findIndex((r) => r.slug === a.slug);
          if (at >= 0) p.registry.appRegistry.splice(at, 1);
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

  // ── the migration ────────────────────────────────────────────────────────

  test("the platform schema makes the table, with RLS on and no policy", async () => {
    const [state] = await sql`
      select
        (select relrowsecurity from pg_class where oid = 'public.app_mcp_tool_settings'::regclass) as rls,
        (select count(*)::int from pg_policies where tablename = 'app_mcp_tool_settings') as policies
    `;
    assert.deepEqual({ ...state }, { rls: true, policies: 0 });
  });

  // ── an admin first ───────────────────────────────────────────────────────

  test("both actions refuse a signed-in user who isn't an admin, and no session, and write nothing", async () => {
    for (const who of ["bob", null] as const) {
      signIn(who);
      const refusal = who ? /Admin access required/ : /no session/;
      await assert.rejects(p.actions.getMcpToolSettings(LEDGER), refusal);
      await assert.rejects(p.actions.setMcpToolEnabledAction(LEDGER, "peek", true), refusal);
    }
    assert.deepEqual(await switches(), []);
    assert.deepEqual(await audited("app.mcp.tool."), []);
  });

  // ── off by default ───────────────────────────────────────────────────────

  test("every tool starts off: nothing listed, nothing offered, and a call answers as for a tool never declared", async () => {
    signIn("admin");
    assert.deepEqual(await p.actions.getMcpToolSettings(LEDGER), { peek: false, poke: false });
    assert.deepEqual(await p.tools.appsWithEnabledMcpTools(), []);
    assert.deepEqual(await p.tools.consentableApps(ids.alice), []);
    assert.deepEqual(await listed(), []);

    const disabled = await call(`${LEDGER}__peek`);
    const undeclared = await call(`${LEDGER}__nope`);
    assert.deepEqual(disabled, { error: `[NOT_EXPOSED] "Ledger" does not expose a tool "peek".` });
    assert.deepEqual(undeclared, { error: `[NOT_EXPOSED] "Ledger" does not expose a tool "nope".` });
  });

  test("someone without the app is refused the same way whatever tool they name", async () => {
    signIn("admin");
    // Bob consented to Ledger, which nobody granted him.
    const bobs = (await p.store.issueTokens({ clientId, userId: ids.bob, grantedApps: [LEDGER] })).accessToken;
    const refused = { error: `[FORBIDDEN_USER] You don't have access to "Ledger".` };
    assert.deepEqual(await call(`${LEDGER}__peek`, bobs), refused);
    assert.deepEqual(await call(`${LEDGER}__nope`, bobs), refused);
    // Switched on behind the actions' back, so the next test starts clean.
    await sql`insert into public.app_mcp_tool_settings (app_slug, tool_name, enabled) values (${LEDGER}, 'poke', true)`;
    try {
      assert.deepEqual(await call(`${LEDGER}__poke`, bobs), refused);
      assert.deepEqual(await call(`${LEDGER}__poke`), { ok: { from: "poke" } });
    } finally {
      await sql`delete from public.app_mcp_tool_settings where app_slug = ${LEDGER}`;
    }
  });

  test("switching one on lists it and makes it callable on the token issued before; its sibling stays off", async () => {
    signIn("admin");
    assert.deepEqual(await p.actions.setMcpToolEnabledAction(LEDGER, "peek", true), { ok: true });
    assert.deepEqual(await switches(), [{ tool_name: "peek", enabled: true, updated_by: ids.admin }]);
    assert.deepEqual(await audited("app.mcp.tool."), [
      { actor_id: ids.admin, action: "app.mcp.tool.enable", target_type: "app", target_id: LEDGER, details: { tool: "peek" } },
    ]);
    assert.deepEqual(await p.actions.getMcpToolSettings(LEDGER), { peek: true, poke: false });

    assert.deepEqual(await listed(), [`${LEDGER}__peek`]);
    assert.deepEqual(await call(`${LEDGER}__peek`), { ok: { from: "peek" } });
    assert.deepEqual(await call(`${LEDGER}__poke`), { error: `[NOT_EXPOSED] "Ledger" does not expose a tool "poke".` });

    // The consent screen offers the app, with only the enabled tool, to Alice,
    // who holds it; Bob holds nothing with a tool on.
    assert.deepEqual(
      (await p.tools.consentableApps(ids.alice)).map((a) => [a.slug, a.mcp.map((t) => t.name)]),
      [[LEDGER, ["peek"]]],
    );
    assert.deepEqual(await p.tools.consentableApps(ids.bob), []);

    // A global app is everyone's, once one of its tools is on.
    assert.deepEqual(await p.actions.setMcpToolEnabledAction(ALMANAC, "glance", true), { ok: true });
    assert.deepEqual(
      (await p.tools.consentableApps(ids.bob)).map((a) => a.slug),
      [ALMANAC],
    );
    // In registry order.
    assert.deepEqual(await listed(), [`${LEDGER}__peek`, `${ALMANAC}__glance`]);
  });

  test("the consent action keeps only apps with a tool on, whatever the form names", async () => {
    signIn("alice");
    await sql`update public.app_mcp_tool_settings set enabled = false where app_slug = ${ALMANAC}`;
    const form = new FormData();
    form.set("client_id", clientId);
    form.set("redirect_uri", "https://claude.example/cb");
    form.set("code_challenge", "challenge");
    form.set("state", "s");
    for (const slug of [LEDGER, ALMANAC, `missing-${run}`]) form.append("apps", slug);

    const redirected = await p.authorize.approveAuthorization(form).then(
      () => assert.fail("approving should redirect"),
      (err: unknown) => String((err as { digest?: string }).digest ?? err),
    );
    assert.match(redirected, /https:\/\/claude\.example\/cb\?code=/);
    const [code] = await sql`
      select granted_apps from public.oauth_authorization_codes
      where client_id = ${clientId} and user_id = ${ids.alice} order by expires_at desc limit 1
    `;
    assert.deepEqual(code.granted_apps, [LEDGER]);
    await sql`update public.app_mcp_tool_settings set enabled = true where app_slug = ${ALMANAC}`;
  });

  test("switching it off again refuses its next call on that same token", async () => {
    signIn("admin");
    assert.deepEqual(await p.actions.setMcpToolEnabledAction(LEDGER, "peek", false), { ok: true });
    assert.deepEqual(await call(`${LEDGER}__peek`), { error: `[NOT_EXPOSED] "Ledger" does not expose a tool "peek".` });
    assert.deepEqual(await listed(), [`${ALMANAC}__glance`]);
    assert.deepEqual((await audited("app.mcp.tool.")).at(-1)?.action, "app.mcp.tool.disable");
  });

  test("a tool the manifest doesn't declare, or a malformed request, is refused and not audited", async () => {
    signIn("admin");
    const before = (await audited("app.mcp.tool.")).length;
    assert.deepEqual(await p.actions.setMcpToolEnabledAction(LEDGER, "nope", true), {
      ok: false,
      message: `Ledger declares no MCP tool "nope".`,
    });
    assert.deepEqual(await p.actions.setMcpToolEnabledAction(`missing-${run}`, "peek", true), {
      ok: false,
      message: "That app isn't in this build.",
    });
    assert.deepEqual(await p.actions.setMcpToolEnabledAction(LEDGER, "peek", "yes" as never), {
      ok: false,
      message: "That request isn't valid.",
    });
    assert.deepEqual((await switches()).map((s) => s.tool_name), ["peek"]);
    assert.equal((await audited("app.mcp.tool.")).length, before);
  });

  test("a switch the database can't read is off for clients, and the admin screen says it couldn't read", async () => {
    signIn("admin");
    assert.deepEqual(await listed(), [`${ALMANAC}__glance`]);
    await sql`alter table public.app_mcp_tool_settings rename to app_mcp_tool_settings_away`;
    try {
      assert.deepEqual(await quietly(listed), []);
      assert.deepEqual(await quietly(() => call(`${ALMANAC}__glance`)), {
        error: `[NOT_EXPOSED] "Almanac" does not expose a tool "glance".`,
      });
      // The switches are read for a name the app never declared too: the
      // failed read is what shows it.
      const { result, lines } = await errorsFrom(() => call(`${ALMANAC}__nope`));
      assert.deepEqual(result, { error: `[NOT_EXPOSED] "Almanac" does not expose a tool "nope".` });
      assert.ok(lines.some((l) => l.includes("tool switches unreadable")), lines.join("\n"));
      await assert.rejects(p.actions.getMcpToolSettings(ALMANAC), /Could not read the tool switches/);
    } finally {
      await sql`alter table public.app_mcp_tool_settings_away rename to app_mcp_tool_settings`;
    }
    assert.deepEqual(await listed(), [`${ALMANAC}__glance`]);
  });

  test("revoking the grant takes the app's tools off the token, and leaves the token and the other apps alone", async () => {
    signIn("admin");
    assert.deepEqual(await p.actions.setMcpToolEnabledAction(LEDGER, "peek", true), { ok: true });
    assert.deepEqual(await listed(), [`${LEDGER}__peek`, `${ALMANAC}__glance`]);

    assert.deepEqual(await p.grants.revokeAppAccess(LEDGER, ids.alice), { ok: true, changed: true });
    assert.deepEqual(await listed(), [`${ALMANAC}__glance`]);
    assert.deepEqual(await call(`${LEDGER}__peek`), { error: `[FORBIDDEN_USER] You don't have access to "Ledger".` });
    assert.deepEqual(await call(`${ALMANAC}__glance`), { ok: { from: "glance" } });
    const [{ live }] = await sql`
      select count(*)::int as live from public.oauth_tokens
      where user_id = ${ids.alice} and client_id = ${clientId} and revoked_at is null
    `;
    assert.equal(live, 2, "revoking the grant revoked the tokens");
  });

  test("an app that stops being global takes its tools from everyone not granted it, a kept role included", async () => {
    signIn("admin");
    const almanac = APPS.find((a) => a.slug === ALMANAC)!;
    // A role from while it was global, as the release step leaves it.
    await sql`insert into public.user_app_grants (user_id, app_slug, role_only) values (${ids.alice}, ${ALMANAC}, true)`;
    assert.deepEqual(await call(`${ALMANAC}__glance`), { ok: { from: "glance" } });

    almanac.global = false;
    try {
      assert.deepEqual(await listed(), []);
      assert.deepEqual(await call(`${ALMANAC}__glance`), { error: `[FORBIDDEN_USER] You don't have access to "Almanac".` });
      assert.deepEqual(await p.tools.consentableApps(ids.alice), []);

      // Granted, it's back on the same token.
      assert.deepEqual(await p.grants.grantAppAccess(ALMANAC, ids.alice), { ok: true, changed: true });
      assert.deepEqual(await call(`${ALMANAC}__glance`), { ok: { from: "glance" } });
    } finally {
      almanac.global = true;
    }
  });
});
