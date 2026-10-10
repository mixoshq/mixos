/* This Source Code Form is subject to the terms of the Mozilla Public
 * License, v. 2.0. If a copy of the MPL was not distributed with this
 * file, You can obtain one at https://mozilla.org/MPL/2.0/. */

import { after, describe, test } from "node:test";
import assert from "node:assert/strict";
import fs from "fs";
import os from "os";
import path from "path";
import { ESLint } from "eslint";
import { formatFindings, scanAppContainment, type ContainmentFinding } from "./app-containment";

// ── fixtures ────────────────────────────────────────────────────────────────

const ROOT = path.resolve(__dirname, "..");
const tmp = fs.mkdtempSync(path.join(os.tmpdir(), "mixos-containment-"));
after(() => fs.rmSync(tmp, { recursive: true, force: true }));

let n = 0;

/** An app directory named `slug`, holding `files` (relative path → contents). */
function fixture(files: Record<string, string>, slug = "probe"): string {
  const dir = path.join(tmp, String(n++), slug);
  fs.mkdirSync(dir, { recursive: true });
  for (const [rel, contents] of Object.entries(files)) {
    fs.mkdirSync(path.dirname(path.join(dir, rel)), { recursive: true });
    fs.writeFileSync(path.join(dir, rel), contents);
  }
  return dir;
}

/** Each finding as `file:line what why`, the way the skip message prints it. */
const lines = (findings: ContainmentFinding[]) =>
  findings.map((f) => `${f.file}${f.line > 0 ? `:${f.line}` : ""} ${f.what ? `${f.what} ` : ""}${f.why}`);

/** Scan one app holding `files`, as the generator does. */
const scan = (files: Record<string, string>, slug?: string) => lines(scanAppContainment(fixture(files, slug)));

/** One file's findings, each `line what why`, from a route at api/a/route.ts. */
const route = (source: string) => scan({ "api/a/route.ts": source }).map((l) => l.replace(/^api\/a\/route\.ts:/, ""));

/** Assert exactly these findings, each matched by a pattern, in order. */
function expect(actual: string[], ...patterns: RegExp[]) {
  assert.equal(actual.length, patterns.length, `expected ${patterns.length} finding(s), got:\n${actual.join("\n")}`);
  patterns.forEach((pattern, i) => assert.match(actual[i], pattern));
}

// ── the platform modules the denylist never named (SA-4) ───────────────────

describe("platform modules off the list", () => {
  test("each is refused at its line, with what to use instead", () => {
    expect(
      route(
        [
          'import { sendPushToUsers } from "@/lib/push/server";',
          'import { loadAppEnv } from "@/lib/apps/env";',
          'import { getUserById, setUserAppRole } from "@/lib/apps/access";',
          'import { mintApiKey } from "@/lib/apps/api-keys";',
          'import { createHttpClient } from "@/lib/apps/http";',
          'import { hooks } from "@/lib/hooks";',
          'import { buildAppContext } from "@/lib/apps/context";',
          'import { createScopedClient } from "@/lib/apps/scoped-db";',
          'import { auth } from "@/lib/auth";',
          'import { appRegistry } from "@/generated/app-registry";',
        ].join("\n"),
      ),
      /^1 import "@\/lib\/push\/server" sends push notifications without the `notifications` grant\. .*context\.notifications\.send\(\)/,
      /^2 import "@\/lib\/apps\/env" reads settings past the manifest, other apps' included\. .*context\.env/,
      /^3 import "@\/lib\/apps\/access" administers users, roles, keys or sessions/,
      /^4 import "@\/lib\/apps\/api-keys" administers users, roles, keys or sessions/,
      /^5 import "@\/lib\/apps\/http" reaches the network directly, past the manifest's `egress`/,
      /^6 import "@\/lib\/hooks" is the platform's hook system, which can act as any app\. Use context\.hooks/,
      /^7 import "@\/lib\/apps\/context" is the platform's App Services broker or context builder/,
      /^8 import "@\/lib\/apps\/scoped-db" reaches the database around context\.db\. .*`import type \{ ScopedClient \}` is fine/,
      /^9 import "@\/lib\/auth" administers users, roles, keys or sessions/,
      /^10 import "@\/generated\/app-registry" is not on the list of platform modules an app may import/,
    );
  });

  test("a module named nowhere is refused too: the list is default-deny", () => {
    expect(
      route(
        [
          'import { satisfiesMinimum } from "@/lib/platform/version";',
          'import { WidgetProps } from "@/lib/hooks/types";',
        ].join("\n"),
      ),
      /^1 import "@\/lib\/platform\/version" is not on the list of platform modules an app may import .*`import type` is fine from anywhere/,
      /^2 import "@\/lib\/hooks\/types" is not on the list of platform modules .*`import type` is fine from anywhere/,
    );
  });

  test("acting as another app through the hook system is refused at the import", () => {
    expect(
      scan({
        "hooks.ts": [
          'import { hooks } from "@/lib/hooks";',
          'import { HookSystem } from "@/lib/hooks/hook-system";',
          'import { appRegistrar } from "@/lib/hooks/loader";',
          'import type { HookRegistrar } from "@/lib/hooks";',
          "export default function register(h: HookRegistrar) {",
          '  hooks.createRegistrar("other-app", { entrypoint: true }).addFilter("brand-name", () => "x");',
          '  hooks.clearEntrypoint("other-app");',
          "}",
        ].join("\n"),
      }),
      /^hooks\.ts:1 import "@\/lib\/hooks" is the platform's hook system/,
      /^hooks\.ts:2 import "@\/lib\/hooks\/hook-system" is the platform's hook system/,
      /^hooks\.ts:3 import "@\/lib\/hooks\/loader" is the platform's hook system/,
    );
  });
});

