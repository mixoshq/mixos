/* This Source Code Form is subject to the terms of the Mozilla Public
 * License, v. 2.0. If a copy of the MPL was not distributed with this
 * file, You can obtain one at https://mozilla.org/MPL/2.0/. */

/**
 * What a disabled connector looks like to the code that holds it. Reading and
 * writing the switch itself, and each place it is enforced, are tested against
 * a real Postgres in ./switch.integration.test.ts.
 */

import { afterEach, test } from "node:test";
import assert from "node:assert/strict";
import { z } from "zod";
import { AppClientError, connectorErrorOf, createAppClient } from "../apps/sdk";
import { defineRoute, runRoute } from "../apps/route";
import { isConnectorError } from "./errors";
import { connectorErrorEnvelope, isAdminActionable } from "./response";
import {
  ConnectorDisabledError,
  connectorSwitchKey,
  disabledConnector,
  isDisabledConnector,
} from "./switch";

// Route telemetry is written through the lazy pool in src/lib/db/client.ts,
// which reads `globalThis.__pg` first. A no-op there keeps it off any database.
(globalThis as { __pg?: unknown }).__pg = Object.assign(async () => [], {
  json: (value: unknown) => value,
});

const realFetch = globalThis.fetch;
afterEach(() => {
  globalThis.fetch = realFetch;
});

/** The stand-in, typed as an app would call the connector it replaces. */
type Acme = {
  name: string;
  configured: boolean;
  listItems(): Promise<unknown>;
  createItem(data: unknown): Promise<unknown>;
  initialize(credentials: Record<string, string>): Promise<void>;
};

const acme = () => disabledConnector("acme", "Acme") as unknown as Acme;

/** The refusal every call on the stand-in ends in. */
function isRefusal(err: unknown): boolean {
  assert.ok(err instanceof ConnectorDisabledError, `got ${String(err)}`);
  assert.ok(isConnectorError(err));
  assert.equal(err.category, "unconfigured");
  assert.equal(err.connectorName, "acme");
  assert.equal(err.userMessage, "Acme has been disabled by an administrator.");
  return true;
}

test("the switch is one platform_settings key per connector", () => {
  assert.equal(connectorSwitchKey("acme"), "connector.disabled.acme");
});

test("every call on a disabled connector's stand-in fails with the switch's message", async () => {
  const conn = acme();
  assert.equal(conn.name, "acme");
  assert.equal(conn.configured, false);

  await assert.rejects(conn.listItems(), isRefusal);
  await assert.rejects(conn.createItem({ name: "x" }), isRefusal);
  // Even the platform's own entry point: nothing can hand it credentials.
  await assert.rejects(conn.initialize({ apiKey: "k" }), isRefusal);
});

test("awaiting or logging the stand-in does not set off the refusal", async () => {
  const conn = disabledConnector("acme");
  assert.equal(await Promise.resolve(conn), conn);
  assert.equal(JSON.stringify(conn), '{"name":"acme","configured":false}');
  assert.equal(typeof String(conn), "string");
});

test("the stand-in is told apart from a connector, and from a look-alike", () => {
  assert.equal(isDisabledConnector(disabledConnector("acme")), true);
  assert.equal(isDisabledConnector({ name: "acme", configured: false }), false);
  assert.equal(isDisabledConnector(null), false);
  assert.equal(isDisabledConnector("acme"), false);
});

test("the refusal is a 503 with no Retry, and only an admin gets the way back", () => {
  const user = connectorErrorEnvelope(new ConnectorDisabledError("acme", "Acme"));
  assert.equal(user.status, 503);
  assert.equal(user.body.error.category, "unconfigured");
  // What ConnectorErrorState reads to show "Not connected" and no Retry button.
  assert.equal(isAdminActionable(user.body.error.category), true);
  assert.equal(user.body.error.message, "Acme has been disabled by an administrator.");
  assert.equal(user.body.error.connector, "Acme");
  assert.equal("adminHint" in user.body.error, false);

  const admin = connectorErrorEnvelope(new ConnectorDisabledError("acme", "Acme"), {
    isAdmin: true,
  });
  assert.match(admin.body.error.adminHint ?? "", /Enable it in Administration → Connectors/);
  assert.equal(admin.body.error.adminActionUrl, "/admin/connectors?connector=acme");
});

test("an app route that calls a disabled connector answers with what the app SDK shows", async () => {
  const route = defineRoute({
    output: z.object({ items: z.array(z.string()) }),
    handler: async (ctx) => ({
      items: (await (ctx.connectors.acme as unknown as Acme).listItems()) as string[],
    }),
  });

  const original = console.error;
  console.error = () => {};
  let res: Response;
  try {
    res = await runRoute(route, new Request("https://mos.test/api/apps/acme-app/items"), {
      context: {
        user: { id: "user-1", isAdmin: false },
        connectors: { acme: disabledConnector("acme", "Acme") },
        auth: "session",
      } as never,
      appSlug: "acme-app",
      routePattern: "items",
      method: "GET",
    });
  } finally {
    console.error = original;
  }
  assert.equal(res.status, 503);

  globalThis.fetch = async () => res;
  const err = await createAppClient("acme-app")
    .call("GET /items")
    .then(
      () => assert.fail("the call should have failed"),
      (e: unknown) => e,
    );

  assert.ok(err instanceof AppClientError);
  assert.equal(err.message, "Acme has been disabled by an administrator.");
  assert.equal(connectorErrorOf(err)?.error.category, "unconfigured");
});
