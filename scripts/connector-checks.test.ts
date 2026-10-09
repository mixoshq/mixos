/* This Source Code Form is subject to the terms of the Mozilla Public
 * License, v. 2.0. If a copy of the MPL was not distributed with this
 * file, You can obtain one at https://mozilla.org/MPL/2.0/. */

import { after, test } from "node:test";
import assert from "node:assert/strict";
import fs from "fs";
import os from "os";
import path from "path";
import { validateConnectorMethods, validateConnectorTelemetry } from "./connector-checks";
import { RawConnectorManifestSchema } from "./manifest-schemas";
import { ReadOnlyError, readOnlyConnectors } from "../src/lib/apps/read-only";
import type {
  BaseConnector,
  ConnectorTelemetryDefinition,
} from "../src/lib/connectors/types";

// ── fixtures ────────────────────────────────────────────────────────────────

const root = fs.mkdtempSync(path.join(os.tmpdir(), "mixos-connector-checks-"));
after(() => fs.rmSync(root, { recursive: true, force: true }));

let n = 0;

/** A connector directory whose index.ts is `source`. */
function connectorDir(source: string): string {
  const dir = path.join(root, `connector-${n++}`);
  fs.mkdirSync(dir, { recursive: true });
  fs.writeFileSync(path.join(dir, "index.ts"), source);
  return dir;
}

const declared = (...methods: string[]): ConnectorTelemetryDefinition[] =>
  methods.map((method) => ({ method }));

// ── telemetry → registry ────────────────────────────────────────────────────

test("mutates is carried into the registry with the rest of the entry", () => {
  assert.deepEqual(
    validateConnectorTelemetry(
      [
        { method: "listItems", description: "Listed items" },
        { method: "createItem", description: "Created an item", mutates: true },
        { method: "getItem", mutates: false },
      ],
      "acme",
    ),
    [
      { method: "listItems", description: "Listed items" },
      { method: "createItem", description: "Created an item", mutates: true },
      { method: "getItem" },
    ],
  );
});

test("a method declared twice fails the build", () => {
  assert.throws(
    () => validateConnectorTelemetry([{ method: "a" }, { method: "a" }], "acme"),
    /duplicate telemetry method "a"/,
  );
});

/**
 * From the manifest an author writes, through the build step that dropped
 * `mutates`, to a tool calling the write. The template declares `createItem`
 * with `"mutates": true`.
 */
test("a mutating method throws from an MCP tool context", async () => {
  const manifest = RawConnectorManifestSchema.parse(
    JSON.parse(
      fs.readFileSync(
        path.join(__dirname, "../connectors/_template/connector.json"),
        "utf-8",
      ),
    ),
  );
  const telemetry = validateConnectorTelemetry(manifest.telemetry, manifest.name);

  const sent: string[] = [];
  const template = {
    name: "_template",
    configured: true,
    initialize() {},
    async listItems() {
      sent.push("GET /items");
      return [];
    },
    async createItem() {
      sent.push("POST /items");
      return null;
    },
  };

  // What the MCP broker builds for a tool: the app's connectors, narrowed
  // against the generated registry.
  const ctx = {
    connectors: readOnlyConnectors({ _template: template as BaseConnector }, [
      { name: "_template", telemetry },
    ]),
  };
  const tool = async (c: typeof ctx) => {
    const t = c.connectors._template as unknown as typeof template;
    await t.listItems();
    return t.createItem();
  };

  await assert.rejects(tool(ctx), (err: unknown) => {
    assert.ok(err instanceof ReadOnlyError);
    assert.match(err.message, /"_template\.createItem" changes data upstream/);
    return true;
  });
  assert.deepEqual(sent, ["GET /items"]);
});

// ── the manifest schema ─────────────────────────────────────────────────────

/** The parts of the template's manifest these tests rewrite. */
interface TemplateManifest {
  setup: { docs?: unknown[] };
  credentialFields?: unknown[];
  auth: { scopesUrl?: string } & Record<string, unknown>;
}

/** The API-key template's manifest, with `edit` applied. */
function templateManifest(edit: (m: TemplateManifest) => void = () => {}) {
  const manifest = JSON.parse(
    fs.readFileSync(path.join(__dirname, "../connectors/_template/connector.json"), "utf-8"),
  ) as TemplateManifest;
  edit(manifest);
  return RawConnectorManifestSchema.safeParse(manifest);
}

/** Each schema issue as "path: message". */
function issuesOf(r: ReturnType<typeof templateManifest>): string[] {
  return r.success ? [] : r.error.issues.map((i) => `${i.path.join(".")}: ${i.message}`);
}

