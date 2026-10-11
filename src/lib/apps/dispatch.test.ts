/* This Source Code Form is subject to the terms of the Mozilla Public
 * License, v. 2.0. If a copy of the MPL was not distributed with this
 * file, You can obtain one at https://mozilla.org/MPL/2.0/. */

/**
 * What the gateway does in place of the proxy, which neither app API mount is
 * behind (src/proxy.ts): the maintenance response first, on both mounts and
 * every method, and the CSP on everything else it answers.
 *
 * The maintenance state is a stand-in, so no database is needed: a resolve
 * hook points `@/lib/platform/maintenance` at a module that reads it from
 * `globalThis`. The requests name an app that doesn't exist, which the gateway
 * answers at step 2, before anything else would need a database.
 */

import { after, before, test } from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import { registerHooks } from "node:module";
import os from "node:os";
import path from "node:path";
import { pathToFileURL } from "node:url";
import type { MaintenanceState } from "@/lib/platform/maintenance-gate";

const state = globalThis as { __dispatchTestMaintenance?: MaintenanceState };
const BEHIND: MaintenanceState = { platformBehind: true, appsBehind: new Set() };
const CURRENT: MaintenanceState = { platformBehind: false, appsBehind: new Set() };

let work: string;
let resolver: ReturnType<typeof registerHooks> | undefined;
let gateway: typeof import("./dispatch");

before(async () => {
  work = fs.mkdtempSync(path.join(os.tmpdir(), "mixos-dispatch-"));
  const stub = path.join(work, "maintenance.mjs");
  fs.writeFileSync(
    stub,
    `export function maintenanceState() { return Promise.resolve(globalThis.__dispatchTestMaintenance); }\n`,
  );
  resolver = registerHooks({
    resolve(specifier, context, nextResolve) {
      if (specifier === "@/lib/platform/maintenance") {
        return nextResolve(pathToFileURL(stub).href, context);
      }
      return nextResolve(specifier, context);
    },
  });
  gateway = await import("./dispatch");
});

after(() => {
  resolver?.deregister();
  if (work) fs.rmSync(work, { recursive: true, force: true });
});

const MOUNTS = [
  { mount: "authenticated", url: "http://mixos.test/api/apps/no-such-app/items" },
  { mount: "public", url: "http://mixos.test/api/p/no-such-app/items" },
] as const;

/** As a route handler receives it: inside the Proxy Next's app-route module wraps it in. */
function asNextHandsIt(request: Request): Request {
  return new Proxy(request, {
    get(target, prop) {
      const value = Reflect.get(target, prop, target);
      return typeof value === "function" ? value.bind(target) : value;
    },
  });
}

function call(mount: (typeof MOUNTS)[number], method: "GET" | "POST", init: RequestInit = {}) {
  return gateway.dispatchAppRoute({
    request: asNextHandsIt(new Request(mount.url, { method, ...init })),
    method,
    appSlug: "no-such-app",
    segments: ["items"],
    mount: mount.mount,
  });
}

test("while the platform schema is behind, both mounts give the maintenance response first", async () => {
  state.__dispatchTestMaintenance = BEHIND;
  for (const mount of MOUNTS) {
    for (const method of ["GET", "POST"] as const) {
      const res = await call(mount, method, method === "POST" ? { body: "{}" } : {});
      const label = `${method} ${mount.url}`;
      assert.equal(res.status, 503, label);
      assert.equal(res.headers.get("retry-after"), "30", label);
      assert.deepEqual(await res.json(), { error: "This instance is being updated. Try again shortly." }, label);
      // The maintenance response is the proxy's own, without the page CSP.
      assert.equal(res.headers.get("content-security-policy"), null, label);
    }
    const options = await gateway.appRouteOptions(new Request(mount.url, { method: "OPTIONS" }));
    assert.equal(options.status, 503, `OPTIONS ${mount.url}`);
  }
});

test("otherwise the request goes through, and the answer carries the CSP", async () => {
  state.__dispatchTestMaintenance = CURRENT;
  for (const mount of MOUNTS) {
    for (const method of ["GET", "POST"] as const) {
      // A POST carries a body, so it is past the body cap's copy of the request
      // by the time the app lookup answers.
      const res = await call(mount, method, method === "POST" ? { body: "{}" } : {});
      const label = `${method} ${mount.url}`;
      assert.equal(res.status, 404, label);
      assert.deepEqual(await res.json(), { error: "Not found", code: "NOT_FOUND" }, label);
      assert.match(res.headers.get("content-security-policy") ?? "", /script-src 'self' 'nonce-[^']+' 'strict-dynamic'/, label);
      assert.match(res.headers.get("content-security-policy") ?? "", /frame-ancestors 'self'/, label);
    }
  }
});

test("OPTIONS is Next's own answer for the mount files, with the CSP", async () => {
  state.__dispatchTestMaintenance = CURRENT;
  for (const mount of MOUNTS) {
    const res = await gateway.appRouteOptions(new Request(mount.url, { method: "OPTIONS" }));
    assert.equal(res.status, 204);
    assert.equal(res.headers.get("allow"), "DELETE, GET, HEAD, OPTIONS, PATCH, POST, PUT");
    assert.match(res.headers.get("content-security-policy") ?? "", /'strict-dynamic'/);
  }
});

test("a declared length over the cap is a 413 before the body is read", async () => {
  state.__dispatchTestMaintenance = CURRENT;
  for (const mount of MOUNTS) {
    let read = false;
    const body = new ReadableStream<Uint8Array>(
      {
        pull(controller) {
          read = true;
          controller.close();
        },
      },
      { highWaterMark: 0 },
    );
    const res = await call(mount, "POST", {
      body,
      headers: { "content-length": "27000001" },
      duplex: "half",
    } as RequestInit);
    assert.equal(res.status, 413, mount.url);
    assert.deepEqual(await res.json(), { error: "Request body too large", code: "PAYLOAD_TOO_LARGE" });
    assert.match(res.headers.get("content-security-policy") ?? "", /'strict-dynamic'/);
    assert.equal(read, false, "the body was read");
  }
});