// ── judged by where it lands, not how it is spelled ────────────────────────

describe("resolution", () => {
  test("an alias that climbs back into a refused module is refused like it", () => {
    expect(route('import { sql } from "@/lib/db/../db/client";'), /^1 import "@\/lib\/db\/\.\.\/db\/client" reaches the database/);
    expect(route('import x from "@apps/../src/lib/db/client";'), /^1 import "@apps\/\.\.\/src\/lib\/db\/client" reaches the database/);
  });

  test("a path out of the app is refused, even to a module on the list", () => {
    const real = path.join(ROOT, "src/lib/apps/route.ts");
    expect(
      route(
        [
          'import * as raw from "../../../../src/lib/db/server";',
          `import { defineRoute } from ${JSON.stringify(real)};`,
          'import { x } from "@apps/probe/../wall-e/lib/shared/quotes";',
        ].join("\n"),
      ),
      /^1 import "\.\.\/\.\.\/\.\.\/\.\.\/src\/lib\/db\/server" leaves the app's own directory\. An app imports its own files, and platform modules by their @\/ name/,
      /^2 import ".*\/src\/lib\/apps\/route\.ts" leaves the app's own directory/,
      /^3 import "@apps\/probe\/\.\.\/wall-e\/lib\/shared\/quotes" leaves the app's own directory/,
    );
  });

  test("a symlinked folder is refused, and so is an import through it", () => {
    const dir = fixture({
      "api/a/route.ts": 'import { defineRoute } from "../../lib/link/route";\nexport const GET = defineRoute;\n',
    });
    fs.mkdirSync(path.join(dir, "lib"), { recursive: true });
    fs.symlinkSync(path.join(ROOT, "src/lib/apps"), path.join(dir, "lib", "link"));
    expect(
      lines(scanAppContainment(dir)),
      /^api\/a\/route\.ts:1 import "\.\.\/\.\.\/lib\/link\/route" leaves the app's own directory/,
      /^lib\/link is a symbolic link, which can point anywhere/,
    );
  });

  test("a symlinked file is refused, wherever it is in the tree", () => {
    const dir = fixture({ "assets/logo.png": "" });
    fs.symlinkSync(path.join(ROOT, ".env.local.example"), path.join(dir, "assets", "secrets.png"));
    expect(lines(scanAppContainment(dir)), /^assets\/secrets\.png is a symbolic link/);
  });

  test("another app's code is refused at runtime, installed here or not", () => {
    expect(
      route(
        [
          'import { QUOTES } from "@apps/wall-e/lib/shared/quotes";',
          'import { secret } from "@apps/other/lib/server/db";',
          'import type { Quote } from "@apps/wall-e/lib/shared/quotes";',
        ].join("\n"),
      ),
      /^1 import "@apps\/wall-e\/lib\/shared\/quotes" runs another app's code around App Services\. Declare `consumes`/,
      /^2 import "@apps\/other\/lib\/server\/db" runs another app's code around App Services/,
    );
  });

  test("a connector is refused at runtime, in every tier, and its types are fine", () => {
    expect(
      scan({
        "lib/server/sheets.ts": 'import Sheets from "@connectors/google-sheets";\nexport const s = Sheets;\n',
        "api/a/route.ts": 'import { readCredentials } from "@/lib/connectors/config";\n',
        "jobs/sync.ts": 'import type { GoogleSheetsConnector } from "@connectors/google-sheets";\n',
      }),
      /^api\/a\/route\.ts:1 import "@\/lib\/connectors\/config" builds a connector outside context\.connectors/,
      /^lib\/server\/sheets\.ts:1 import "@connectors\/google-sheets" builds a connector outside context\.connectors/,
    );
  });

  test("a specifier that names no file is refused", () => {
    expect(
      route('import x from "#internal";\nimport y from "./missing";'),
      /^1 import "#internal" resolves to no file the build can read/,
      /^2 import "\.\/missing" resolves to no file the build can read/,
    );
  });
});

