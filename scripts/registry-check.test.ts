/* This Source Code Form is subject to the terms of the Mozilla Public
 * License, v. 2.0. If a copy of the MPL was not distributed with this
 * file, You can obtain one at https://mozilla.org/MPL/2.0/. */

/**
 * An install's check: `generate-project-registry.ts --check` on a staged
 * extension. It reads the extension's text, runs none of its code, writes
 * nothing but its verdict, and judges the extension against the extensions
 * already registered. Also the scans' dot-folder skip.
 *
 * The first half runs the real check the way an install does, through
 * checkExtension() in src/lib/repository/install.ts. The second half calls the
 * same checks in this process, for the cases that need no child process.
 * Neither needs a database or the generated registry: each gives the check a
 * registry directory of its own.
 */

import { after, before, describe, test } from "node:test";
import assert from "node:assert/strict";
import crypto from "crypto";
import fs from "fs";
import os from "os";
import path from "path";
import {
  checkExtension,
  spawnCapture,
  type CheckOutcome,
} from "../src/lib/repository/install";
import {
  checkStaged,
  readRegistered,
  scanApps,
  scanConnectors,
  scanThemes,
  type Registered,
} from "./generate-project-registry";
import { bareHandlerProblem, rawResponseRefusal, undeclaredRoleProblems } from "./route-contracts";
import { withRegistryId } from "../src/lib/extensions/slug-id";

// ── fixtures ────────────────────────────────────────────────────────────────

const ROOT = path.resolve(__dirname, "..");
const TSX = path.join(ROOT, "node_modules", "tsx", "dist", "cli.mjs");
const tmp = fs.realpathSync(fs.mkdtempSync(path.join(os.tmpdir(), "mixos-registry-check-")));
after(() => fs.rmSync(tmp, { recursive: true, force: true }));

/** Printed by a fixture's module when it is imported, if it ever is. */
const IMPORTED = "MIXOS-FIXTURE-IMPORTED";

let n = 0;

/** Write `files` (relative path → contents) under `dir`. */
function write(dir: string, files: Record<string, string>): void {
  for (const [rel, contents] of Object.entries(files)) {
    fs.mkdirSync(path.dirname(path.join(dir, rel)), { recursive: true });
    fs.writeFileSync(path.join(dir, rel), contents);
  }
}

/** A staged extension: a folder named `name`, as an install stages one, holding `files`. */
function stage(name: string, files: Record<string, string>): string {
  const dir = path.join(tmp, `stage-${n++}`, name);
  fs.mkdirSync(dir, { recursive: true });
  write(dir, files);
  return dir;
}

/**
 * One of this repository's connector or theme templates, copied to
 * `into/<name>`, its manifest's `registryId` set to `registryId`.
 */
function template(kind: "connectors" | "themes", from: string, into: string, name: string, registryId = name): string {
  const dir = path.join(into, name);
  fs.cpSync(path.join(ROOT, kind, from), dir, { recursive: true });
  const file = path.join(dir, kind === "connectors" ? "connector.json" : "theme.json");
  const manifest = JSON.parse(fs.readFileSync(file, "utf8")) as Record<string, unknown>;
  fs.writeFileSync(file, JSON.stringify(withRegistryId(manifest, registryId), null, 2));
  return dir;
}

/** A connector template staged as `name`, its manifest's `registryId` set to `declared`. */
function stageConnector(name: string, { from = "_template", declared = name, edit = (m: Record<string, unknown>) => m } = {}): string {
  const dir = template("connectors", from, path.join(tmp, `stage-${n++}`), name, declared);
  const file = path.join(dir, "connector.json");
  const manifest = JSON.parse(fs.readFileSync(file, "utf8")) as Record<string, unknown>;
  fs.writeFileSync(file, JSON.stringify(edit(manifest), null, 2));
  return dir;
}

/**
 * A registered app, as the generator writes one into app-registry.ts. Its
 * `connectorRequirements` follow `connectors` unless a test sets them: each
 * built against 1.0.0, reading only.
 */
function registeredApp(slug: string, fields: Record<string, unknown> = {}): Record<string, unknown> {
  const names = (fields.connectors as string[] | undefined) ?? [];
  return {
    slug,
    name: slug,
    description: "",
    tagline: null,
    icon: "box",
    connectors: [],
    optionalConnectors: [],
    connectorRequirements: names.map((name) => ({ name, optional: false, access: "read", version: "1.0.0" })),
    database: false,
    updatedAt: [],
    notifications: false,
    hasPages: false,
    pageCount: 0,
    global: false,
    roles: [],
    defaultRole: null,
    hookCounts: { actions: 0, filters: 0 },
    hooks: { emits: { actions: [], filters: [] }, listens: { actions: [], filters: [] } },
    authors: [],
    keywords: [],
    screenshots: [],
    license: null,
    appUrl: null,
    appSupportUrl: null,
    lastUpdated: null,
    widgets: [],
    schedules: [],
    sync: [],
    emits: [],
    listensTo: [],
    branding: null,
    escapes: [],
    env: [],
    egress: [],
    routes: [],
    telemetry: [],
    provides: [],
    consumes: [],
    mcp: [],
    ...fields,
  };
}

/** A registered connector, as the generator writes one into connector-registry.ts. */
function registeredConnector(name: string, fields: Record<string, unknown> = {}): Record<string, unknown> {
  return { name, displayName: name, version: "1.0.0", telemetry: [], ...fields };
}

