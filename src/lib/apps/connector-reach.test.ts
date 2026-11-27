/* This Source Code Form is subject to the terms of the Mozilla Public
 * License, v. 2.0. If a copy of the MPL was not distributed with this
 * file, You can obtain one at https://mozilla.org/MPL/2.0/. */

/**
 * What an app can call on its connector: the declared methods, and a write
 * only with both keys — its entry asks for "write", and an admin allowed
 * changes. Each missing key is refused in its own words.
 */

import { test } from "node:test";
import assert from "node:assert/strict";
import { inspect } from "node:util";
import { HttpConnector } from "@/lib/connectors/http-connector";
import { isConnectorError } from "@/lib/connectors/errors";
import { disabledConnector } from "@/lib/connectors/switch";
import type { BaseConnector, ConnectorTelemetryDefinition, ConnectorTestResult } from "@/lib/connectors/types";
import { ConnectorChangesNotAllowedError } from "@/lib/connectors/write-policy";
import { ConnectorUseError, appReachRules, narrowConnector } from "./connector-reach";

class CrmConnector extends HttpConnector {
  readonly name = "crm";
  calls: string[] = [];

  async testConnection(): Promise<ConnectorTestResult> {
    return { ok: true };
  }

  async listDeals() {
    this.calls.push("listDeals");
    return [{ id: "1" }];
  }

  async createDeal() {
    this.calls.push("createDeal");
    return { id: "2" };
  }
}

const DECLARED: ConnectorTelemetryDefinition[] = [
  { method: "listDeals", operation: "GET /deals" },
  { method: "createDeal", operation: "POST /deals", mutates: true },
];

type Crm = {
  name: string;
  configured: boolean;
  listDeals(): Promise<unknown>;
  createDeal(): Promise<unknown>;
  request(path: string, init?: RequestInit): Promise<unknown>;
  initialize(c: Record<string, string>): void;
};

function handed(access: "read" | "write", writable: boolean) {
  const connector = new CrmConnector();
  const narrowed = narrowConnector(
    connector,
    DECLARED,
    appReachRules({ appSlug: "ledger", connectorName: "crm", subject: "Acme CRM", need: { access }, writable }),
  ) as unknown as Crm;
  return { connector, narrowed };
}

test("both keys: the app reads and writes", async () => {
  const { connector, narrowed } = handed("write", true);
  assert.deepEqual(await narrowed.listDeals(), [{ id: "1" }]);
  assert.deepEqual(await narrowed.createDeal(), { id: "2" });
  assert.deepEqual(connector.calls, ["listDeals", "createDeal"]);
  // Plain values pass through, the getter's private state included.
  assert.equal(narrowed.name, "crm");
  assert.equal(typeof narrowed.configured, "boolean");
});

test("an app whose entry doesn't ask for write is refused the write, as its own bug", () => {
  const { connector, narrowed } = handed("read", true);
  assert.throws(
    () => narrowed.createDeal(),
    (err: unknown) =>
      err instanceof ConnectorUseError &&
      /^apps\/ledger called crm\.createDeal\(\), which changes data, but its app\.json entry for crm doesn't ask for "access": "write"\.$/.test(
        err.message,
      ),
  );
  assert.deepEqual(connector.calls, [], "the method never ran");
});

test("an app that asked, on an install that hasn't allowed changes, is refused for its admin to fix", () => {
  const { connector, narrowed } = handed("write", false);
  assert.throws(
    () => narrowed.createDeal(),
    (err: unknown) =>
      err instanceof ConnectorChangesNotAllowedError &&
      isConnectorError(err) &&
      err.category === "forbidden" &&
      err.userMessage === "Acme CRM is read-only here, so this change can't be made. An administrator can allow changes." &&
      /allow this connector to change data/.test(err.adminHint),
  );
  assert.deepEqual(connector.calls, []);
});

test("nothing the manifest doesn't declare can be called, request() above all", () => {
  for (const [access, writable] of [["write", true], ["read", false]] as const) {
    const { narrowed } = handed(access, writable);
    assert.throws(
      () => narrowed.request("/deals/1", { method: "DELETE" }),
      (err: unknown) =>
        err instanceof ConnectorUseError &&
        /^apps\/ledger called crm\.request\(\), which connectors\/crm\/connector\.json doesn't declare\./.test(err.message),
    );
    assert.throws(() => narrowed.initialize({}), ConnectorUseError);
  }
});