// ── packages and built-ins ─────────────────────────────────────────────────

describe("packages and built-ins", () => {
  test("Node built-ins are refused, with or without node:", () => {
    expect(
      route(
        [
          'import fs from "node:fs";',
          'import { readFileSync } from "fs";',
          'import { readFile } from "fs/promises";',
          'import { execSync } from "child_process";',
          'import { createRequire } from "node:module";',
          'import { Worker } from "worker_threads";',
          'import vm from "vm";',
          'import { randomUUID } from "node:crypto";',
          'import https from "node:https";',
          'import proc from "process";',
        ].join("\n"),
      ),
      /^1 import "node:fs" is a Node built-in, and apps get none/,
      /^2 import "fs" is a Node built-in/,
      /^3 import "fs\/promises" is a Node built-in/,
      /^4 import "child_process" is a Node built-in/,
      /^5 import "node:module" is a Node built-in/,
      /^6 import "worker_threads" is a Node built-in/,
      /^7 import "vm" is a Node built-in/,
      /^8 import "node:crypto" is a Node built-in/,
      /^9 import "node:https" reaches the network directly/,
      /^10 import "process" reads settings past the manifest/,
    );
  });

  test("packages off the list are refused; next is allowed only at its listed paths", () => {
    expect(
      route(
        [
          'import postgres from "postgres";',
          'import { cookies } from "next/headers";',
          'import { NextResponse } from "next/server";',
          'import Image from "next/image";',
          'import axios from "axios";',
          'import { marked } from "marked";',
          'import { createPortal } from "react-dom";',
        ].join("\n"),
      ),
      /^1 import "postgres" reaches the database around context\.db/,
      /^2 import "next\/headers" belongs to the platform: the request, the session and the response/,
      /^3 import "next\/server" belongs to the platform/,
      /^4 import "next\/image" belongs to the platform/,
      /^5 import "axios" reaches the network directly/,
      /^6 import "marked" is not a package MixOS provides to apps\. Apps may import react, zod, lucide-react/,
      /^7 import "react-dom" is not a package MixOS provides to apps/,
    );
  });
});

// ── what the scan cannot read is refused (the five branch gaps) ─────────────