/** A registry directory holding `apps` and `connectors`, in the generator's own format. */
function registryDir(apps: Record<string, unknown>[] = [], connectors: Record<string, unknown>[] = []): string {
  const dir = path.join(tmp, `registry-${n++}`);
  write(dir, {
    "app-registry.ts":
      `// AUTO-GENERATED by scripts/generate-project-registry.ts — do not edit\n` +
      `import type { AppManifest } from "@/lib/apps/types";\n\n` +
      `export const appRegistry: AppManifest[] = ${JSON.stringify(apps, null, 2)};\n\n` +
      `export const appSlugs = [${apps.map((a) => JSON.stringify(a.slug)).join(", ")}] as const;\n` +
      `export const widgetLoaders = {\n  "x/y.tsx": () => import("@apps/x/y"),\n};\n`,
    "connector-registry.ts":
      `// AUTO-GENERATED by scripts/generate-project-registry.ts — do not edit\n` +
      `import type { ConnectorManifest } from "@/lib/connectors/types";\n\n` +
      `export const connectorRegistry: ConnectorManifest[] = ${JSON.stringify(connectors, null, 2)};\n`,
  });
  return dir;
}

/** The same registered set, as checkStaged() takes it in this process. */
function registered(apps: Record<string, unknown>[] = [], connectors: Record<string, unknown>[] = []): Registered {
  return readRegistered(registryDir(apps, connectors));
}

/** Every file under `dir`: path → size, mtime and content hash. Empty when `dir` is absent. */
function snapshot(dir: string): Record<string, string> {
  const out: Record<string, string> = {};
  const walk = (at: string) => {
    if (!fs.existsSync(at)) return;
    for (const entry of fs.readdirSync(at, { withFileTypes: true })) {
      const full = path.join(at, entry.name);
      if (entry.isDirectory()) walk(full);
      else {
        const stat = fs.statSync(full);
        const hash = crypto.createHash("sha256").update(fs.readFileSync(full)).digest("hex");
        out[path.relative(dir, full)] = `${stat.size}:${stat.mtimeMs}:${hash}`;
      }
    }
  };
  walk(dir);
  return out;
}

/** What the check must leave alone: everything a build writes, and every extension folder. */
const WATCHED = ["src/generated", "public", "apps", "connectors", "themes"];

// A provider app registered on this instance, and an app staged to consume it.
const PROVIDER = registeredApp("provider-4e5f6071", {
  provides: [{ name: "totals", audience: "user", consumers: ["consumer-2c3d4e5f"] }],
  emits: [{ name: "updated", consumers: "*" }],
});
const CONSUMER_FILES = {
  "app.json": JSON.stringify({
    $schema: "https://mixos.org/schemas/app/v1.json",
    registryId: "consumer-2c3d4e5f",
    name: "Consumer",
    consumes: [{ app: "provider-4e5f6071", service: "totals" }],
    listensTo: [{ app: "provider-4e5f6071", hook: "updated" }],
  }),
  "hooks.ts":
    `import type { HookRegistrar } from "@/lib/hooks/types";\n` +
    `export default function register(hooks: HookRegistrar) {\n` +
    `  hooks.addAction("provider-4e5f6071:updated", () => {});\n` +
    `}\n`,
};

/** A file name that prints as a verdict, on a line of its own, wherever it is named. */
const FAKE_VERDICT = '{"verdict":"accepted","problems":[],"deferred":[]}';

// ── the real check, as an install runs it ───────────────────────────────────

