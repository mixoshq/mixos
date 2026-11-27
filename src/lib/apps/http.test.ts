/* This Source Code Form is subject to the terms of the Mozilla Public
 * License, v. 2.0. If a copy of the MPL was not distributed with this
 * file, You can obtain one at https://mozilla.org/MPL/2.0/. */

import { after, test } from "node:test";
import assert from "node:assert/strict";
import http from "node:http";
import net from "node:net";
import { gzipSync } from "node:zlib";
import { AppError } from "./errors";
import {
  type ResolvedAddress,
  checkedAddresses,
  createHttpClient,
  requestPinned,
} from "./http";

// ── fixtures ────────────────────────────────────────────────────────────────

/**
 * A name that cannot resolve: `.test` is reserved (RFC 2606). A request to it
 * that arrives anywhere arrived by the pinned address, not by DNS.
 */
const UNRESOLVABLE = "pinned.test";

const LOOPBACK: ResolvedAddress[] = [{ address: "127.0.0.1", family: 4 }];

interface Seen {
  method?: string;
  url?: string;
  headers: http.IncomingHttpHeaders;
  body: string;
}

/** A loopback HTTP server that records each request and answers with `reply`. */
async function server(reply: (req: http.IncomingMessage, res: http.ServerResponse) => void) {
  const seen: Seen[] = [];
  const srv = http.createServer((req, res) => {
    let body = "";
    req.on("data", (c) => (body += c));
    req.on("end", () => {
      seen.push({ method: req.method, url: req.url, headers: req.headers, body });
      reply(req, res);
    });
  });
  await new Promise<void>((r) => srv.listen(0, "127.0.0.1", r));
  after(() => srv.close());
  return { port: (srv.address() as net.AddressInfo).port, seen };
}

const resolvesTo = (...addresses: string[]) => async () =>
  addresses.map((address) => ({ address, family: net.isIP(address) as 4 | 6 }));

const refused = (pattern: RegExp) => (err: unknown) =>
  err instanceof AppError && err.code === "FORBIDDEN" && pattern.test(err.message);

// ── the address check ───────────────────────────────────────────────────────

test("every answer is checked, and one private answer refuses the lot", async () => {
  const resolve = resolvesTo("93.184.216.34", "10.0.0.7");
  await assert.rejects(
    checkedAddresses("api.example.com", resolve),
    refused(/resolves to a non-public address/),
  );
});

test("public answers come back as the only addresses the request may use", async () => {
  assert.deepEqual(
    await checkedAddresses("api.example.com", resolvesTo("93.184.216.34", "2606:4700:4700::1111")),
    [
      { address: "93.184.216.34", family: 4 },
      { address: "2606:4700:4700::1111", family: 6 },
    ],
  );
});

test("a name that does not resolve is unavailable, not an unhandled DNS error", async () => {
  const failing = async () => {
    throw Object.assign(new Error("getaddrinfo ENOTFOUND"), { code: "ENOTFOUND" });
  };
  for (const resolve of [failing, resolvesTo()]) {
    await assert.rejects(
      checkedAddresses("gone.example.com", resolve),
      (err: unknown) => err instanceof AppError && err.code === "UNAVAILABLE",
    );
  }
});

test("IP literals are checked as they stand, IPv6 in its URL brackets included", async () => {
  const never = async (): Promise<ResolvedAddress[]> => {
    throw new Error("a literal must not be resolved");
  };
  for (const host of [
    "127.0.0.1",
    "169.254.169.254",
    "[::1]",
    "[::]",
    "[::ffff:7f00:1]", // ::ffff:127.0.0.1, as the URL parser writes it
    "[::ffff:a9fe:a9fe]", // ::ffff:169.254.169.254
    "[::a9fe:a9fe]", // IPv4-compatible
    "[64:ff9b::a00:1]", // NAT64 for 10.0.0.1
    "[2002:a9fe:a9fe::1]", // 6to4 for 169.254.169.254
    "[fd00::1]",
    "[fe80::1]",
    "[fec0::1]",
    "[ff02::1]",
  ]) {
    await assert.rejects(checkedAddresses(host, never), refused(/is not a public address/), host);
  }
  assert.deepEqual(await checkedAddresses("[2606:4700:4700::1111]", never), [
    { address: "2606:4700:4700::1111", family: 6 },
  ]);
  assert.deepEqual(await checkedAddresses("93.184.216.34", never), [
    { address: "93.184.216.34", family: 4 },
  ]);
});

test("a resolver answer in v4-in-v6 form is judged as the v4 address", async () => {
  await assert.rejects(
    checkedAddresses("api.example.com", resolvesTo("::ffff:169.254.169.254")),
    refused(/non-public/),
  );
});

// ── the pinned request ──────────────────────────────────────────────────────