test("only a connector that authenticates with nothing may declare no credential fields", () => {
  const publicApi = templateManifest((m) => {
    delete m.credentialFields;
    m.auth = { strategy: "none", scopesUrl: m.auth.scopesUrl };
  });
  assert.deepEqual(issuesOf(publicApi), []);

  // An API key with no field to enter it in could never be configured.
  const noField = templateManifest((m) => {
    m.credentialFields = [];
    m.auth = { strategy: "apiKey", scopesUrl: m.auth.scopesUrl };
  });
  assert.ok(
    issuesOf(noField).some((i) => /^credentialFields: auth\.strategy "apiKey" needs a credential/.test(i)),
    issuesOf(noField).join("; "),
  );
});

// ── completeness of the declaration ─────────────────────────────────────────

test("a public method left out of telemetry fails the build", () => {
  const dir = connectorDir(`
    export default class Acme extends HttpConnector {
      readonly name = "acme";
      async testConnection() { return { ok: true as const }; }
      async listItems() { return this.request("/items"); }
      async createItem() { return this.request("/items", { method: "POST" }); }
    }
  `);
  assert.throws(
    () => validateConnectorMethods("acme", dir, declared("listItems")),
    (err: Error) => /: createItem\./.test(err.message),
  );
  assert.doesNotThrow(() =>
    validateConnectorMethods("acme", dir, declared("listItems", "createItem")),
  );
});

test("a method written as an arrow-function property must be declared too", () => {
  const dir = connectorDir(`
    export default class Acme extends HttpConnector {
      readonly name = "acme";
      readonly region = "eu";
      async testConnection() { return { ok: true as const }; }
      listItems = async () => this.request("/items");
      createItem = async () => this.request("/items", { method: "POST" });
      deleteItem = (async function (this: Acme) {
        return this.request("/items/1", { method: "DELETE" });
      }) as () => Promise<unknown>;
      sendMessage = this.createItem.bind(this);
      "archiveItem" = () => this.request("/items/1/archive", { method: "POST" });
      private retry = () => this.request("/retry");
      protected backoff = () => 1;
      static create = () => new Acme();
    }
  `);
  assert.throws(
    () => validateConnectorMethods("acme", dir, declared("listItems")),
    (err: Error) =>
      /: createItem, deleteItem, sendMessage, archiveItem\./.test(err.message),
  );
  assert.doesNotThrow(() =>
    validateConnectorMethods(
      "acme",
      dir,
      declared("listItems", "createItem", "deleteItem", "sendMessage", "archiveItem"),
    ),
  );
});

test("helper classes beside the connector are not its methods", () => {
  const dir = connectorDir(`
    class Cursor { next = () => null; advance() {} }
    export default class Acme extends HttpConnector {
      readonly name = "acme";
      async testConnection() { return { ok: true as const }; }
      initialize(c: Record<string, string>) { super.initialize(c); }
    }
  `);
  assert.doesNotThrow(() => validateConnectorMethods("acme", dir, []));
});

// ── every declared method exists ────────────────────────────────────────────

test("a declared method the class does not have fails the build", () => {
  const dir = connectorDir(`
    export default class Acme extends HttpConnector {
      readonly name = "acme";
      async testConnection() { return { ok: true as const }; }
      async listItems() { return this.request("/items"); }
    }
  `);
  // A typo, or a method since renamed: never counted, and no read a tool can call.
  assert.throws(
    () => validateConnectorMethods("acme", dir, declared("listItems", "listThings")),
    (err: Error) => /does not have: listThings\./.test(err.message),
  );
});

test("a declared method that is private, protected or static does not count", () => {
  const dir = connectorDir(`
    export default class Acme extends HttpConnector {
      readonly name = "acme";
      async testConnection() { return { ok: true as const }; }
      private async listItems() { return this.request("/items"); }
      protected sync = () => null;
      static create() { return new Acme(); }
    }
  `);
  assert.throws(
    () => validateConnectorMethods("acme", dir, declared("listItems", "sync", "create")),
    (err: Error) => /does not have: listItems, sync, create\./.test(err.message),
  );
});

test("methods inherited from HttpConnector or a base class in the file exist", () => {
  const dir = connectorDir(`
    class Base extends HttpConnector {
      async ping() { return this.request("/ping"); }
    }
    export default class Acme extends Base {
      readonly name = "acme";
      async testConnection() { return { ok: true as const }; }
    }
  `);
  assert.doesNotThrow(() =>
    validateConnectorMethods("acme", dir, declared("ping", "initialize", "testConnection")),
  );
});

test("a base class this file cannot see is not reported as missing methods", () => {
  // What it inherits is unknown here, so a declared method cannot be proved absent.
  const dir = connectorDir(`
    import { SharedBase } from "./shared";
    export default class Acme extends SharedBase {
      readonly name = "acme";
      async testConnection() { return { ok: true as const }; }
    }
  `);
  assert.doesNotThrow(() => validateConnectorMethods("acme", dir, declared("listShared")));
});