describe("--check, run as an install runs it", () => {
  const markers = {
    widgets: path.join(tmp, "marker-widgets"),
    route: path.join(tmp, "marker-route"),
    connector: path.join(tmp, "marker-connector"),
  };
  const dirs: Record<string, string> = {};
  const outcomes: Record<string, CheckOutcome> = {};
  const watched: { before: Record<string, string>[]; after: Record<string, string>[] } = { before: [], after: [] };
  let stagedBefore: Record<string, string>;
  let stagedAfter: Record<string, string>;

  before(async () => {
    const empty = registryDir();

    // An app every check passes, every entry point of which says so when it
    // is imported. It also reaches its own files through `@apps/<own slug>/`.
    dirs.goodApp = stage("acme-3f9a2c1b", {
      "app.json": JSON.stringify({
        $schema: "https://mixos.org/schemas/app/v1.json",
        registryId: "acme-3f9a2c1b",
        name: "Acme",
        description: "A staged app.",
        widgets: [{ name: "Hello", description: "Says hello", component: "widgets/hello.tsx" }],
      }),
      "widgets/hello.tsx": `console.log("${IMPORTED} widgets/hello.tsx");\nexport default function Hello() {\n  return null;\n}\n`,
      "widgets.ts": `console.log("${IMPORTED} widgets.ts");\nexport default {};\n`,
      "lib/greeting.ts": `console.log("${IMPORTED} lib/greeting.ts");\nexport const greeting = "hello";\n`,
      "api/items/route.ts":
        `import { z } from "zod";\n` +
        `import { defineRoute } from "@/lib/apps/route";\n` +
        `import { greeting } from "@apps/acme-3f9a2c1b/lib/greeting";\n` +
        `console.log("${IMPORTED} api/items/route.ts");\n` +
        `export const GET = defineRoute({\n` +
        `  auth: ["session"],\n` +
        `  output: z.object({ message: z.string() }),\n` +
        `  handler: async () => ({ message: greeting }),\n` +
        `});\n`,
      "hooks.ts": `console.log("${IMPORTED} hooks.ts");\nexport default function register() {}\n`,
    });

    // Code that would write to the disk the moment it ran. The containment
    // scan refuses it, and nothing runs it.
    dirs.fsApp = stage("grabby-2b3c4d5e", {
      "app.json": JSON.stringify({
        $schema: "https://mixos.org/schemas/app/v1.json",
        registryId: "grabby-2b3c4d5e",
        name: "Grabby",
        widgets: [{ name: "W", description: "A widget", component: "widgets/w.tsx" }],
      }),
      "widgets/w.tsx": `export default function W() {\n  return null;\n}\n`,
      "widgets.ts":
        `import { writeFileSync } from "node:fs";\n` +
        `writeFileSync(${JSON.stringify(markers.widgets)}, "widgets.ts ran");\n` +
        `export default {};\n`,
      "api/run/route.ts":
        `import { writeFileSync } from "node:fs";\n` +
        `writeFileSync(${JSON.stringify(markers.route)}, "route.ts ran");\n` +
        `export {};\n`,
    });

    dirs.badApp = stage("broken-4c5d6e7f", {
      "app.json": JSON.stringify({ $schema: "https://mixos.org/schemas/app/v1.json", registryId: "broken-4c5d6e7f", name: "Broken", sidebar: true }),
    });

    // Routes whose source says what the build will make of them, and one whose
    // options it cannot read. Each says so if it is ever imported.
    const route = (name: string, rel: string, body: string) =>
      stage(name, {
        "app.json": JSON.stringify({
          $schema: "https://mixos.org/schemas/app/v1.json",
          registryId: name,
          name,
          roles: [{ key: "viewer", label: "Viewer" }],
        }),
        [rel]:
          `import { z } from "zod";\nimport { defineRoute } from "@/lib/apps/route";\n` +
          `console.log("${IMPORTED} ${rel}");\n${body}`,
      });
    const json = `output: z.object({ ok: z.boolean() }), handler: async () => ({ ok: true })`;
    dirs.bareRoute = route("bare-5a6b7c8d", "api/hello/route.ts", `export async function GET() {\n  return new Response("hi");\n}\n`);
    dirs.ghostRoute = route("ghost-6b7c8d9e", "api/secret/route.ts", `export const GET = defineRoute({ roles: ["ghost"], ${json} });\n`);
    dirs.rawRoute = route(
      "raw-7c8d9e0f",
      "api/file/route.ts",
      `export const GET = defineRoute({ raw: true, handler: async () => new Response("x") });\n`,
    );
    dirs.unreadRoute = route(
      "opaque-8d9e0f1a",
      "api/items/route.ts",
      `const options = { roles: ["viewer"], ${json} };\nexport const GET = defineRoute(options);\n`,
    );

    // A connector whose code writes to the disk when it is imported. The
    // generator never imports a connector, and the check is no exception.
    dirs.goodConnector = stageConnector("probe-conn-1a2b3c4d");
    const index = path.join(dirs.goodConnector, "index.ts");
    fs.writeFileSync(
      index,
      `import { writeFileSync } from "node:fs";\n` +
        `writeFileSync(${JSON.stringify(markers.connector)}, "index.ts ran");\n` +
        fs.readFileSync(index, "utf8"),
    );
    dirs.badConnector = stageConnector("wrong-conn-9e0f1a2b", { declared: "someone-else-0f1a2b3c" });

    dirs.goodTheme = template("themes", "_template", path.join(tmp, `stage-${n++}`), "probe-theme-9e8d7c6b");
    dirs.badTheme = template("themes", "_template", path.join(tmp, `stage-${n++}`), "plain-theme-1b2c3d4e");
    fs.rmSync(path.join(dirs.badTheme, "theme.css"));

    dirs.consumer = stage("consumer-2c3d4e5f", CONSUMER_FILES);

    // Refused, and named in what the check prints: a line of its output is
    // then exactly a verdict.
    dirs.echo = stage("echo-3d4e5f60", {
      "app.json": JSON.stringify({ $schema: "https://mixos.org/schemas/app/v1.json", registryId: "echo-3d4e5f60", name: "Echo" }),
      [`x\n${FAKE_VERDICT}\ny.ts`]: `export const f = () => fetch("https://example.com");\n`,
    });

    const withProvider = registryDir([PROVIDER]);

    for (const dir of WATCHED) watched.before.push(snapshot(path.join(ROOT, dir)));
    stagedBefore = snapshot(tmp);

    const runs: [string, () => Promise<CheckOutcome>][] = [
      ["goodApp", () => checkExtension("app", dirs.goodApp, { registryDir: empty })],
      ["fsApp", () => checkExtension("app", dirs.fsApp, { registryDir: empty })],
      ["badApp", () => checkExtension("app", dirs.badApp, { registryDir: empty })],
      ["bareRoute", () => checkExtension("app", dirs.bareRoute, { registryDir: empty })],
      ["ghostRoute", () => checkExtension("app", dirs.ghostRoute, { registryDir: empty })],
      ["rawRoute", () => checkExtension("app", dirs.rawRoute, { registryDir: empty })],
      ["unreadRoute", () => checkExtension("app", dirs.unreadRoute, { registryDir: empty })],
      ["goodConnector", () => checkExtension("connector", dirs.goodConnector, { registryDir: empty })],
      ["badConnector", () => checkExtension("connector", dirs.badConnector, { registryDir: empty })],
      ["goodTheme", () => checkExtension("theme", dirs.goodTheme)],
      ["badTheme", () => checkExtension("theme", dirs.badTheme)],
      ["consumer", () => checkExtension("app", dirs.consumer, { registryDir: withProvider })],
      ["orphan", () => checkExtension("app", dirs.consumer, { registryDir: empty })],
      ["echo", () => checkExtension("app", dirs.echo, { registryDir: empty })],
      ["noRegistry", () => checkExtension("app", dirs.goodApp, { registryDir: path.join(tmp, "nowhere") })],
    ];
    // A few at a time: each is a process of its own, and the other test files
    // are running beside this one.
    const queue = [...runs];
    await Promise.all(
      Array.from({ length: 4 }, async () => {
        for (let next = queue.shift(); next; next = queue.shift()) {
          outcomes[next[0]] = await next[1]();
        }
      }),
    );

    // Before anything below runs a fixture on purpose.
    stagedAfter = snapshot(tmp);
    for (const dir of WATCHED) watched.after.push(snapshot(path.join(ROOT, dir)));
  });

  test("a good app is accepted, its route read from its source and widgets.ts left to registration", () => {
    const o = outcomes.goodApp;
    assert.equal(o.ran, true, o.output);
    assert.equal(o.accepted, true, o.problems.join("\n"));
    assert.deepEqual(o.deferred, [
      "apps/acme-3f9a2c1b/widgets.ts: the widget config fields it builds are checked at registration, which loads it.",
    ]);
  });

  test("a route its source shows breaking the build's rules is refused, in the build's words", () => {
    const expected: Record<string, string[]> = {
      bareRoute: [bareHandlerProblem("bare-5a6b7c8d", "hello", "GET")],
      ghostRoute: undeclaredRoleProblems("ghost-6b7c8d9e", "secret", "GET", ["ghost"], [{ key: "viewer" }]),
      rawRoute: rawResponseRefusal("raw-7c8d9e0f", [{ routePath: "file", method: "GET" }], [])!.problems,
    };
    for (const [name, problems] of Object.entries(expected)) {
      const o = outcomes[name];
      assert.equal(o.ran, true, o.output);
      assert.equal(o.accepted, false, name);
      assert.deepEqual(o.problems, problems, name);
    }
  });

  test("a route whose options the check cannot read is accepted, and left to registration with the reason", () => {
    const o = outcomes.unreadRoute;
    assert.equal(o.ran, true, o.output);
    assert.equal(o.accepted, true, o.problems.join("\n"));
    assert.deepEqual(o.deferred, [
      "apps/opaque-8d9e0f1a/api/items/route.ts: GET's options are in a variable, so its contract is checked at registration, which loads it.",
    ]);
  });

  test("no module of the extension is imported", async () => {
    for (const name of Object.keys(outcomes)) {
      assert.ok(!outcomes[name].output.includes(IMPORTED), `${name}: ${outcomes[name].output}`);
    }
    // The fixture does say so when it is imported: run its widgets.ts directly.
    const run = await spawnCapture(process.execPath, [TSX, path.join(dirs.goodApp, "widgets.ts")], dirs.goodApp);
    assert.equal(run.code, 0, run.output);
    assert.match(run.output, new RegExp(`${IMPORTED} widgets\\.ts`));
  });

  test("code that writes to the disk when it runs is refused, and never runs", async () => {
    const o = outcomes.fsApp;
    assert.equal(o.ran, true, o.output);
    assert.equal(o.accepted, false);
    assert.equal(o.problems.length, 2, o.problems.join("\n"));
    assert.match(o.problems[0], /^apps\/grabby-2b3c4d5e\/api\/run\/route\.ts:1 — import "node:fs"/);
    assert.match(o.problems[1], /^apps\/grabby-2b3c4d5e\/widgets\.ts:1 — import "node:fs"/);
    assert.equal(fs.existsSync(markers.widgets), false, "widgets.ts ran");
    assert.equal(fs.existsSync(markers.route), false, "route.ts ran");
    // It would have: run directly, it writes its marker.
    const run = await spawnCapture(process.execPath, [TSX, path.join(dirs.fsApp, "widgets.ts")], dirs.fsApp);
    assert.equal(run.code, 0, run.output);
    assert.equal(fs.existsSync(markers.widgets), true);
  });

  test("a malformed app is rejected, naming its manifest", () => {
    const o = outcomes.badApp;
    assert.equal(o.ran, true, o.output);
    assert.equal(o.accepted, false);
    assert.match(o.problems[0], /^apps\/broken-4c5d6e7f\/app\.json failed validation:[\s\S]*sidebar/);
  });

  test("a good connector is accepted, and its code never runs", () => {
    const o = outcomes.goodConnector;
    assert.equal(o.ran, true, o.output);
    assert.equal(o.accepted, true, o.problems.join("\n"));
    assert.deepEqual(o.deferred, []);
    assert.equal(fs.existsSync(markers.connector), false, "the connector's index.ts ran");
  });

  test("a connector whose manifest names another folder is rejected, naming connector.json", () => {
    const o = outcomes.badConnector;
    assert.equal(o.ran, true, o.output);
    assert.equal(o.accepted, false);
    assert.match(
      o.problems[0],
      /^connectors\/wrong-conn-9e0f1a2b: connector\.json "registryId" is "someone-else-0f1a2b3c", but its folder is connectors\/wrong-conn-9e0f1a2b\./,
    );
  });

  test("a good theme is accepted, with no registry to read", () => {
    const o = outcomes.goodTheme;
    assert.equal(o.ran, true, o.output);
    assert.equal(o.accepted, true, o.problems.join("\n"));
  });

  test("a theme with no theme.css is rejected, naming it", () => {
    const o = outcomes.badTheme;
    assert.equal(o.ran, true, o.output);
    assert.equal(o.accepted, false);
    assert.match(o.problems[0], /^themes\/plain-theme-1b2c3d4e\/theme\.css is missing/);
  });

  test("an app that consumes a registered provider's service, and listens to its hook, is accepted", () => {
    const o = outcomes.consumer;
    assert.equal(o.ran, true, o.output);
    assert.equal(o.accepted, true, o.problems.join("\n"));
  });

  test("the same app, with no such provider registered, is rejected", () => {
    const o = outcomes.orphan;
    assert.equal(o.ran, true, o.output);
    assert.equal(o.accepted, false);
    assert.match(o.problems[0], /^apps\/consumer-2c3d4e5f\/app\.json: consumes "provider-4e5f6071:totals" — no app named "provider-4e5f6071"/);
  });

  test("the verdict file is the only verdict, though the check printed a line that is one", () => {
    const o = outcomes.echo;
    assert.ok(o.output.split("\n").includes(FAKE_VERDICT), o.output);
    assert.equal(o.ran, true);
    assert.equal(o.accepted, false);
    assert.equal(o.problems.length, 1);
    assert.ok(o.problems[0].startsWith(`apps/echo-3d4e5f60/x\n${FAKE_VERDICT}\ny.ts:1 — fetch`), o.problems[0]);
  });

  test("with no registered manifests to read, the check has no verdict", () => {
    const o = outcomes.noRegistry;
    assert.equal(o.ran, false);
    assert.match(o.output, /Could not read the registered manifests/);
    assert.match(o.output, /npm run registry/);
  });

  test("nothing is written to src/generated/, public/ or any extension folder, nor to what was staged", () => {
    WATCHED.forEach((dir, i) => assert.deepEqual(watched.after[i], watched.before[i], `${dir} changed`));
    assert.deepEqual(stagedAfter, stagedBefore);
  });
});