describe("loading code around the import rules", () => {
  test("require and module, however they are reached", () => {
    expect(
      route(
        [
          "const r = require;",
          'export const a = r("child_process");',
          'export const b = (0, require)("child_process");',
          'export const c = module.require("fs");',
          'export const d = require.call(null, "fs");',
          'export const e = globalThis.require("fs");',
          'export const f = (window as any)["module"];',
          "export const g = { require };",
          "export { require as req };",
        ].join("\n"),
      ),
      /^1 require is a module loader/,
      /^3 require is a module loader/,
      /^4 module is a module loader/,
      /^5 require is a module loader/,
      /^6 globalThis\.require is a module loader/,
      /^7 window\.module is a module loader/,
      /^8 require is a module loader/,
      /^9 require is a module loader/,
    );
  });

  test("a bundler's own loader, and the module wrapper's arguments", () => {
    expect(
      route(
        [
          'export const a = __non_webpack_require__("fs");',
          "export const b = __turbopack_context__;",
          'export const c = globalThis.__next_require__("x");',
          "export const d = arguments[1];",
          "export function ok() { return arguments.length; }",
          "export const proto = ({} as any).__proto__;",
        ].join("\n"),
      ),
      /^1 __non_webpack_require__ is a module loader/,
      /^2 __turbopack_context__ is a module loader/,
      /^3 globalThis\.__next_require__ is a module loader/,
      /^4 arguments is a module loader/,
    );
  });

  test("import() is for the app's own files, named by a literal", () => {
    expect(
      route(
        [
          "export const a = (x: string) => import(x);",
          'export const b = (x: string) => import(`../${x}`);',
          "export const c = (x: string) => import(`./locales/${x}`);",
          'export const d = import("data:text/javascript,export default 1");',
          'export const e = import("file:///etc/passwd");',
          'export const f = import("https://example.com/x.js");',
          'export const g = import("@/lib/apps/sdk");',
          'export const h = import("react");',
          'export const i = import("../../lib/own");',
          "export const j = import(`../../lib/own`);",
        ].join("\n"),
      ),
      /^1 import\(…\) loads a module whose name is built at runtime/,
      /^2 import\(…\) loads a module whose name is built at runtime/,
      /^3 import\(…\) loads a module whose name is built at runtime/,
      /^4 import\("data:text\/javascript,export default 1"\) is a URL, which loads code the build never read/,
      /^5 import\("file:\/\/\/etc\/passwd"\) is a URL/,
      /^6 import\("https:\/\/example\.com\/x\.js"\) is a URL/,
      /^7 import\("@\/lib\/apps\/sdk"\) loads a module at runtime\. import\(\) is for the app's own files/,
      /^8 import\("react"\) loads a module at runtime/,
      /^9 import\("\.\.\/\.\.\/lib\/own"\) resolves to no file the build can read/,
      /^10 import\("\.\.\/\.\.\/lib\/own"\) resolves to no file the build can read/,
    );
    // The same two literal imports, with the file there, are the app's own.
    expect(
      scan({
        "api/a/route.ts": 'export const i = import("../../lib/own");\nexport const j = import(`../../lib/own`);\n',
        "lib/own.ts": "export const own = 1;\n",
      }),
    );
  });

  test("import x = require() is CommonJS, and import.meta is refused", () => {
    expect(
      route('import fs = require("fs");\nimport type T = require("./types");\nexport const u = import.meta.url;'),
      /^1 import fs = require\("fs"\) is CommonJS\. App code is ES modules: use import/,
      /^3 import\.meta is the module's own location/,
    );
  });

  test("code in a directory the scan does not read cannot be imported", () => {
    expect(
      scan({
        "api/a/route.ts": [
          'export { h } from "../../.hidden/evil";',
          'export { i } from "../../assets/evil";',
          'export { j } from "../../plans/evil";',
          'export { k } from "../../lib/types";',
          'import data from "../../assets/data.json";',
          'import logo from "../../assets/logo.png";',
          'import "../../styles/app.css";',
          "export const all = [data, logo];",
        ].join("\n"),
        ".hidden/evil.ts": "export const h = process.env.DATABASE_URL;\n",
        "assets/evil.ts": "export const i = process.env.AUTH_SECRET;\n",
        "plans/evil.ts": "export const j = process.env.X;\n",
        "lib/types.d.ts": "export declare const k: string;\n",
        "assets/data.json": "{}\n",
        "assets/logo.png": "",
        "styles/app.css": "",
      }),
      /^api\/a\/route\.ts:1 export … from "\.\.\/\.\.\/\.hidden\/evil" loads a file the build does not read/,
      /^api\/a\/route\.ts:2 export … from "\.\.\/\.\.\/assets\/evil" loads a file the build does not read/,
      /^api\/a\/route\.ts:3 export … from "\.\.\/\.\.\/plans\/evil" loads a file the build does not read/,
      /^api\/a\/route\.ts:4 export … from "\.\.\/\.\.\/lib\/types" loads a file the build does not read/,
    );
  });

  test("node_modules/ and package.json are refused anywhere in the tree", () => {
    expect(
      scan({
        "lib/node_modules/zod/index.js": "module.exports = {};\n",
        "assets/vendor/package.json": "{}\n",
        "package.json": '{ "imports": { "#db": "../../src/lib/db/client.ts" } }\n',
      }),
      /^assets\/vendor\/package\.json changes how the app's imports resolve/,
      /^lib\/node_modules holds packages the build never read/,
      /^package\.json changes how the app's imports resolve/,
    );
  });

  test(".js, .mjs and .cjs files are read like .ts", () => {
    expect(
      scan({
        "lib/a.js": 'import { hooks } from "@/lib/hooks";\nexport const a = hooks;\n',
        "lib/b.mjs": 'export { readFileSync } from "fs";\n',
        "lib/c.cjs": 'module.exports = require("child_process");\n',
      }),
      /^lib\/a\.js:1 import "@\/lib\/hooks" is the platform's hook system/,
      /^lib\/b\.mjs:1 export … from "fs" is a Node built-in/,
      /^lib\/c\.cjs:1 module is a module loader/,
      /^lib\/c\.cjs:1 require is a module loader/,
    );
  });
});

// ── names, not just modules ────────────────────────────────────────────────