test("a disabled connector is handed on as it is, so its refusal names the reason that matters", async () => {
  const off = disabledConnector("crm", "Acme CRM");
  const narrowed = narrowConnector(off, DECLARED, appReachRules({
    appSlug: "ledger",
    connectorName: "crm",
    subject: "Acme CRM",
    need: { access: "read" },
    writable: false,
  })) as unknown as Crm;
  await assert.rejects(
    () => narrowed.createDeal(),
    (err: unknown) => isConnectorError(err) && err.userMessage === "Acme CRM has been disabled by an administrator.",
  );
});

// ── what the caller holds ───────────────────────────────────────────────────

/** Connected with a secret, so a test can look for it anywhere it might leak. */
function connected(access: "read" | "write" = "write") {
  const connector = new CrmConnector();
  void connector.initialize({ apiKey: SECRET });
  const narrowed = narrowConnector(
    connector,
    DECLARED,
    appReachRules({ appSlug: "ledger", connectorName: "crm", subject: "Acme CRM", need: { access }, writable: true }),
  );
  return { connector, narrowed: narrowed as unknown as Crm & Record<string, unknown> };
}

const SECRET = "sk-live-do-not-leak";

test("the credentials on the instance are out of reach by property, as they are by method", () => {
  const { narrowed } = connected();
  // Protected only to the compiler, so a bracket or an `as any` reaches it on
  // the instance itself.
  assert.equal(narrowed["credentials"], undefined);
  assert.equal(narrowed["accessToken"], undefined);
  assert.equal(narrowed["calls"], undefined, "no field passes, not only the credentials");
  assert.equal("credentials" in narrowed, false);
});

test("nothing that walks the object reaches the connector", () => {
  const { narrowed } = connected();
  assert.equal(JSON.stringify(narrowed), "{}");
  assert.deepEqual(Object.keys(narrowed), []);
  assert.deepEqual(Reflect.ownKeys(narrowed), []);
  assert.deepEqual({ ...narrowed }, {});
  assert.equal(Object.getOwnPropertyDescriptor(narrowed, "credentials"), undefined);
  assert.equal(Object.getPrototypeOf(narrowed), null, "no class, so no prototype methods to call on it");
  assert.doesNotMatch(inspect(narrowed, { showHidden: true, depth: 5 }), new RegExp(SECRET));
  assert.doesNotMatch(String(narrowed), new RegExp(SECRET));
});

test("the class can't be reached through the facade, so no method can be called on it unnarrowed", () => {
  const { narrowed } = connected();
  // A function, the class: refused like any member the manifest doesn't declare.
  assert.throws(() => (narrowed["constructor"] as () => unknown)(), ConnectorUseError);
  assert.equal(narrowed["__proto__"], undefined);
});

test("the facade can't be written to", () => {
  const { narrowed } = connected();
  assert.equal(Reflect.set(narrowed, "listDeals", () => "mine"), false);
  assert.equal(Reflect.defineProperty(narrowed, "x", { value: 1 }), false);
  assert.equal(Reflect.deleteProperty(narrowed, "listDeals"), false);
  assert.equal(Reflect.setPrototypeOf(narrowed, {}), false);
  assert.equal(Reflect.preventExtensions(narrowed), false);
  assert.equal("listDeals" in narrowed, true, "still answers for its declared methods");
});

test("a declared method is the same function each time, and still runs against the instance", async () => {
  const { connector, narrowed } = connected();
  assert.equal(narrowed.listDeals, narrowed.listDeals);
  assert.deepEqual(await narrowed.listDeals(), [{ id: "1" }]);
  assert.deepEqual(connector.calls, ["listDeals"]);
});

test("a facade narrowed again, as the MCP path does, keeps its reads and refuses its writes", async () => {
  const { narrowed } = connected();
  const again = narrowConnector(narrowed as unknown as BaseConnector, DECLARED, {
    writes: false,
    refuseWrite: (m) => new Error(`read-only: ${m}`),
    refuseUndeclared: (m) => new Error(`undeclared: ${m}`),
  }) as unknown as Crm & Record<string, unknown>;
  assert.deepEqual(await again.listDeals(), [{ id: "1" }]);
  assert.throws(() => again.createDeal(), /read-only: createDeal/);
  assert.throws(() => again.request("/x"), /undeclared: request/);
  assert.equal(again["credentials"], undefined);
  assert.equal(again.name, "crm");
});
