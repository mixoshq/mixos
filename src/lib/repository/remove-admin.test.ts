/* This Source Code Form is subject to the terms of the Mozilla Public
 * License, v. 2.0. If a copy of the MPL was not distributed with this
 * file, You can obtain one at https://mozilla.org/MPL/2.0/. */

/**
 * The Remove button's preview and removal: the work behind the server actions
 * in ./remove-actions.ts, given an admin and a deployment of the test's
 * choosing.
 *
 * The removal is the real one (./remove.ts), each in a checkout of its own,
 * with a stand-in for the registry generator and a stubbed database pool that
 * answers the register lock and the applied theme and keeps the audit rows, as
 * ./remove.test.ts runs it.
 */

import { after, beforeEach, describe, test } from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import type { AdminActor } from "../apps/admin-audit";
import { BUILT_DEPLOYMENT_REMOVE_NOTICE } from "../platform/build";
import { tryAcquireCheckoutLock } from "../platform/checkout-lock";
import { LOCKED_MESSAGE } from "./pending-admin";
import { previewForButton, removeFromButton, type RemoveContext } from "./remove-admin";

// ── the database ────────────────────────────────────────────────────────────

interface AuditRow {
  actor_id: unknown;
  actor_email: unknown;
  action: string;
  target_id: unknown;
  details: Record<string, unknown>;
}

let audit: AuditRow[] = [];
let lockStatements = 0;
let rowLockTaken = false;
let storedTheme: string | null = null;

const pool = Object.assign(
  async (strings: TemplateStringsArray, ...values: unknown[]) => {
    const text = strings.join("?").replace(/\s+/g, " ").trim();
    if (text.startsWith("insert into public._platform_locks")) {
      lockStatements++;
      return rowLockTaken ? [] : [{ holder: values[1] }];
    }
    if (text.startsWith("update public._platform_locks")) {
      lockStatements++;
      return [{ held: 1 }];
    }
    if (text.startsWith("delete from public._platform_locks")) {
      lockStatements++;
      return [];
    }
    if (text.startsWith("select value from public.platform_settings where key = 'theme'")) {
      return storedTheme === null ? [] : [{ value: storedTheme }];
    }
    if (text.startsWith("insert into public.admin_audit_log")) {
      audit.push({
        actor_id: values[0],
        actor_email: values[1],
        action: values[2] as string,
        target_id: values[4],
        details: (values[5] as { json: Record<string, unknown> }).json,
      });
      return [];
    }
    throw new Error(`unexpected statement: ${text}`);
  },
  { json: (value: unknown) => ({ json: value }) },
);
(globalThis as { __pg?: unknown }).__pg = pool;

// ── checkouts ───────────────────────────────────────────────────────────────

const tmp = fs.realpathSync(fs.mkdtempSync(path.join(os.tmpdir(), "mixos-remove-admin-")));
after(() => fs.rmSync(tmp, { recursive: true, force: true }));

/** The stand-in generator: "registers" every folder in apps/, connectors/ and themes/. */
const STAND_IN = path.join(tmp, "stand-in.mjs");
fs.writeFileSync(
  STAND_IN,
  `import fs from "node:fs";
const list = (dir) => (fs.existsSync(dir) ? fs.readdirSync(dir).filter((n) => !n.startsWith(".")) : []);
fs.mkdirSync("src/generated", { recursive: true });
fs.writeFileSync("src/generated/app-registry.ts", "export const appRegistry = " + JSON.stringify(list("apps").map((slug) => ({ slug })), null, 2) + ";\\n");
fs.writeFileSync("src/generated/connector-registry.ts", "export const connectorRegistry = " + JSON.stringify(list("connectors").map((name) => ({ name })), null, 2) + ";\\n");
fs.writeFileSync("src/generated/theme-registry.ts", "export const themeRegistry = " + JSON.stringify(list("themes").map((slug) => ({ slug })), null, 2) + ";\\n");
`,
);

let n = 0;
let root: string;
let revalidated: string[] = [];

beforeEach(() => {
  root = path.join(tmp, `checkout-${n++}`);
  for (const dir of ["apps", "connectors", "themes"]) fs.mkdirSync(path.join(root, dir), { recursive: true });
  audit = [];
  lockStatements = 0;
  rowLockTaken = false;
  storedTheme = null;
  revalidated = [];
});