describe("names", () => {
  test("a module that mixes app API with internals gives only the listed names", () => {
    expect(
      route(
        [
          'import { defineRoute, runRoute } from "@/lib/apps/route";',
          'import route from "@/lib/apps/route";',
          'import { runSync } from "@/lib/apps/sync";',
          'import { RETRYABLE_CATEGORIES } from "@/lib/connectors/errors";',
          'export { toErrorResponse } from "@/lib/apps/errors";',
        ].join("\n"),
      ),
      /^1 import \{ runRoute \} from "@\/lib\/apps\/route" is not app API\. From "@\/lib\/apps\/route" an app may import defineRoute, AppError, isAppError/,
      /^2 import \{ default \} from "@\/lib\/apps\/route" is not app API/,
      /^3 import \{ runSync \} from "@\/lib\/apps\/sync" is not app API\. .*defineSync/,
      /^4 import \{ RETRYABLE_CATEGORIES \} from "@\/lib\/connectors\/errors" is not app API/,
      /^5 export \{ toErrorResponse \} from "@\/lib\/apps\/errors" is not app API/,
    );
  });

  test("import * and export * take every export, so only from a \"*\" module", () => {
    expect(
      route(
        [
          'import * as route from "@/lib/apps/route";',
          'export * from "@/lib/apps/call";',
          'export * as sync from "@/lib/apps/sync";',
          'import * as sdk from "@/lib/apps/sdk";',
          'export * from "@/components/ui/button";',
          'import * as React from "react";',
          "export const all = [route, sdk, React];",
        ].join("\n"),
      ),
      /^1 import \* as … from "@\/lib\/apps\/route" takes every export of "@\/lib\/apps\/route", which also holds platform internals/,
      /^2 export \* from "@\/lib\/apps\/call" takes every export/,
      /^3 export \* from "@\/lib\/apps\/sync" takes every export/,
    );
  });
});

// ── a page or widget and the app's own server tier ─────────────────────────

test("a page or widget may not import the app's lib/server", () => {
  expect(
    scan({
      "pages/Main.tsx": 'import { rows } from "../lib/server/data";\nexport default () => rows;\n',
      "widgets/w.tsx": 'import { rows } from "@apps/probe/lib/server/data";\nexport default () => rows;\n',
      "api/a/route.ts": 'import { rows } from "../../lib/server/data";\nexport const r = rows;\n',
      "lib/server/data.ts": "export const rows = [];\n",
    }),
    /^pages\/Main\.tsx:1 import "\.\.\/lib\/server\/data" reaches the app's server tier from a page or widget/,
    /^widgets\/w\.tsx:1 import "@apps\/probe\/lib\/server\/data" reaches the app's server tier/,
  );
});

// ── callAppRoute runs only the app's own routes (SA-21) ────────────────────

describe("callAppRoute", () => {
  const page = (body: string) =>
    scan({ "pages/Main.tsx": `import { callAppRoute } from "@/lib/apps/call";\n${body}\n` }, "careers").map((l) =>
      l.replace(/^pages\/Main\.tsx:/, ""),
    );

  test("with this app's own slug, as a literal, it passes", () => {
    expect(
      page(
        [
          'export const a = () => callAppRoute("careers", "GET /jobs");',
          'export const b = () => callAppRoute<{ n: number }>("careers", "GET /jobs", { limit: 1 });',
          'export const c = () => (callAppRoute)("careers" as const, "GET /jobs");',
          "export const d = () => callAppRoute(`careers`, \"GET /jobs\");",
          "type Call = typeof callAppRoute;",
        ].join("\n"),
      ),
    );
  });

  test("another app's slug, or one named at runtime, is refused", () => {
    expect(
      page(
        [
          'export const a = () => callAppRoute("payroll", "DELETE /runs/[id]", { id: 1 });',
          'export const b = (slug: string) => callAppRoute(slug, "GET /x");',
          'export const c = (args: [string, string]) => callAppRoute(...args);',
          "export const d = () => callAppRoute();",
        ].join("\n"),
      ),
      /^2 callAppRoute\("payroll", …\) can run another app's routes as the current user\. .*"careers"/,
      /^3 callAppRoute\(slug, …\) can run another app's routes/,
      /^4 callAppRoute\(\.\.\.args, …\) can run another app's routes/,
      /^5 callAppRoute\(\) can run another app's routes/,
    );
  });

  test("any use but a direct call is refused, renamed or not", () => {
    expect(
      scan(
        {
          "pages/Main.tsx": [
            'import { callAppRoute as call } from "@/lib/apps/call";',
            "const f = call;",
            'export const b = () => call.call(null, "careers", "GET /x");',
            "export const c = { call };",
            "export { call };",
            "export default call;",
          ].join("\n"),
          "lib/reexport.ts": 'export { callAppRoute } from "@/lib/apps/call";\n',
        },
        "careers",
      ),
      /^lib\/reexport\.ts:1 export \{ callAppRoute \} from "@\/lib\/apps\/call" can run another app's routes/,
      /^pages\/Main\.tsx:2 call can run another app's routes/,
      /^pages\/Main\.tsx:3 call can run another app's routes/,
      /^pages\/Main\.tsx:4 call can run another app's routes/,
      /^pages\/Main\.tsx:5 call can run another app's routes/,
      /^pages\/Main\.tsx:6 call can run another app's routes/,
    );
  });

  test("a parameter that shadows it is not it", () => {
    expect(page('export const a = (callAppRoute: (s: string) => void) => callAppRoute("payroll");'));
  });
});