test("the request connects to the checked address and never resolves the name", async () => {
  const { port, seen } = await server((_req, res) => {
    res.setHeader("content-type", "application/json");
    res.end(JSON.stringify({ ok: true }));
  });
  const url = new URL(`http://${UNRESOLVABLE}:${port}/items?limit=2`);

  const res = await requestPinned(
    url,
    {
      method: "POST",
      headers: {
        "content-type": "application/json",
        "x-trace": "1",
        // Framing is the transport's: a wrong length from the caller is replaced.
        "content-length": "999",
      },
      body: JSON.stringify({ name: "a" }),
    },
    LOOPBACK,
  );

  assert.equal(res.status, 200);
  assert.deepEqual(await res.json(), { ok: true });
  assert.equal(res.url, url.href);
  assert.equal(seen.length, 1);
  assert.equal(seen[0].method, "POST");
  assert.equal(seen[0].url, "/items?limit=2");
  // The Host header still names the host, not the address.
  assert.equal(seen[0].headers.host, `${UNRESOLVABLE}:${port}`);
  assert.equal(seen[0].headers["content-type"], "application/json");
  assert.equal(seen[0].headers["x-trace"], "1");
  assert.equal(seen[0].body, JSON.stringify({ name: "a" }));
});

test("a fetch-style body is encoded as fetch would encode it", async () => {
  const { port, seen } = await server((_req, res) => res.end());
  await requestPinned(
    new URL(`http://${UNRESOLVABLE}:${port}/form`),
    { method: "POST", body: new URLSearchParams({ q: "a b" }) },
    LOOPBACK,
  );
  assert.match(String(seen[0].headers["content-type"]), /^application\/x-www-form-urlencoded/);
  assert.equal(seen[0].body, "q=a+b");
});

test("a compressed body is decoded, as fetch decodes it", async () => {
  const { port } = await server((_req, res) => {
    res.setHeader("content-encoding", "gzip");
    res.end(gzipSync("hello"));
  });
  const res = await requestPinned(new URL(`http://${UNRESOLVABLE}:${port}/`), {}, LOOPBACK);
  assert.equal(await res.text(), "hello");
});

test("a redirect is handed back, not followed", async () => {
  const { port, seen } = await server((_req, res) => {
    res.writeHead(302, { location: "http://169.254.169.254/latest/meta-data/" });
    res.end();
  });
  const res = await requestPinned(new URL(`http://${UNRESOLVABLE}:${port}/`), {}, LOOPBACK);
  assert.equal(res.status, 302);
  assert.equal(res.headers.get("location"), "http://169.254.169.254/latest/meta-data/");
  assert.equal(seen.length, 1);
});

test("bodyless responses build", async () => {
  const { port } = await server((req, res) => {
    res.writeHead(req.method === "HEAD" ? 200 : 204);
    res.end();
  });
  const url = new URL(`http://${UNRESOLVABLE}:${port}/`);
  assert.equal((await requestPinned(url, { method: "DELETE" }, LOOPBACK)).status, 204);
  const head = await requestPinned(url, { method: "HEAD" }, LOOPBACK);
  assert.equal(head.status, 200);
  assert.equal(head.body, null);
});

test("over TLS, the server name is the URL's host while the socket goes to the pin", async () => {
  // Not a TLS server: it reads the ClientHello, where the server name travels
  // in the clear, and hangs up. The handshake fails, which is the point — the
  // name a certificate will be checked against is the one sent here.
  let hello = Buffer.alloc(0);
  const raw = net.createServer((socket) => {
    socket.once("data", (chunk) => {
      hello = chunk;
      socket.destroy();
    });
  });
  await new Promise<void>((r) => raw.listen(0, "127.0.0.1", r));
  after(() => raw.close());
  const port = (raw.address() as net.AddressInfo).port;

  await assert.rejects(
    requestPinned(new URL(`https://${UNRESOLVABLE}:${port}/`), {}, LOOPBACK),
    (err: unknown) => err instanceof TypeError && err.message === "fetch failed",
  );
  assert.ok(hello.length > 0, "the connection reached the pinned address");
  assert.ok(hello.includes(Buffer.from(UNRESOLVABLE)), "SNI carries the hostname");
});

test("an aborted request rejects with an AbortError, as fetch's does", async () => {
  const { port } = await server(() => {
    // Never answers.
  });
  const controller = new AbortController();
  const pending = requestPinned(
    new URL(`http://${UNRESOLVABLE}:${port}/slow`),
    { signal: controller.signal },
    LOOPBACK,
  );
  controller.abort();
  await assert.rejects(pending, (err: unknown) => (err as Error).name === "AbortError");
});

// ── the client ──────────────────────────────────────────────────────────────

test("a host outside egress, or another scheme, is refused before any lookup", async () => {
  const client = createHttpClient("acme", ["api.example.com"]);
  await assert.rejects(client.fetch("https://other.example.com/"), refused(/not allowed to reach/));
  await assert.rejects(client.fetch("file:///etc/passwd"), refused(/file: scheme/));
});

test("the client checks its own copy of egress, so a change to the list it was given widens nothing", async () => {
  const declared = ["api.example.com"];
  const client = createHttpClient("acme", declared);
  declared.push("evil.example.com");
  await assert.rejects(client.fetch("https://evil.example.com/"), refused(/not allowed to reach evil\.example\.com/));
});

test("an allowed name that resolves to loopback is refused", async () => {
  const client = createHttpClient("acme", ["localhost"]);
  await assert.rejects(client.fetch("http://localhost/"), refused(/non-public/));
});
