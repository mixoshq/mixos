/* This Source Code Form is subject to the terms of the Mozilla Public
 * License, v. 2.0. If a copy of the MPL was not distributed with this
 * file, You can obtain one at https://mozilla.org/MPL/2.0/. */

import { test } from "node:test";
import assert from "node:assert/strict";
import type {
  BaseConnector,
  ConnectorTelemetryDefinition,
} from "@/lib/connectors/types";
import { ReadOnlyError, readOnlyConnector, readOnlyConnectors } from "./read-only";

// ── fixtures ────────────────────────────────────────────────────────────────

/**
 * Enough of an HttpConnector to tell the calls apart: every public method goes
 * through `request()`, which records the verb, as the real one would send it.
 */
class AcmeConnector implements BaseConnector {
  readonly name = "acme";
  sent: string[] = [];
  private credentials: Record<string, string> = { apiKey: "k" };

  get configured(): boolean {
    return this.credentials.apiKey.length > 0;
  }

  initialize(credentials: Record<string, string>): void {
    this.credentials = credentials;
  }

  protected async request(path: string, init: { method?: string } = {}) {
    this.sent.push(`${init.method ?? "GET"} ${path}`);
    return { ok: true };
  }

  async listItems() {
    return this.request("/items");
  }

  async createItem() {
    return this.request("/items", { method: "POST" });
  }

  async archiveItem() {
    return this.request("/items/1/archive", { method: "POST" });
  }
}

const DECLARED: ConnectorTelemetryDefinition[] = [
  { method: "listItems", description: "Listed items" },
  { method: "createItem", description: "Created an item", mutates: true },
];

/** The connector's methods, typed as a tool would cast them. */
type Acme = {
  name: string;
  configured: boolean;
  listItems(): Promise<unknown>;
  createItem(): Promise<unknown>;
  archiveItem(): Promise<unknown>;
  request(path: string, init?: { method?: string }): Promise<unknown>;
  initialize(credentials: Record<string, string>): void;
};

function narrowed() {
  const connector = new AcmeConnector();
  const tool = readOnlyConnector("acme", connector, DECLARED) as unknown as Acme;
  return { connector, tool };
}

/**
 * Stands in for the telemetry proxy (`instrumentConnector`), which sits under
 * the read-only one in a real context: declared methods are re-applied to the
 * instance, everything else passes through.
 */
function instrumented<T extends object>(instance: T, methods: Set<string>): T {
  return new Proxy(instance, {
    get(target, prop, receiver) {
      const value = Reflect.get(target, prop, receiver);
      if (typeof prop === "string" && methods.has(prop) && typeof value === "function") {
        return (...args: unknown[]) => value.apply(target, args);
      }
      return value;
    },
  });
}

// ── what a tool can call ────────────────────────────────────────────────────

test("a declared read runs, and its own request() is the real one", async () => {
  const { connector, tool } = narrowed();
  assert.deepEqual(await tool.listItems(), { ok: true });
  assert.deepEqual(connector.sent, ["GET /items"]);
});

test("plain properties and getters pass through", () => {
  const { tool } = narrowed();
  assert.equal(tool.name, "acme");
  assert.equal(tool.configured, true);
  assert.equal(`${tool}`, "[object Object]");
});

// ── what it cannot ──────────────────────────────────────────────────────────

test("a method declared mutates throws, and nothing is sent", () => {
  const { connector, tool } = narrowed();
  assert.throws(() => tool.createItem(), (err: unknown) => {
    assert.ok(err instanceof ReadOnlyError);
    assert.match(err.message, /"acme\.createItem" changes data upstream/);
    return true;
  });
  assert.deepEqual(connector.sent, []);
});

test("the protected request() is refused, so `as any` cannot send a POST", () => {
  const { connector, tool } = narrowed();
  assert.throws(
    () => tool.request("/items", { method: "POST" }),
    (err: unknown) =>
      err instanceof ReadOnlyError &&
      /"acme\.request" is not one of the reads "acme" declares/.test(err.message),
  );
  assert.deepEqual(connector.sent, []);
});

test("a method the manifest never declared is refused", () => {
  const { connector, tool } = narrowed();
  assert.throws(() => tool.archiveItem(), ReadOnlyError);
  assert.throws(() => tool.initialize({}), ReadOnlyError);
  assert.equal(tool.configured, true, "initialize() must not have run");
  assert.deepEqual(connector.sent, []);
});

test("a connector missing from the registry exposes nothing callable", () => {
  const tools = readOnlyConnectors({ acme: new AcmeConnector() }, []);
  const tool = tools.acme as unknown as Acme;
  assert.equal(tool.configured, true);
  assert.throws(() => tool.listItems(), ReadOnlyError);
});

// ── as it is wired ──────────────────────────────────────────────────────────

test("narrowing a context's connectors over the telemetry proxy", async () => {
  const connector = new AcmeConnector();
  const declared = new Set(DECLARED.map((m) => m.method));
  const tools = readOnlyConnectors(
    { acme: instrumented(connector, declared) },
    [{ name: "acme", telemetry: DECLARED }],
  );
  const tool = tools.acme as unknown as Acme;

  assert.deepEqual(await tool.listItems(), { ok: true });
  assert.throws(() => tool.createItem(), ReadOnlyError);
  assert.throws(() => tool.request("/items", { method: "DELETE" }), ReadOnlyError);
  assert.deepEqual(connector.sent, ["GET /items"]);
});