// ── writing to a module the platform shares (the direct forms) ─────────────

describe("patching shared modules", () => {
  test("property writes and the Object/Reflect writers, through an imported binding", () => {
    expect(
      scan({
        "lib/own.ts": "export const own: { x?: number } = {};\n",
        "api/a/route.ts": [
          'import { AppError, defineRoute } from "@/lib/apps/route";',
          'import { z } from "zod";',
          'import * as React from "react";',
          'import { own } from "../../lib/own";',
          "AppError.prototype.toJSON = () => ({});",
          "z.string = () => z.any();",
          '(z as any)["object"] = null;',
          "delete (defineRoute as any).name;",
          "(React as any).version++;",
          "[(z as any).number] = [null];",
          "Object.defineProperty(z, \"string\", { value: null });",
          "Object.assign(AppError.prototype, { toJSON: null });",
          "Reflect.set(React, \"useState\", null);",
          "own.x = 1;",
          "const local = { x: 1 };",
          "local.x = 2;",
        ].join("\n"),
      }).map((l) => l.replace(/^api\/a\/route\.ts:/, "")),
      /^5 AppError\.prototype\.toJSON = writes to a module the app shares with the platform and every other app/,
      /^6 z\.string = writes to a module the app shares/,
      /^7 \(z as any\)\["object"\] = writes to a module/,
      /^8 delete \(defineRoute as any\)\.name writes to a module/,
      /^9 \(React as any\)\.version\+\+ writes to a module/,
      /^10 \(z as any\)\.number = writes to a module/,
      /^11 Object\.defineProperty\(z, …\) writes to a module/,
      /^12 Object\.assign\(AppError\.prototype, …\) writes to a module/,
      /^13 Reflect\.set\(React, …\) writes to a module/,
    );
  });
});

// ── a declaration the compiler erases is not a local ───────────────────────

test("an erased declaration does not hide a global", () => {
  expect(
    scan({
      "api/a/route.ts": [
        "declare const process: { env: Record<string, string> };",
        'import type { require } from "../../lib/types";',
        "export const a = process.env.DATABASE_URL;",
        'export const b = require("fs");',
        "export { fetch };",
      ].join("\n"),
      "lib/shim.ts": "declare var module: any;\nexport {};\ndeclare global { var fetch: any; }\n",
      "lib/script.ts": "var WebSocket: any;\n",
      "lib/use.ts": [
        'export const c = fetch("https://example.com");',
        "export const d = module;",
        'export const e = new WebSocket("wss://example.com");',
      ].join("\n"),
      "lib/types.ts": "export type require = (id: string) => unknown;\n",
    }),
    /^api\/a\/route\.ts:3 process\.env reads the process environment/,
    /^api\/a\/route\.ts:4 require is a module loader/,
    /^api\/a\/route\.ts:5 fetch reaches the network directly/,
    /^lib\/use\.ts:1 fetch reaches the network directly/,
    /^lib\/use\.ts:2 module is a module loader/,
    /^lib\/use\.ts:3 WebSocket reaches the network directly/,
  );
});

test("a function overload or a namespace alias, erased too, does not hide a global", () => {
  expect(
    route(
      [
        "function fetch(url: string): Promise<unknown>;",
        "namespace N { export type T = 1; }",
        "import process = N.T;",
        'export const a = fetch("https://example.com");',
        "export const b = process.env.X;",
      ].join("\n"),
    ),
    /^4 fetch reaches the network directly/,
    /^5 process\.env reads the process environment/,
  );
});

test("the global object is read by name, never handed on", () => {
  expect(
    route(
      [
        "const g = globalThis;",
        "const { process: p } = globalThis;",
        'export const a = Reflect.get(globalThis, "process");',
        "export const b = globalThis.globalThis.process.env;",
        'export const c = window.top.fetch("https://example.com");',
        "export const d = (window as any).parent;",
        "export const e = globalThis.global.__next_require__;",
        "export const f = [g, p];",
        'export const ok1 = typeof window !== "undefined" && "IntersectionObserver" in window;',
        "export const ok2 = () => window.setTimeout(() => window.location.reload(), 1000);",
        "export const ok3 = (window as any).someFlag;",
      ].join("\n"),
    ),
    /^1 globalThis hands the global object on, which hides which of its names are read/,
    /^2 globalThis hands the global object on/,
    /^3 globalThis hands the global object on/,
    /^4 globalThis\.globalThis\.process reads the process environment/,
    /^5 window\.top\.fetch reaches the network directly/,
    /^6 \(window as any\)\.parent hands the global object on/,
    /^7 globalThis\.global\.__next_require__ is a module loader/,
  );
});