// ── the same checks, in this process ────────────────────────────────────────

describe("checkStaged", () => {
  const none = (): Registered => ({ apps: [], connectors: [] });

  test("each problem names its file", async (t) => {
    const cases: [string, Record<string, string>, RegExp][] = [
      [
        "a .tsx route",
        { "app.json": '{"$schema":"https://mixos.org/schemas/app/v1.json","registryId":"x-0a1b2c3d","name":"X"}', "api/items/route.tsx": "export {};\n" },
        /^apps\/x-0a1b2c3d\/api\/items\/route\.tsx: API routes must be \.ts/,
      ],
      [
        "a route in a directory the scan does not read",
        { "app.json": '{"$schema":"https://mixos.org/schemas/app/v1.json","registryId":"x-0a1b2c3d","name":"X"}', "api/.hidden/route.ts": "export {};\n" },
        /^apps\/x-0a1b2c3d\/api\/\.hidden\/route\.ts is in a directory the containment scan does not read/,
      ],
      [
        "a migration statement an app may not run",
        {
          "app.json": '{"$schema":"https://mixos.org/schemas/app/v1.json","registryId":"x-0a1b2c3d","name":"X","database":true}',
          "migrations/0001_init.sql": "create function f() returns int as $$ select 1 $$ language sql;\n",
        },
        /^apps\/x-0a1b2c3d\/migrations\/0001_init\.sql/,
      ],
      [
        "migrations without a database",
        { "app.json": '{"$schema":"https://mixos.org/schemas/app/v1.json","registryId":"x-0a1b2c3d","name":"X"}', "migrations/0001_init.sql": "create table t (id int);\n" },
        /^apps\/x-0a1b2c3d\/migrations\/ holds 1 SQL file\(s\), but app\.json does not set "database": true/,
      ],
      [
        "another app's hook fired",
        { "app.json": '{"$schema":"https://mixos.org/schemas/app/v1.json","registryId":"x-0a1b2c3d","name":"X"}', "hooks.ts": 'export default (h: { doAction(n: string): void }) => h.doAction("other:thing");\n' },
        /^apps\/x-0a1b2c3d\/hooks\.ts:1 — fires "other:thing", a hook of "other"/,
      ],
      [
        "an entry point the scan does not read",
        {
          "app.json": JSON.stringify({ $schema: "https://mixos.org/schemas/app/v1.json", registryId: "x-0a1b2c3d", name: "X", widgets: [{ name: "W", description: "A widget", component: "assets/w.tsx" }] }),
          "assets/w.tsx": "export default () => null;\n",
        },
        /^apps\/x-0a1b2c3d\/assets\/w\.tsx: the platform would load it, but the containment scan does not read it/,
      ],
      [
        "a schedule with no handler",
        { "app.json": JSON.stringify({ $schema: "https://mixos.org/schemas/app/v1.json", registryId: "x-0a1b2c3d", name: "X", schedules: [{ name: "nightly", everyMinutes: 60 }] }) },
        /^apps\/x-0a1b2c3d\/app\.json: schedules\[\]\.name "nightly" has no handler on disk/,
      ],
      ["no manifest", { "README.md": "# X\n" }, /^apps\/x-0a1b2c3d has no app\.json\./],
      ["a manifest that is not JSON", { "app.json": "{ name: X" }, /^apps\/x-0a1b2c3d\/app\.json could not be read/],
    ];
    for (const [what, files, pattern] of cases) {
      await t.test(what, async () => {
        const { problems, deferred } = await checkStaged("app", stage("x-0a1b2c3d", files), none());
        assert.equal(problems.length, 1, problems.join("\n"));
        assert.match(problems[0], pattern);
        assert.deepEqual(deferred, []);
      });
    }
  });

  test("a folder name that cannot be a slug is refused", async () => {
    const { problems } = await checkStaged("app", stage("Not_A-Slug", { "app.json": '{"$schema":"https://mixos.org/schemas/app/v1.json","registryId":"x-0a1b2c3d","name":"X"}' }), none());
    assert.match(problems[0], /^apps\/Not_A-Slug: /);
  });

  test("a slug a platform page has is refused", async () => {
    const { problems } = await checkStaged("app", stage("release-notes", { "app.json": '{"$schema":"https://mixos.org/schemas/app/v1.json","registryId":"x-0a1b2c3d","name":"X"}' }), none());
    assert.match(problems[0], /^apps\/release-notes: "release-notes" is reserved: \/apps\/release-notes is a page/);
  });

  test("release notes are checked as each kind is staged, and a good file is accepted", async () => {
    const notes = (list: unknown[]) =>
      JSON.stringify({ $schema: "https://mixos.org/schemas/release-notes/v1.json", notes: list });
    const good = notes([{ date: "2026-08-28", note: "First release." }]);
    const long = notes([{ date: "2026-08-28", note: "x".repeat(301) }]);

    const app = (notes: string) => stage("x-0a1b2c3d", { "app.json": '{"$schema":"https://mixos.org/schemas/app/v1.json","registryId":"x-0a1b2c3d","name":"X"}', "release-notes.json": notes });
    assert.deepEqual((await checkStaged("app", app(good), none())).problems, []);
    const [appProblem] = (await checkStaged("app", app(long), none())).problems;
    assert.match(appProblem, /^apps\/x-0a1b2c3d\/release-notes\.json failed validation[\s\S]*notes\.0\.note: is 301 characters/);

    const connector = (notes: string) => {
      const dir = stageConnector("crm-5e6f7a8b");
      fs.writeFileSync(path.join(dir, "release-notes.json"), notes);
      return dir;
    };
    assert.deepEqual((await checkStaged("connector", connector(good), registered())).problems, []);
    const [connectorProblem] = (await checkStaged("connector", connector(long), registered())).problems;
    assert.match(connectorProblem, /^connectors\/crm-5e6f7a8b: release-notes\.json failed validation/);

    const theme = (notes: string) => {
      const dir = template("themes", "_template", path.join(tmp, `stage-${n++}`), "plain-9c0d1e2f");
      fs.writeFileSync(path.join(dir, "release-notes.json"), notes);
      return dir;
    };
    assert.deepEqual((await checkStaged("theme", theme(good), none())).problems, []);
    const [themeProblem] = (await checkStaged("theme", theme("[{"), none())).problems;
    assert.match(themeProblem, /^themes\/plain-9c0d1e2f\/release-notes\.json is not valid JSON/);
  });

  test("a route is read from its source: a bare handler is refused, and options it cannot read wait for registration", async () => {
    const bare = await checkStaged(
      "app",
      stage("x-0a1b2c3d", { "app.json": '{"$schema":"https://mixos.org/schemas/app/v1.json","registryId":"x-0a1b2c3d","name":"X"}', "api/index/route.ts": "export async function GET() {}\n" }),
      none(),
    );
    assert.deepEqual(bare, { problems: [bareHandlerProblem("x-0a1b2c3d", "", "GET")], deferred: [] });

    const opaque = await checkStaged(
      "app",
      stage("x-0a1b2c3d", {
        "app.json": '{"$schema":"https://mixos.org/schemas/app/v1.json","registryId":"x-0a1b2c3d","name":"X"}',
        "api/index/route.ts":
          'import { defineRoute } from "@/lib/apps/route";\nimport { options } from "../../lib/options";\n' +
          "export const GET = defineRoute(options);\n",
        "lib/options.ts": "export const options = {};\n",
      }),
      none(),
    );
    assert.deepEqual(opaque, {
      problems: [],
      deferred: [
        "apps/x-0a1b2c3d/api/index/route.ts: GET's options are imported from another file, so its contract is checked at registration, which loads it.",
      ],
    });
  });

  test("a route problem is reported with what was left to registration", async () => {
    const { problems, deferred } = await checkStaged(
      "app",
      stage("x-0a1b2c3d", {
        "app.json": '{"$schema":"https://mixos.org/schemas/app/v1.json","registryId":"x-0a1b2c3d","name":"X"}',
        "widgets.ts": "export default {};\n",
        "api/index/route.ts": "export const GET = async () => new Response();\n",
      }),
      none(),
    );
    assert.deepEqual(problems, [bareHandlerProblem("x-0a1b2c3d", "", "GET")]);
    assert.deepEqual(deferred, [
      "apps/x-0a1b2c3d/widgets.ts: the widget config fields it builds are checked at registration, which loads it.",
    ]);
  });

  test("a consumer is accepted against a registered provider that allows it, and refused by one that does not", async () => {
    const consumer = stage("consumer-2c3d4e5f", CONSUMER_FILES);
    assert.deepEqual((await checkStaged("app", consumer, registered([PROVIDER]))).problems, []);

    const stingy = registeredApp("provider-4e5f6071", {
      provides: [{ name: "totals", audience: "user", consumers: ["someone-else"] }],
      emits: [{ name: "updated", consumers: "*" }],
    });
    const { problems } = await checkStaged("app", consumer, registered([stingy]));
    assert.match(problems[0], /"provider-4e5f6071" provides "totals" but its consumers allowlist does not include "consumer-2c3d4e5f"/);
  });

  test("a listener the registered emitter does not allow is refused", async () => {
    const quiet = registeredApp("provider-4e5f6071", {
      provides: [{ name: "totals", audience: "user", consumers: "*" }],
      emits: [{ name: "updated", consumers: ["someone-else"] }],
    });
    const { problems } = await checkStaged("app", stage("consumer-2c3d4e5f", CONSUMER_FILES), registered([quiet]));
    assert.match(problems[0], /apps\/provider-4e5f6071 does not allow "consumer-2c3d4e5f" to listen to "updated"/);
  });

  test("a staged app takes the place of a registered entry with its slug", async () => {
    // Registered under the same slug with a different service: judged as the
    // staged copy, which consumes nothing.
    const stale = registeredApp("acme-3f9a2c1b", { consumes: [{ app: "gone", service: "x" }] });
    const { problems } = await checkStaged("app", stage("acme-3f9a2c1b", { "app.json": '{"$schema":"https://mixos.org/schemas/app/v1.json","registryId":"acme-3f9a2c1b","name":"Acme"}' }), registered([stale]));
    assert.deepEqual(problems, []);
  });

  test("a scheduled job on a registered user-scoped connector is refused", async () => {
    const app = stage("digest-7a8b9c0d", {
      "app.json": JSON.stringify({
        $schema: "https://mixos.org/schemas/app/v1.json",
        registryId: "digest-7a8b9c0d",
        name: "Digest",
        connectors: [{ name: "my-mail-6f7a8b9c", version: "1.0.0" }],
        schedules: [{ name: "daily", everyMinutes: 60 }],
      }),
      "jobs/daily.ts": "export default async () => {};\n",
    });
    const { problems } = await checkStaged("app", app, registered([], [registeredConnector("my-mail-6f7a8b9c", { userScoped: true })]));
    assert.match(problems[0], /^apps\/digest-7a8b9c0d\/app\.json declares the user-scoped connector\(s\) my-mail-6f7a8b9c and also schedule "daily"/);
  });

  test("a staged user-scoped connector that a registered app's job uses is refused", async () => {
    const connector = stageConnector("my-mail-6f7a8b9c", {
      from: "_template-oauth",
      edit: (m) => ({ ...m, userScoped: true }),
    });
    const digest = registeredApp("digest-7a8b9c0d", { connectors: ["my-mail-6f7a8b9c"], schedules: [{ name: "daily", everyMinutes: 60 }] });

    assert.deepEqual((await checkStaged("connector", connector, registered())).problems, []);
    const { problems } = await checkStaged("connector", connector, registered([digest]));
    assert.match(problems[0], /^apps\/digest-7a8b9c0d\/app\.json declares the user-scoped connector\(s\) my-mail-6f7a8b9c/);
  });

  test("an app built against a newer connector than the one installed is refused, naming the update", async () => {
    const app = stage("ledger-8b9c0d1e", {
      "app.json": JSON.stringify({ $schema: "https://mixos.org/schemas/app/v1.json", registryId: "ledger-8b9c0d1e", name: "Ledger", connectors: [{ name: "crm-5e6f7a8b", version: "1.2.0" }] }),
    });
    const { problems } = await checkStaged("app", app, registered([], [registeredConnector("crm-5e6f7a8b", { version: "1.1.4" })]));
    assert.equal(problems.length, 1);
    assert.match(problems[0], /^apps\/ledger-8b9c0d1e\/app\.json was built against crm-5e6f7a8b 1\.2\.0 or a later 1\.x release, and connectors\/crm-5e6f7a8b is 1\.1\.4\./);
    assert.match(problems[0], /Update crm-5e6f7a8b to 1\.2\.0 or later first\./);

    const later = await checkStaged("app", app, registered([], [registeredConnector("crm-5e6f7a8b", { version: "1.4.0" })]));
    assert.deepEqual(later.problems, []);
  });

  test("an app built against an older major version than the one installed is refused", async () => {
    const app = stage("ledger-8b9c0d1e", {
      "app.json": JSON.stringify({ $schema: "https://mixos.org/schemas/app/v1.json", registryId: "ledger-8b9c0d1e", name: "Ledger", connectors: [{ name: "crm-5e6f7a8b", version: "1.2.0" }] }),
    });
    const { problems } = await checkStaged("app", app, registered([], [registeredConnector("crm-5e6f7a8b", { version: "2.0.0" })]));
    assert.match(problems[0], /2\.0\.0 is a new major version, which may remove or change what the app calls\./);
  });

  test("an app asking to change data in a connector with no write method is refused", async () => {
    const app = stage("ledger-8b9c0d1e", {
      "app.json": JSON.stringify({ $schema: "https://mixos.org/schemas/app/v1.json", registryId: "ledger-8b9c0d1e", name: "Ledger", connectors: [{ name: "crm-5e6f7a8b", version: "1.0.0", access: "write" }] }),
    });
    const reads = registeredConnector("crm-5e6f7a8b", { telemetry: [{ method: "listDeals", operation: "GET /deals" }] });
    const { problems } = await checkStaged("app", app, registered([], [reads]));
    assert.match(problems[0], /^apps\/ledger-8b9c0d1e\/app\.json asks to change data in crm-5e6f7a8b, which declares no method that changes anything\./);

    const writes = registeredConnector("crm-5e6f7a8b", {
      telemetry: [{ method: "createDeal", operation: "POST /deals", mutates: true }],
    });
    assert.deepEqual((await checkStaged("app", app, registered([], [writes]))).problems, []);
  });

  test("a connector release with a new major version is refused while an installed app needs the old one", async () => {
    const connector = stageConnector("crm-5e6f7a8b", { edit: (m) => ({ ...m, version: "2.0.0" }) });
    const ledger = registeredApp("ledger-8b9c0d1e", { connectors: ["crm-5e6f7a8b"] });

    assert.deepEqual((await checkStaged("connector", connector, registered())).problems, []);
    const { problems } = await checkStaged("connector", connector, registered([ledger]));
    assert.match(problems[0], /^apps\/ledger-8b9c0d1e\/app\.json was built against crm-5e6f7a8b 1\.0\.0 or a later 1\.x release, and connectors\/crm-5e6f7a8b is 2\.0\.0\./);

    const minor = stageConnector("crm-5e6f7a8b", { edit: (m) => ({ ...m, version: "1.3.0" }) });
    assert.deepEqual((await checkStaged("connector", minor, registered([ledger]))).problems, []);
  });
});

