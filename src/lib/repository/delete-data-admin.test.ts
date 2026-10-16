/* This Source Code Form is subject to the terms of the Mozilla Public
 * License, v. 2.0. If a copy of the MPL was not distributed with this
 * file, You can obtain one at https://mozilla.org/MPL/2.0/. */

/**
 * Delete data's server actions, in the order they check: an admin first, then
 * what they were given, then the name typed, all before the database. The
 * database half, every refusal and the deletion, runs against a real Postgres
 * in ./delete-data.integration.test.ts.
 *
 * The pool here answers nothing: a statement reaching it fails the test.
 */

import { beforeEach, describe, test } from "node:test";
import assert from "node:assert/strict";
import type { AdminActor } from "../apps/admin-audit";
import {
  deleteDataAfterRemoval,
  deleteDataFromButton,
  previewDataForButton,
  type AfterRemovalContext,
  type DataContext,
} from "./delete-data-admin";
import { describeData, type AppDataCounts } from "./delete-data-outcomes";

let statements: string[] = [];
let audit: { action: string; details: Record<string, unknown> }[] = [];
(globalThis as { __pg?: unknown }).__pg = Object.assign(
  async (strings: TemplateStringsArray, ...values: unknown[]) => {
    const text = strings.join("?").replace(/\s+/g, " ").trim();
    if (text.startsWith("insert into public.admin_audit_log")) {
      audit.push({ action: values[2] as string, details: (values[5] as { json: Record<string, unknown> }).json });
      return [];
    }
    statements.push(text);
    throw new Error(`unexpected statement: ${text}`);
  },
  { json: (value: unknown) => ({ json: value }), begin: () => Promise.reject(new Error("unexpected transaction")) },
);

beforeEach(() => {
  statements = [];
  audit = [];
});

const ADMIN: AdminActor = { id: "11111111-2222-3333-4444-555555555555", email: "admin@example.com" };
const NOT_ADMIN = async (): Promise<AdminActor> => {
  throw new Error("Admin access required");
};

function context(extra: Partial<DataContext> = {}): DataContext & { asked: string[] } {
  const asked: string[] = [];
  return {
    asked,
    admin: async () => {
      asked.push("admin");
      return ADMIN;
    },
    inThisBuild: () => {
      asked.push("build");
      return false;
    },
    ownBuildKey: () => null,
    ...extra,
  };
}

describe("an admin first", () => {
  test("both actions are refused before anything else is read", async () => {
    for (const action of [previewDataForButton, deleteDataFromButton]) {
      const ctx = context({ admin: NOT_ADMIN });
      await assert.rejects(action({ kind: "app", slug: "notes", typedSlug: "notes" }, ctx), /Admin access required/);
      assert.deepEqual(ctx.asked, []);
    }
    assert.deepEqual(statements, []);
    assert.deepEqual(audit, []);
  });
});

describe("what they are given", () => {
  test("anything but an app or a connector, by a name, is refused before the database", async () => {
    for (const input of [
      { kind: "theme", slug: "mixos" },
      { kind: "app", slug: "../notes" },
      { kind: "app", slug: "Notes" },
      { kind: "connector" },
      "notes",
      null,
    ]) {
      const ctx = context();
      assert.equal((await previewDataForButton(input, ctx)).ok, false);
      const refused = await deleteDataFromButton({ ...(input as object), typedSlug: "notes" }, ctx);
      assert.deepEqual(
        refused.ok === false && [refused.code, refused.tone],
        ["not-found", "warning"],
        JSON.stringify(input),
      );
      assert.deepEqual(ctx.asked, ["admin", "admin"]);
    }
    assert.deepEqual(statements, []);
  });

  test("deleting needs the name typed, and anything else is refused before the database", async () => {
    for (const typedSlug of ["", "note", "NOTES", "notes_archive", undefined]) {
      const ctx = context();
      const refused = await deleteDataFromButton({ kind: "app", slug: "notes", typedSlug }, ctx);
      assert.equal(refused.ok, false);
      if (!refused.ok) {
        assert.equal(refused.code, typedSlug === undefined ? "not-found" : "not-confirmed");
        if (typedSlug !== undefined) assert.equal(refused.message, "Type notes to delete its data.");
      }
    }
    assert.deepEqual(statements, []);
    assert.deepEqual(audit, [], "a mistyped name was audited as an attempt");
  });
});

describe("right after Remove", () => {
  const after = (serves: boolean): AfterRemovalContext => ({
    servesWithoutRebuild: () => serves,
    database: () => ({ hosts: ["localhost"], local: true }),
    listedInRegistry: async () => false,
    ownBuildKey: () => null,
  });

  test("a production build of the checkout still serves it, so the data is kept, and that is audited", async () => {
    const outcome = await deleteDataAfterRemoval("app", "notes", ADMIN, after(false));
    assert.equal(outcome.ok, false);
    if (!outcome.ok) {
      assert.equal(outcome.code, "still-served");
      assert.match(outcome.message, /serves notes until `npm run build` and a restart/);
    }
    assert.deepEqual(statements, []);
    assert.deepEqual(audit, [
      {
        action: "app.data.delete.rejected",
        details: { via: "button", afterRemoval: true, reason: "still-served", message: !outcome.ok ? outcome.message : "" },
      },
    ]);
  });
});

describe("the words for what goes", () => {
  const counts: AppDataCounts = {
    tables: 2,
    grants: 1,
    installs: 0,
    passwords: 0,
    widgets: 3,
    settings: 0,
    apiKeys: 0,
    mcpToolSwitches: 2,
    scheduledJobs: 0,
    jobRuns: 0,
    migrations: 2,
    telemetryEvents: 1204,
    appOpens: 1,
    mcpAccess: 0,
  };

  test("an app's: its schema and role, each kind with a count above zero, and its record", () => {
    assert.deepEqual(describeData("app", counts, { schema: "app_notes", role: "mixos_app_notes" }), [
      "Its schema, `app_notes`, with 2 tables, and its database role, `mixos_app_notes`",
      "1 grant and 3 dashboard widgets",
      "2 MCP tool switches",
      "2 records of migrations that ran",
      "1,204 telemetry events and 1 recorded open",
      "Its record here: whether it is active, and where it came from",
    ]);
    assert.deepEqual(describeData("app", { ...counts, tables: 0 }, { schema: null, role: null }).slice(0, 1), [
      "1 grant and 3 dashboard widgets",
    ]);
  });

  test("a connector's", () => {
    assert.deepEqual(
      describeData(
        "connector",
        { credentials: 1, connections: 2, scopeStatus: 0, webhookEvents: 1, telemetryEvents: 0, settings: 3 },
        { schema: null, role: null },
      ),
      [
        "Its saved credentials",
        "2 users' own connections",
        "1 webhook replay marker",
        "Its settings here: whether it is switched off, its marks, and where it came from",
      ],
    );
  });
});