// ── what an app may do ──────────────────────────────────────────────────────

describe("allowed", () => {
  test("every import the first-party apps make", () => {
    expect(
      scan(
        {
          "pages/Main.tsx": [
            'import Link from "next/link";',
            'import { useRouter, useSearchParams } from "next/navigation";',
            'import { Inter } from "next/font/google";',
            'import localFont from "next/font/local";',
            'import { useEffect, useState } from "react";',
            'import { jsx } from "react/jsx-runtime";',
            'import { z } from "zod";',
            'import { ChevronRight, type LucideIcon } from "lucide-react";',
            'import { callAppRoute } from "@/lib/apps/call";',
            'import { AppPageHeader } from "@/components/ui/app-page-header";',
            'import { EmptyState, ErrorState } from "@/components/ui/app-states";',
            'import { AsyncView } from "@/components/ui/async-view";',
            'import { Badge } from "@/components/ui/badge";',
            'import { Button, IconButton } from "@/components/ui/button";',
            'import { Card, CardBody, CARD_SHELL } from "@/components/ui/card";',
            'import ConfigureShell from "@/components/ui/configure-shell";',
            'import { DataTable } from "@/components/ui/data-table";',
            'import { Dialog } from "@/components/ui/dialog";',
            'import { Field } from "@/components/ui/field";',
            'import { Input } from "@/components/ui/input";',
            'import { Markdown } from "@/components/ui/markdown";',
            'import { SectionCard } from "@/components/ui/section-card";',
            'import { Skeleton } from "@/components/ui/skeleton";',
            'import { StatusDot } from "@/components/ui/status";',
            'import { createAppClient, AppClientError, enablePushNotifications, getPushPermission, isPushSupported, track } from "@/lib/apps/sdk";',
            'import { useAppQuery } from "@/lib/apps/use-app-query";',
            'import { useClientValue } from "@/lib/use-client-value";',
            'import { cn } from "@/lib/utils";',
            'import { titleField } from "@/lib/apps/widget-config-presets";',
            'export const data = () => callAppRoute("careers", "GET /jobs");',
          ].join("\n"),
          "lib/server/numbers.ts": [
            'import { createSwrCache } from "@/lib/apps/swr-cache";',
            'import { isConnectorError, ConnectorError } from "@/lib/connectors/errors";',
            'import { AppError, isAppError } from "@/lib/apps/errors";',
            'import { defineSync } from "@/lib/apps/sync";',
            'import { defineRoute, AppError as E2, isAppError as is2 } from "@/lib/apps/route";',
          ].join("\n"),
        },
        "careers",
      ),
    );
  });

  test("types, from anywhere", () => {
    expect(
      route(
        [
          'import type { ScopedClient } from "@/lib/apps/scoped-db";',
          'import type { HookRegistrar } from "@/lib/hooks";',
          'import { type AppContext, type WidgetProps } from "@/lib/hooks/types";',
          'import type GoogleSheetsConnector from "@connectors/google-sheets";',
          'import type { ListResourcesResult } from "@apps/file-library/services/types";',
          'export type { RouteBudget } from "@/lib/apps/route";',
          'export type * from "@/lib/apps/types";',
          'export { type ServiceContext } from "@/lib/hooks/types";',
          'type Db = typeof import("@/lib/db/client");',
          'type Ctx = import("@/lib/apps/context").AppContextBuilder;',
        ].join("\n"),
      ),
    );
  });

  test("the app's own files, by path or by its own @apps/ name, JSON, CSS and images", () => {
    expect(
      scan({
        "api/a/route.ts": [
          'import { QUOTES } from "../../lib/shared/quotes";',
          'import { more } from "@apps/probe/lib/shared/quotes";',
          'import manifest from "@apps/probe/app.json";',
          'import data from "../../lib/data.json";',
          'export * from "../../lib/shared/quotes";',
          'export const lazy = () => import("../../lib/shared/quotes");',
          "export const all = [QUOTES, more, manifest, data];",
        ].join("\n"),
        "pages/Main.tsx": [
          'import logo from "../assets/logo.png";',
          'import styles from "../styles/page.module.css";',
          'import "../styles/global.css";',
          'import { QUOTES } from "../lib/shared/quotes";',
          "export default () => [logo, styles, QUOTES];",
        ].join("\n"),
        "lib/shared/quotes.ts": "export const QUOTES = [];\nexport const more = 1;\n",
        "lib/data.json": "{}\n",
        "app.json": "{}\n",
        "assets/logo.png": "",
        "styles/page.module.css": "",
        "styles/global.css": "",
        "plans/README.md": "",
        ".git/config": "",
      }),
    );
  });

  test("the connector helpers the docs teach: the card from @/components/ui, and ctx.connectorErrorResponse", () => {
    const files = {
      "widgets/deals.tsx": [
        '"use client";',
        'import { useState } from "react";',
        'import ConnectorErrorState from "@/components/ui/connector-error-state";',
        'import { connectorErrorOf, createAppClient } from "@/lib/apps/sdk";',
        "export default function Deals({ appSlug }: { appSlug: string }) {",
        "  const [err, setErr] = useState<unknown>(null);",
        '  const load = () => createAppClient(appSlug).call("GET /export").catch(setErr);',
        "  const envelope = connectorErrorOf(err);",
        "  return envelope ? <ConnectorErrorState envelope={envelope} onRetry={load} /> : null;",
        "}",
      ].join("\n"),
      "api/export/route.ts": [
        'import { defineRoute } from "@/lib/apps/route";',
        "export const GET = defineRoute({",
        "  raw: true,",
        "  handler: async (ctx) => {",
        "    try {",
        "      return Response.json(await (ctx.connectors.acme as never as { listThings(o: object): Promise<unknown> }).listThings({ signal: ctx.signal }));",
        "    } catch (err) {",
        "      return ctx.connectorErrorResponse(err);",
        "    }",
        "  },",
        "});",
      ].join("\n"),
    };
    expect(scan(files));
    // The envelope module stays off the list: the admin flag is the pipeline's to pass.
    expect(
      route('import { connectorErrorResponse } from "@/lib/connectors/response";\nexport const r = connectorErrorResponse;'),
      /^1 import "@\/lib\/connectors\/response" builds a connector outside context\.connectors/,
    );
  });

  test("apps/_template, which every scaffolded app starts from, and wall-e", () => {
    for (const app of ["_template", "wall-e"]) {
      const dir = path.join(ROOT, "apps", app);
      assert.deepEqual(lines(scanAppContainment(dir)), [], `apps/${app} should be clean`);
    }
  });
});