const ADMIN: AdminActor = { id: "11111111-2222-3333-4444-555555555555", email: "admin@example.com" };
const NOT_ADMIN = async (): Promise<AdminActor> => {
  throw new Error("Admin access required");
};

function context(extra: Partial<RemoveContext> = {}): RemoveContext {
  return {
    admin: async () => ADMIN,
    builtDeployment: () => false,
    revalidate: (p, type) => revalidated.push(type ? `${p} (${type})` : p),
    servesWithoutRebuild: () => true,
    root,
    generator: STAND_IN,
    ...extra,
  };
}

const write = (rel: string, data: string) => {
  fs.mkdirSync(path.dirname(path.join(root, rel)), { recursive: true });
  fs.writeFileSync(path.join(root, rel), data);
};
const exists = (rel: string) => fs.existsSync(path.join(root, rel));

// ── admin first ─────────────────────────────────────────────────────────────

describe("both actions require an admin before anything else", () => {
  test("they are refused, and nothing is read, locked, changed or audited", async () => {
    write("apps/acme/app.json", '{"name":"Acme"}');
    let built = 0;
    const ctx = context({ admin: NOT_ADMIN, builtDeployment: () => (built++, false) });
    await assert.rejects(previewForButton({ kind: "app", slug: "acme" }, ctx), /Admin access required/);
    await assert.rejects(removeFromButton({ kind: "app", slug: "acme" }, ctx), /Admin access required/);
    assert.equal(built, 0);
    assert.equal(lockStatements, 0);
    assert.deepEqual(audit, []);
    assert.ok(exists("apps/acme/app.json"));
  });

  test("the admin is asked before the input is read, and input that isn't a target is refused", async () => {
    let asked = 0;
    for (const input of [{ kind: "app", slug: "../etc" }, { kind: "plugin", slug: "acme" }, { slug: "acme" }, null]) {
      const outcome = await removeFromButton(input, context({ admin: async () => (asked++, ADMIN) }));
      assert.equal(outcome.ok, false);
      assert.equal(!outcome.ok && outcome.code, "not-installed");
    }
    assert.equal(asked, 4);
    assert.equal(lockStatements, 0);
    assert.deepEqual(audit, []);
  });
});

// ── a built deployment ──────────────────────────────────────────────────────

describe("a built deployment refuses, as information", () => {
  test("the preview says how removing works instead", async () => {
    const outcome = await previewForButton({ kind: "app", slug: "acme" }, context({ builtDeployment: () => true }));
    assert.deepEqual(outcome, {
      ok: false,
      code: "unsupported-environment",
      message: BUILT_DEPLOYMENT_REMOVE_NOTICE,
      tone: "info",
    });
    assert.deepEqual(audit, []);
  });

  test("the removal is refused before the locks, and the refusal is audited as the button's", async () => {
    write("apps/acme/app.json", '{"name":"Acme"}');
    const outcome = await removeFromButton({ kind: "app", slug: "acme" }, context({ builtDeployment: () => true }));
    assert.equal(!outcome.ok && outcome.tone, "info");
    assert.equal(lockStatements, 0);
    assert.ok(exists("apps/acme/app.json"));
    assert.equal(audit.length, 1);
    assert.equal(audit[0].action, "app.remove.rejected");
    assert.equal(audit[0].actor_email, ADMIN.email);
    assert.deepEqual(audit[0].details, {
      via: "button",
      reason: "unsupported-environment",
      message: BUILT_DEPLOYMENT_REMOVE_NOTICE,
    });
  });
});

// ── the preview ─────────────────────────────────────────────────────────────

