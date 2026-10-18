/* This Source Code Form is subject to the terms of the Mozilla Public
 * License, v. 2.0. If a copy of the MPL was not distributed with this
 * file, You can obtain one at https://mozilla.org/MPL/2.0/. */

/**
 * Same name, different extension, for connectors and themes, against a real
 * Postgres: the release step records each one's identity, turns off a
 * connector that is a different one than recorded, keeping its credentials,
 * and only records and audits a theme's change. Enabling such a connector
 * needs its name typed.
 *
 * Skipped unless MIXOS_TEST_DATABASE_URL names a server this may create and
 * drop a database on. Its name ends in this run's own suffix, and it is
 * dropped when the run finishes:
 *
 *   docker run -d --name identity -e POSTGRES_PASSWORD=pw -p 127.0.0.1:55432:5432 postgres:17
 *   MIXOS_TEST_DATABASE_URL=postgres://postgres:pw@127.0.0.1:55432/postgres \
 *     npx tsx --test scripts/sync-identities.integration.test.ts
 */

import { after, before, describe, test } from "node:test";
import assert from "node:assert/strict";
import { randomBytes } from "node:crypto";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import postgres, { type Sql } from "postgres";
import type { ConnectorManifest } from "../src/lib/connectors/types";
import type { RegistryInstall } from "../src/lib/repository/install-record";
import { migratePlatform } from "./platform-migrations";
import { RELEASE_STEP_ACTOR } from "./sync-app-registry";
import { syncAndReportIdentities, type IdentityBuild } from "./sync-identities";

const REPO = path.resolve(__dirname, "..");
const MIGRATIONS = path.join(REPO, "supabase", "migrations");
const serverUrl = process.env.MIXOS_TEST_DATABASE_URL;
const skip = serverUrl ? false : "set MIXOS_TEST_DATABASE_URL to run against a real Postgres";

const run = randomBytes(3).toString("hex");
const database = `mixos_identities_${run}`;
const scratch = fs.mkdtempSync(path.join(os.tmpdir(), "mixos-identities-"));

/** Tenant credentials saved. */
const CRM = `crm-${run}`;
/** A user's OAuth grant saved, and the connector switched off by an admin. */
const MAIL = `mail-${run}`;
/** No credentials. */
const MAPS = `maps-${run}`;
const DUSK = `dusk-${run}`;
const DAWN = `dawn-${run}`;

function installOf(kind: "connector" | "theme", slug: string, fields: Partial<RegistryInstall> = {}): RegistryInstall {
  return {
    kind,
    slug,
    version: "1.0.0",
    gitTag: "v1.0.0",
    commitSha: "a".repeat(40),
    source: "https://mixos.org",
    repository: { owner: "acme", name: `mixos-${slug}`, subpath: null },
    requiresMixOS: null,
    modified: false,
    ...fields,
  };
}

const build = (installs: RegistryInstall[]): IdentityBuild => ({
  connectors: [CRM, MAIL, MAPS],
  themes: [DAWN, DUSK],
  installs,
});

/** What the release step printed while `fn` ran. */
async function quietly<T>(fn: () => Promise<T>): Promise<{ value: T; printed: string }> {
  const log = console.log;
  let printed = "";
  console.log = (...args: unknown[]) => {
    printed += `${args.join(" ")}\n`;
  };
  try {
    return { value: await fn(), printed };
  } finally {
    console.log = log;
  }
}