// ── the registered manifests ────────────────────────────────────────────────

describe("readRegistered", () => {
  test("reads the generated modules as text, imports and loaders included", () => {
    const read = readRegistered(
      registryDir([PROVIDER], [registeredConnector("my-mail-6f7a8b9c", { userScoped: true, displayName: "Mail" })]),
    );
    assert.deepEqual(read.apps.map((a) => a.slug), ["provider-4e5f6071"]);
    assert.deepEqual(read.connectors.map((c) => c.name), ["my-mail-6f7a8b9c"]);
  });

  test("refuses a registry in a shape it cannot check against, rather than misjudging an extension", () => {
    const dir = registryDir([{ slug: "old", name: "Old" }]);
    assert.throws(() => readRegistered(dir), /Could not read the registered manifests in .*app-registry\.ts[\s\S]*npm run registry/);
  });

  test("refuses a missing registry", () => {
    assert.throws(() => readRegistered(path.join(tmp, "nowhere")), /Could not read the registered manifests/);
  });
});

// ── the scans skip dot-prefixed folders ─────────────────────────────────────

describe("the scans skip dot-prefixed folders", () => {
  // Each dot-prefixed folder here holds what the scan would otherwise read and
  // refuse outright: a folder name that cannot be a slug aborts the run.
  test("apps", async (t) => {
    t.mock.method(console, "log", () => {});
    t.mock.method(console, "warn", () => {});
    const apps = path.join(tmp, `apps-${n++}`);
    write(apps, {
      "acme-3f9a2c1b/app.json": '{"$schema":"https://mixos.org/schemas/app/v1.json","registryId":"acme-3f9a2c1b","name":"Acme"}',
      "acme-3f9a2c1b/README.md": "# Acme\n",
      ".installing-ghost-6b7c8d9e/app.json": '{"$schema":"https://mixos.org/schemas/app/v1.json","registryId":"ghost-6b7c8d9e","name":"Ghost"}',
      ".backup-acme-3f9a2c1b/app.json": '{"$schema":"https://mixos.org/schemas/app/v1.json","registryId":"acme-3f9a2c1b","name":"Acme, before"}',
      "_template/app.json": '{"$schema":"https://mixos.org/schemas/app/v1.json","registryId":"template-00000000","name":"Template"}',
    });
    const manifests = await scanApps(apps, { emit: false });
    assert.deepEqual(manifests.map((m) => m.slug), ["acme-3f9a2c1b"]);
  });

  test("connectors", async (t) => {
    t.mock.method(console, "log", () => {});
    const connectors = path.join(tmp, `connectors-${n++}`);
    for (const name of ["probe-conn-1a2b3c4d", ".installing-probe-conn-1a2b3c4d", ".backup-probe-conn-1a2b3c4d"]) {
      template("connectors", "_template", connectors, name, "probe-conn-1a2b3c4d");
    }
    const manifests = await scanConnectors(connectors, { emit: false });
    assert.deepEqual(manifests.map((c) => c.name), ["probe-conn-1a2b3c4d"]);
  });

  test("themes", async (t) => {
    t.mock.method(console, "log", () => {});
    const themes = path.join(tmp, `themes-${n++}`);
    for (const name of ["probe-theme-9e8d7c6b", ".installing-probe-theme-9e8d7c6b", ".leftover"]) {
      template("themes", "_template", themes, name, "probe-theme-9e8d7c6b");
    }
    const { themes: found } = await scanThemes(themes, { emit: false });
    assert.deepEqual(found.map((th) => th.slug), ["probe-theme-9e8d7c6b"]);
  });
});