describe("the preview", () => {
  test("names what goes, where it came from, what depends on it, and the command", async () => {
    write("connectors/probe/connector.json", '{"name":"probe","displayName":"Probe"}');
    write(
      "connectors/probe/.registry.json",
      JSON.stringify({
        source: "https://mixos.org",
        kind: "connector",
        slug: "probe",
        version: "2.0.1",
        gitTag: null,
        commitSha: "c".repeat(40),
        contentHash: `sha256-${"A".repeat(43)}=`,
        filesHash: `sha256-${"B".repeat(43)}=`,
        repository: { owner: "acme", name: "probe", subpath: null },
        requiresMixOS: null,
      }),
    );
    write("apps/mailer/app.json", '{"name":"Mailer","connectors":["probe"]}');
    write("apps/digest/app.json", '{"name":"Digest","optionalConnectors":["probe"]}');
    const outcome = await previewForButton({ kind: "connector", slug: "probe" }, context());
    assert.equal(outcome.ok, true);
    if (!outcome.ok) return;
    const { preview } = outcome;
    assert.equal(preview.name, "Probe");
    assert.equal(preview.path, "connectors/probe");
    assert.deepEqual(preview.installed, { host: "mixos.org", version: "2.0.1" });
    assert.deepEqual(preview.blockers.map((b) => [b.code, b.apps]), [["required-by", [{ slug: "mailer", name: "Mailer" }]]]);
    assert.deepEqual(preview.warnings.map((w) => w.code), ["optional-for"]);
    assert.equal(preview.command, "npm run remove -- connector/probe");
    assert.equal(lockStatements, 0);
    assert.deepEqual(audit, []);
  });

  test("of nothing there is a refusal, not an error", async () => {
    const outcome = await previewForButton({ kind: "theme", slug: "ghost" }, context());
    assert.equal(outcome.ok, false);
    assert.equal(!outcome.ok && outcome.code, "not-installed");
    assert.equal(!outcome.ok && outcome.tone, "warning");
  });
});

// ── removing ────────────────────────────────────────────────────────────────

describe("removing", () => {
  test("calls through to removal under both locks, audits the admin with via: button, and hands back the commit", async () => {
    write("apps/acme/app.json", '{"name":"Acme"}');
    const outcome = await removeFromButton({ kind: "app", slug: "acme" }, context());
    assert.equal(outcome.ok, true);
    if (!outcome.ok) return;
    assert.equal(outcome.result.path, "apps/acme");
    assert.equal(outcome.result.name, "Acme");
    assert.equal(outcome.result.servesNow, true);
    assert.equal(outcome.result.handBack.branch, "remove-app-acme");
    assert.ok(!exists("apps/acme"));
    assert.ok(lockStatements >= 3);
    assert.deepEqual(revalidated, ["/admin/apps"]);
    assert.equal(audit.length, 1);
    assert.equal(audit[0].action, "app.remove");
    assert.equal(audit[0].actor_id, ADMIN.id);
    assert.equal(audit[0].actor_email, ADMIN.email);
    assert.equal(audit[0].details.via, "button");
  });

  test("a theme revalidates the layout too, since the applied one may be the one that went", async () => {
    write("themes/aurora/theme.json", '{"name":"Aurora"}');
    write("themes/dusk/theme.json", '{"name":"Dusk"}');
    storedTheme = "dusk";
    const outcome = await removeFromButton({ kind: "theme", slug: "dusk" }, context({ servesWithoutRebuild: () => false }));
    assert.equal(outcome.ok, true);
    if (!outcome.ok) return;
    assert.equal(outcome.result.servesNow, false);
    assert.deepEqual(outcome.result.warnings.map((w) => w.code), ["applied-theme"]);
    assert.deepEqual(revalidated, ["/admin/themes", "/ (layout)"]);
  });

  test("a refusal is a value the dialog shows, and nothing changes", async () => {
    write("themes/aurora/theme.json", '{"name":"Aurora"}');
    const outcome = await removeFromButton({ kind: "theme", slug: "aurora" }, context());
    assert.equal(outcome.ok, false);
    assert.equal(!outcome.ok && outcome.code, "last-theme");
    assert.equal(!outcome.ok && outcome.tone, "warning");
    assert.ok(exists("themes/aurora/theme.json"));
    assert.deepEqual(revalidated, []);
    assert.equal(audit[0].action, "theme.remove.rejected");
  });

  test("another administrator holding a lock reads as that, with Try again", async () => {
    write("apps/acme/app.json", '{"name":"Acme"}');
    rowLockTaken = true;
    assert.deepEqual(await removeFromButton({ kind: "app", slug: "acme" }, context()), {
      ok: false,
      code: "locked",
      message: LOCKED_MESSAGE,
      tone: "neutral",
    });
    rowLockTaken = false;
    const held = tryAcquireCheckoutLock(root, "the registry generator");
    try {
      const outcome = await removeFromButton({ kind: "app", slug: "acme" }, context());
      assert.equal(!outcome.ok && outcome.code, "locked");
      assert.match(!outcome.ok ? outcome.message : "", /the registry generator/);
    } finally {
      held.release();
    }
    assert.ok(exists("apps/acme/app.json"));
  });
});
