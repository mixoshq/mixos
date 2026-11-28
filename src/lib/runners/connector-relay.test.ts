/* This Source Code Form is subject to the terms of the Mozilla Public
 * License, v. 2.0. If a copy of the MPL was not distributed with this
 * file, You can obtain one at https://mozilla.org/MPL/2.0/. */

/** The connector relay's rules (./connector-relay.ts), and what may leave a connector's runner. */

import { after, before, test } from "node:test";
import assert from "node:assert/strict";
import http from "node:http";
import type { AddressInfo } from "node:net";
import { ConnectorRelayRefusedError, relayConnectorFetch, relayedRequest, relayHosts } from "./connector-relay";
import { crossable } from "./connector-host";
import { asConnectorError } from "./remote-connector";
import { ConnectorError } from "@/lib/connectors/errors";

const servers: http.Server[] = [];
const seen: Array<{ port: number; auth: string | undefined; method: string }> = [];

async function listen(handler: http.RequestListener): Promise<number> {
  const server = http.createServer(handler);
  servers.push(server);
  await new Promise<void>((r) => server.listen(0, "127.0.0.1", () => r()));
  return (server.address() as AddressInfo).port;
}

let first = 0;
let second = 0;

before(async () => {
  second = await listen((req, res) => {
    seen.push({ port: second, auth: req.headers.authorization, method: req.method ?? "" });
    res.end("landed");
  });
  first = await listen((req, res) => {
    seen.push({ port: first, auth: req.headers.authorization, method: req.method ?? "" });
    if (req.url === "/same") {
      res.writeHead(302, { location: `/final` });
      return res.end();
    }
    if (req.url === "/away") {
      res.writeHead(302, { location: `http://127.0.0.1:${second}/x` });
      return res.end();
    }
    res.end("ok");
  });
});

after(() => {
  for (const s of servers) s.close();
});

const request = (url: string, extra: Partial<Parameters<typeof relayConnectorFetch>[2]> = {}) => ({
  instance: "",
  url,
  method: "GET",
  headers: [["authorization", "Bearer t"]] as Array<[string, string]>,
  body: null,
  redirect: "follow" as const,
  ...extra,
});

test("the hosts a connector may reach: its manifest's, http.hosts, and the admin's base URL", () => {
  const hosts = relayHosts(
    {
      http: { baseUrl: "https://API.example.com/v1", hosts: ["uploads.example.com"] },
      auth: { strategy: "oauth2_authorization_code", tokenUrl: "https://auth.example.com/token", authorizeUrl: "https://auth.example.com/authorize" },
    } as never,
    { baseUrl: "http://crm.internal:8080" },
  );
  assert.deepEqual([...hosts.declared].sort(), ["api.example.com", "auth.example.com", "uploads.example.com"]);
  assert.equal(hosts.admin, "crm.internal");
});

test("a host it didn't declare is refused before anything is resolved", async () => {
  const hosts = relayHosts({ http: { baseUrl: "https://api.example.com" } } as never, {});
  await assert.rejects(relayConnectorFetch("c", hosts, request("https://evil.example.net/")), /may not reach evil\.example\.net/);
  await assert.rejects(relayConnectorFetch("c", hosts, request("http://api.example.com/")), /over https only/);
});

test("the admin's base URL reaches a private address over http; a redirect on the same origin keeps credentials", async () => {
  const hosts = relayHosts({} as never, { baseUrl: `http://127.0.0.1:${first}` });
  const answer = await relayConnectorFetch("c", hosts, request(`http://127.0.0.1:${first}/same`));
  assert.equal(answer.status, 200);
  assert.equal(seen.at(-1)?.auth, "Bearer t");
});

test("a redirect to another origin drops the credentials, as fetch does", async () => {
  const hosts = relayHosts({} as never, { baseUrl: `http://127.0.0.1:${first}` });
  const answer = await relayConnectorFetch("c", hosts, request(`http://127.0.0.1:${first}/away`));
  assert.equal(new TextDecoder().decode(answer.body!), "landed");
  const landed = seen.filter((s) => s.port === second).at(-1);
  assert.equal(landed?.auth, undefined);
});

test("redirect: manual hands the redirect back, and error refuses it", async () => {
  const hosts = relayHosts({} as never, { baseUrl: `http://127.0.0.1:${first}` });
  const manual = await relayConnectorFetch("c", hosts, request(`http://127.0.0.1:${first}/same`, { redirect: "manual" }));
  assert.equal(manual.status, 302);
  await assert.rejects(relayConnectorFetch("c", hosts, request(`http://127.0.0.1:${first}/same`, { redirect: "error" })), ConnectorRelayRefusedError);
});

test("what a runner sends is checked before it is used", () => {
  assert.throws(() => relayedRequest(null), ConnectorRelayRefusedError);
  assert.throws(() => relayedRequest({ url: 5, method: "GET", headers: [] }), /needs a URL/);
  assert.throws(() => relayedRequest({ url: "https://x", method: "get it", headers: [] }), /needs a method/);
  assert.throws(() => relayedRequest({ url: "https://x", method: "GET", headers: [["a"]] }), /name and value pairs/);
  assert.throws(() => relayedRequest({ url: "https://x", method: "GET", headers: [], body: "text" }), /body is bytes/);
  assert.equal(relayedRequest({ url: "https://x", method: "GET", headers: [], redirect: "sideways" }).redirect, "follow");
});

test("what may leave a runner: data, never a Response, a stream, a function or a class instance", () => {
  assert.equal(crossable({ a: [1, "two", null, new Date(), new Uint8Array(1), BigInt(3)], b: { c: true } }), null);
  assert.equal(crossable(new Response("x")), "a Response");
  assert.equal(crossable({ items: [() => 1] }), "a function");
  assert.equal(crossable({ s: new ReadableStream() }), "a ReadableStream");
  class Deal {}
  assert.equal(crossable([new Deal()]), "a Deal");
});

test("a ConnectorError from a runner is rebuilt as a real one, named by the platform, never by the runner", () => {
  const fromRunner = Object.assign(new Error("[spoofed] rate_limited"), {
    name: "ConnectorError",
    category: "rate_limited",
    connectorName: "someone-else",
    retryAfterMs: 3000,
    status: 429,
    userMessage: "Slow down",
  });
  const rebuilt = asConnectorError("crm", fromRunner);
  assert.ok(rebuilt instanceof ConnectorError);
  assert.equal(rebuilt.connectorName, "crm");
  assert.equal(rebuilt.category, "rate_limited");
  assert.equal(rebuilt.retryAfterMs, 3000);
  assert.equal(rebuilt.retryable, true);
  assert.equal(rebuilt.userMessage, "Slow down");
  const unknown = Object.assign(new Error("x"), { name: "ConnectorError", category: "made_up" });
  assert.ok(!(asConnectorError("crm", unknown) instanceof ConnectorError));
});