// ── a removal's run leaves its extension out, folder and all ────────────────

describe("the scans leave out the extension a removal names", () => {
  // `--without <kind>/<slug>`: the folder is still there, and the scan reads
  // past it, so the registry stops importing it before any of its files go.
  test("apps", async (t) => {
    t.mock.method(console, "log", () => {});
    t.mock.method(console, "warn", () => {});
    const apps = path.join(tmp, `apps-${n++}`);
    write(apps, {
      "acme-3f9a2c1b/app.json": '{"$schema":"https://mixos.org/schemas/app/v1.json","registryId":"acme-3f9a2c1b","name":"Acme"}',
      "acme-3f9a2c1b/README.md": "# Acme\n",
      "board-4c7e1a92/app.json": '{"$schema":"https://mixos.org/schemas/app/v1.json","registryId":"board-4c7e1a92","name":"Board"}',
      "board-4c7e1a92/README.md": "# Board\n",
    });
    const manifests = await scanApps(apps, { emit: false, leftOut: "acme-3f9a2c1b" });
    assert.deepEqual(manifests.map((m) => m.slug), ["board-4c7e1a92"]);
  });

  test("connectors", async (t) => {
    t.mock.method(console, "log", () => {});
    const connectors = path.join(tmp, `connectors-${n++}`);
    for (const name of ["probe-conn-1a2b3c4d", "other-conn-5e6f7a8b"]) template("connectors", "_template", connectors, name);
    const manifests = await scanConnectors(connectors, { emit: false, leftOut: "probe-conn-1a2b3c4d" });
    assert.deepEqual(manifests.map((c) => c.name), ["other-conn-5e6f7a8b"]);
  });

  test("themes", async (t) => {
    t.mock.method(console, "log", () => {});
    const themes = path.join(tmp, `themes-${n++}`);
    for (const name of ["probe-theme-9e8d7c6b", "other-theme-0a1b2c3d"]) template("themes", "_template", themes, name);
    const { themes: found } = await scanThemes(themes, { emit: false, leftOut: "probe-theme-9e8d7c6b" });
    assert.deepEqual(found.map((th) => th.slug), ["other-theme-0a1b2c3d"]);
  });
});