describe("a connector or a theme under a name a different one had", { skip }, () => {
  let admin: Sql;
  let sql: Sql;
  let actor: { id: string; email: string };

  const release = (installs: RegistryInstall[]) => quietly(() => syncAndReportIdentities(sql, build(installs)));

  async function settings(prefix: string): Promise<Record<string, string>> {
    const rows = await sql`
      select key, value from public.platform_settings where key like ${`${prefix}%`} order by key
    `;
    return Object.fromEntries(rows.map((r) => [r.key, r.value]));
  }
  const setting = async (key: string) =>
    (await sql`select value from public.platform_settings where key = ${key}`)[0]?.value as string | undefined;

  async function audited(action: string, targetId: string) {
    const rows = await sql`
      select actor_id, actor_email, target_type, details
      from public.admin_audit_log
      where action = ${action} and target_id = ${targetId}
      order by created_at
    `;
    return rows.map((r) => ({ ...r }));
  }

  before(async () => {
    admin = postgres(serverUrl!, { max: 1, onnotice: () => {} });
    await admin.unsafe(`create database ${database}`);
    const u = new URL(serverUrl!);
    u.pathname = `/${database}`;
    sql = postgres(u.toString(), { max: 1, onnotice: () => {} });

    // The schema, with credentials already saved.
    await quietly(() => migratePlatform(sql, MIGRATIONS));
    const [user] = await sql`
      insert into public.users (email, display_name, is_admin)
      values (${`admin-${run}@mixos.test`}, 'Admin', true)
      returning id, email
    `;
    actor = { id: user.id, email: user.email };
    await sql`insert into public.connector_configs (connector_name, encrypted_credentials) values (${CRM}, 'SEALED')`;
    await sql`
      insert into public.user_connector_oauth (user_id, connector_name, encrypted_credentials)
      values (${user.id}, ${MAIL}, 'SEALED')
    `;
    await sql`insert into public.platform_settings (key, value) values ('theme', ${DUSK})`;

    // The platform's own pool, for Enable, reads these on its first query.
    process.env.DATABASE_URL = u.toString();
    process.env.PGSSLMODE = u.searchParams.get("sslmode") ?? "disable";
    const { connectorRegistry } = await import("../src/generated/connector-registry");
    const template = JSON.parse(
      fs.readFileSync(path.join(REPO, "connectors", "_template", "connector.json"), "utf8"),
    ) as ConnectorManifest;
    (connectorRegistry as ConnectorManifest[]).push({ ...template, name: CRM }, { ...template, name: MAIL });
  });

  after(async () => {
    const { sql: platformSql } = await import("../src/lib/db/client");
    await platformSql.end();
    await sql?.end();
    if (admin) {
      await admin.unsafe(`drop database if exists ${database} with (force)`);
      await admin.end();
    }
    fs.rmSync(scratch, { recursive: true, force: true });
  });

  test("the first release step records every connector and theme, and changes nothing else", async () => {
    assert.deepEqual(await settings("connector.identity."), {});
    const { value } = await release([installOf("connector", MAPS), installOf("theme", DAWN)]);
    // Every connector with credentials is in this build, so none is marked missing.
    assert.deepEqual(value, { connectors: [], themes: [], missing: [], returned: [] });
    assert.deepEqual(await settings("connector.missing."), {});
    assert.deepEqual(await settings("connector.identity."), {
      [`connector.identity.${CRM}`]: "local",
      [`connector.identity.${MAIL}`]: "local",
      [`connector.identity.${MAPS}`]: `https://mixos.org connector/${MAPS} acme/mixos-${MAPS}`,
    });
    assert.deepEqual(await settings("theme.identity."), {
      [`theme.identity.${DAWN}`]: `https://mixos.org theme/${DAWN} acme/mixos-${DAWN}`,
      [`theme.identity.${DUSK}`]: "local",
    });
    assert.deepEqual(await settings("connector.disabled."), {});
    assert.deepEqual(await settings("connector.replaced."), {});
  });

  test("a connector reinstalled from the Registry is turned off and marked, keeping its credentials", async () => {
    const started = Date.now();
    const { value, printed } = await release([
      installOf("connector", CRM),
      installOf("connector", MAPS),
      installOf("theme", DAWN),
    ]);
    const identity = `https://mixos.org connector/${CRM} acme/mixos-${CRM}`;
    assert.deepEqual(value.connectors, [{ name: CRM, previous: "local", identity, disabled: true }]);

    const disabledAt = await setting(`connector.disabled.${CRM}`);
    assert.ok(disabledAt && Date.parse(disabledAt) >= started - 1000, `disabled at ${disabledAt}`);
    assert.equal(await setting(`connector.replaced.${CRM}`), "local");
    assert.equal(await setting(`connector.identity.${CRM}`), identity);
    const [credentials] = await sql`select encrypted_credentials from public.connector_configs where connector_name = ${CRM}`;
    assert.equal(credentials.encrypted_credentials, "SEALED");

    assert.deepEqual(await audited("connector.identity.changed", CRM), [
      {
        actor_id: null,
        actor_email: RELEASE_STEP_ACTOR,
        target_type: "connector",
        details: {
          previous: "local",
          identity: {
            source: "https://mixos.org",
            kind: "connector",
            slug: CRM,
            repository: { owner: "acme", name: `mixos-${CRM}` },
          },
          disabled: true,
        },
      },
    ]);
    assert.match(printed, new RegExp(`${CRM}: a different connector than before \\(was local, with no install record; now from mixos\\.org, acme/mixos-${CRM}\\) — disabled until an admin enables it by typing its name; its credentials are kept`));

    // The same build again: recorded, so nothing more.
    await release([installOf("connector", CRM), installOf("connector", MAPS), installOf("theme", DAWN)]);
    assert.equal((await audited("connector.identity.changed", CRM)).length, 1);
    assert.equal(await setting(`connector.disabled.${CRM}`), disabledAt);
  });

  test("Enable needs its name typed, then clears the mark and records what it replaced", async () => {
    const { setConnectorEnabled } = await import("../src/lib/connectors/switch-admin");
    for (const typed of [undefined, "", "crm", CRM.toUpperCase()]) {
      await assert.rejects(
        setConnectorEnabled(CRM, true, actor, typed),
        /replaces a different connector with the same name\. Type its name to enable it\./,
      );
    }
    assert.ok(await setting(`connector.disabled.${CRM}`));

    await setConnectorEnabled(CRM, true, actor, CRM);
    assert.equal(await setting(`connector.disabled.${CRM}`), undefined);
    assert.equal(await setting(`connector.replaced.${CRM}`), undefined);
    const [enabled] = await audited("connector.enable", CRM);
    assert.deepEqual([enabled.actor_email, enabled.details.replaced], [actor.email, "local"]);

    // Disable and Enable again: nothing to confirm now, and nothing recorded about it.
    await setConnectorEnabled(CRM, false, actor);
    await setConnectorEnabled(CRM, true, actor);
    const [, again] = await audited("connector.enable", CRM);
    assert.equal(again.details.replaced, undefined);
  });

  test("a new version from the same repository is an update, and a theme's change is only recorded", async () => {
    const update = installOf("connector", CRM, {
      version: "2.0.0",
      commitSha: "b".repeat(40),
      repository: { owner: "ACME", name: `MIXOS-${CRM}`, subpath: "connectors/crm" },
    });
    const { value, printed } = await release([
      update,
      installOf("connector", MAPS),
      installOf("theme", DAWN),
      installOf("theme", DUSK, { repository: { owner: "acme", name: "dusk", subpath: null } }),
    ]);
    assert.deepEqual(value.connectors, []);
    assert.equal(await setting(`connector.disabled.${CRM}`), undefined);

    // The applied theme, reinstalled: recorded and audited, still applied, nothing switched.
    assert.deepEqual(value.themes, [
      { slug: DUSK, previous: "local", identity: `https://mixos.org theme/${DUSK} acme/dusk`, applied: true },
    ]);
    assert.equal(await setting("theme"), DUSK);
    const [changed] = await audited("theme.identity.changed", DUSK);
    assert.deepEqual([changed.target_type, changed.details.previous, changed.details.applied], ["theme", "local", true]);
    assert.match(printed, new RegExp(`${DUSK}: a different theme than before \\(was local, with no install record; now from mixos\\.org, acme/dusk\\), and it is the applied theme`));
  });

  test("one an admin had already turned off stays off from when they did, and the row says so", async () => {
    await sql`insert into public.platform_settings (key, value) values (${`connector.disabled.${MAIL}`}, '2026-01-01T00:00:00.000Z')`;
    const { value } = await release([
      installOf("connector", CRM, { repository: { owner: "acme", name: `mixos-${CRM}`, subpath: null } }),
      installOf("connector", MAIL, { source: "http://localhost:4321" }),
      installOf("connector", MAPS),
      installOf("theme", DAWN),
      installOf("theme", DUSK, { repository: { owner: "acme", name: "dusk", subpath: null } }),
    ]);
    assert.deepEqual(
      value.connectors.map((c) => [c.name, c.disabled]),
      [[MAIL, false]],
    );
    assert.equal(await setting(`connector.disabled.${MAIL}`), "2026-01-01T00:00:00.000Z");
    assert.equal(await setting(`connector.replaced.${MAIL}`), "local");
    const [changed] = await audited("connector.identity.changed", MAIL);
    assert.equal(changed.details.disabled, false);
  });

  test("a connector that leaves the build and comes back as a different one is caught", async () => {
    await quietly(() => syncAndReportIdentities(sql, { connectors: [], themes: [DAWN, DUSK], installs: [] }));
    assert.equal(await setting(`connector.identity.${MAPS}`), `https://mixos.org connector/${MAPS} acme/mixos-${MAPS}`);
    const { value } = await release([installOf("connector", MAPS, { repository: { owner: "mallory", name: "maps", subpath: null } })]);
    assert.ok(value.connectors.some((c) => c.name === MAPS && c.disabled));
    assert.equal(await setting(`connector.replaced.${MAPS}`), `https://mixos.org connector/${MAPS} acme/mixos-${MAPS}`);
  });
});