test("formatFindings prints a file-level finding without a line", () => {
  assert.equal(
    formatFindings([
      { file: "package.json", line: 0, what: "", why: "changes how the app's imports resolve." },
      { file: "api/a/route.ts", line: 3, what: 'import "fs"', why: "is a Node built-in." },
    ]),
    '\n      package.json — changes how the app\'s imports resolve.\n      api/a/route.ts:3 — import "fs" is a Node built-in.',
  );
});

// ── the editor's copy ───────────────────────────────────────────────────────

test("ESLint reports what the scan reports, at the same lines, in the same words", async () => {
  // Constructs whose verdict does not depend on where the file sits on disk:
  // the scan reads a fixture in a temp directory, ESLint a path under apps/.
  const source = [
    'import { sendPushToUsers } from "@/lib/push/server";',
    'import { hooks } from "@/lib/hooks";',
    'import { sql } from "@/lib/db/../db/client";',
    'import fs from "node:fs";',
    'import postgres from "postgres";',
    'import { cookies } from "next/headers";',
    'import Sheets from "@connectors/google-sheets";',
    'import { secret } from "@apps/other/lib/server/db";',
    'import { defineRoute, runRoute } from "@/lib/apps/route";',
    'import * as call from "@/lib/apps/call";',
    'import { callAppRoute } from "@/lib/apps/call";',
    'import { z } from "zod";',
    "const r = require;",
    "export const m = module;",
    'export const d = import("data:text/javascript,1");',
    "export const c = (x: string) => import(x);",
    "export const u = import.meta.url;",
    'export const g = () => callAppRoute("other", "GET /x");',
    "z.string = () => z.any();",
    "export const all = [sendPushToUsers, hooks, sql, fs, postgres, cookies, Sheets, secret, defineRoute, runRoute, call, r];",
  ].join("\n");

  const scanned = scanAppContainment(fixture({ "api/a/route.ts": source })).map((f) => `${f.line} ${f.what} ${f.why}`);
  const [result] = await new ESLint({ cwd: ROOT }).lintText(source, {
    filePath: path.join(ROOT, "apps/probe/api/a/route.ts"),
  });
  const linted = result.messages.filter((m) => m.ruleId === "mos-apps/app-imports").map((m) => `${m.line} ${m.message}`);

  assert.equal(scanned.length, 17);
  assert.deepEqual(linted, scanned);
});
