/* This Source Code Form is subject to the terms of the Mozilla Public
 * License, v. 2.0. If a copy of the MPL was not distributed with this
 * file, You can obtain one at https://mozilla.org/MPL/2.0/. */

/**
 * Connectors in runners (Item 7b), end to end: the template connector's
 * bundle, built as `npm run build` builds it, run in a real runner, against a
 * local server standing in for its provider. Skipped on a Node without the
 * network permission, where connectors run in process.
 */

import { after, before, describe, test } from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import http from "node:http";
import path from "node:path";
import type { AddressInfo } from "node:net";
import type { BaseConnector, ConnectorManifest } from "@/lib/connectors/types";
import { isolationSupport, RunnerUnavailableError } from "./supervisor";

const REPO = path.resolve(__dirname, "../../..");
const skip = isolationSupport().supported ? false : "this Node has no network permission";
const TEMPLATE = "_template";
const NO_BUNDLE = "_template-nobundle";

type Template = BaseConnector & {
  listItems(): Promise<Array<{ id: string; name: string }>>;
  getItem(id: string): Promise<unknown>;
  createItem(data: object): Promise<unknown>;
  testConnection(): Promise<{ ok: boolean; detail?: string }>;
};

describe("a connector in its runner", { skip }, () => {
  let server: http.Server;
  let base: string;
  let bundles = "";
  const seen: Array<{ method: string; url: string; key: string | undefined }> = [];
  let p: typeof import("./remote-connector") &
    typeof import("@/lib/connectors/loader") &
    typeof import("@/generated/connector-registry") &
    typeof import("@/lib/connectors/http-connector") &
    typeof import("@/lib/connectors/errors");

  before(async () => {
    server = http.createServer((req, res) => {
      seen.push({ method: req.method ?? "", url: req.url ?? "", key: req.headers["x-api-key"] as string | undefined });
      res.setHeader("content-type", "application/json");
      if (req.url === "/me") return res.end(JSON.stringify({ name: "Tester" }));
      if (req.url?.startsWith("/items/broken")) {
        res.statusCode = 500;
        return res.end("{}");
      }
      if (req.url?.split("?")[0] === "/items") return res.end(JSON.stringify({ data: [{ id: "1", name: "one" }, { id: "2", name: "two" }] }));
      res.statusCode = 404;
      res.end("{}");
    });
    await new Promise<void>((r) => server.listen(0, "127.0.0.1", () => r()));
    base = `http://127.0.0.1:${(server.address() as AddressInfo).port}`;

    (process.env as Record<string, string>).NODE_ENV = "production";
    delete process.env.MIXOS_ISOLATION;
    p = {
      ...(await import("./remote-connector")),
      ...(await import("@/lib/connectors/loader")),
      ...(await import("@/generated/connector-registry")),
      ...(await import("@/lib/connectors/http-connector")),
      ...(await import("@/lib/connectors/errors")),
    };
    const manifest = JSON.parse(fs.readFileSync(path.join(REPO, "connectors", TEMPLATE, "connector.json"), "utf8")) as ConnectorManifest;
    p.connectorRegistry.push({ ...manifest, name: TEMPLATE } as never, { ...manifest, name: NO_BUNDLE } as never);
    const { buildConnectorBundle } = await import("../../../scripts/build-runner-bundles");
    bundles = fs.mkdtempSync(path.join(os.tmpdir(), "mixos-bundles-"));
    p.useRunnerBundleRoot(bundles);
    await buildConnectorBundle({ ...manifest, name: TEMPLATE } as ConnectorManifest & { name: string }, bundles);
  });

  after(async () => {
    await p?.stopConnectorRunners();
    server?.close();
    if (bundles) fs.rmSync(bundles, { recursive: true, force: true });
  });

  async function connector(credentials: Record<string, string>): Promise<Template> {
    const c = (await p.constructConnector(TEMPLATE)) as Template;
    await c.initialize(credentials);
    return c;
  }

  test("the platform holds a RemoteConnector, never the connector's class", async () => {
    assert.deepEqual(p.connectorIsolation(), { on: true });
    const c = await connector({ apiKey: "k", baseUrl: base });
    assert.ok(c instanceof p.RemoteConnector);
    assert.ok(!(c instanceof p.HttpConnector));
    assert.equal(c.name, TEMPLATE);
    assert.equal(c.configured, true);
    assert.equal((await connector({})).configured, false);
  });

  test("a declared method runs in the runner, signed with the key the platform handed in", async () => {
    const c = await connector({ apiKey: "secret-key", baseUrl: base });
    const items = await c.listItems();
    assert.deepEqual(items.map((i) => i.id), ["1", "2"]);
    const call = seen.filter((s) => s.url.split("?")[0] === "/items").at(-1);
    assert.equal(call?.key, "secret-key");
    assert.equal((await c.testConnection()).detail, "Authenticated as Tester");
  });

  test("an upstream failure comes back as a real ConnectorError, named by the platform", async () => {
    const c = await connector({ apiKey: "k", baseUrl: base });
    await assert.rejects(c.getItem("broken"), (err: unknown) => {
      assert.ok(err instanceof p.ConnectorError);
      assert.equal(err.connectorName, TEMPLATE);
      assert.equal(err.category, "upstream_error");
      assert.equal(err.status, 500);
      return true;
    });
  });

  test("only declared methods are on it: request() and the class's internals aren't", async () => {
    const c = (await connector({ apiKey: "k", baseUrl: base })) as unknown as Record<string, unknown>;
    for (const member of ["request", "requestBody", "paginate", "credentials", "authHeaders"]) {
      assert.equal(c[member], undefined, member);
    }
  });

  test("without the admin's base URL, the manifest's host must be public: a private answer is refused", async () => {
    const { relayConnectorFetch, relayHosts, ConnectorRelayRefusedError } = await import("./connector-relay");
    const hosts = relayHosts({ http: { baseUrl: "https://127.0.0.1" }, auth: { strategy: "none" } } as never, {});
    await assert.rejects(
      relayConnectorFetch(TEMPLATE, hosts, { instance: "", url: "https://127.0.0.1/items", method: "GET", headers: [], body: null, redirect: "follow" }),
      ConnectorRelayRefusedError,
    );
    await assert.rejects(
      relayConnectorFetch(TEMPLATE, hosts, { instance: "", url: `${base}/items`, method: "GET", headers: [], body: null, redirect: "follow" }),
      /may not reach 127\.0\.0\.1|over https only/,
    );
  });

  test("a call from a connector's runner for anything but fetch and a renewal is refused", async () => {
    await assert.rejects(
      p.connectorRunnerCall({ run: { runId: "r", subject: TEMPLATE, userId: null, readOnly: false }, op: "db.query", args: {} }),
      /may not ask for db\.query/,
    );
    await assert.rejects(
      p.connectorRunnerCall({ run: { runId: "r", subject: TEMPLATE, userId: null, readOnly: false }, op: "grant.refresh", args: { instance: "nope" } }),
      /instance has ended/,
    );
  });

  test("a connector with no bundle in this build is unavailable, never run in process", async () => {
    const c = (await p.constructConnector(NO_BUNDLE)) as Template;
    await c.initialize({ apiKey: "k", baseUrl: base });
    await assert.rejects(c.listItems(), RunnerUnavailableError);
  });

  test("the bundle carries this connector alone, and no database", () => {
    const code = fs.readFileSync(p.connectorBundlePath(TEMPLATE), "utf8");
    assert.match(code, /"_template"/);
    assert.doesNotMatch(code, /_template-oauth/);
    assert.doesNotMatch(code, /pg_advisory_xact_lock/);
    assert.match(code, /isn't available in a connector's runner/);
  });

  test("MIXOS_ISOLATION=off runs connectors in process again", async () => {
    process.env.MIXOS_ISOLATION = "off";
    try {
      assert.deepEqual(p.connectorIsolation(), { on: false, reason: "turned off by the operator (MIXOS_ISOLATION=off)" });
    } finally {
      delete process.env.MIXOS_ISOLATION;
    }
  });
});
