/* This Source Code Form is subject to the terms of the Mozilla Public
 * License, v. 2.0. If a copy of the MPL was not distributed with this
 * file, You can obtain one at https://mozilla.org/MPL/2.0/. */

/**
 * The static route reader (scripts/route-reader.ts) and the full generator,
 * judging the same apps.
 *
 * Each fixture is an app with a route or two. The reader judges it as an
 * install's check does, through checkStaged(), which runs none of its code.
 * The full generator judges it as every build does, through scanApps(), which
 * imports each route and reads what defineRoute() returned. Where the reader
 * can read a route, the two agree, rule and words: both refuse a bare handler,
 * a role the app does not declare and `raw: true` without its escape, and both
 * accept a good route. Where it cannot, it refuses nothing and says why, and
 * the generator decides at registration. Each of those fixtures hides a
 * problem the reader cannot see, which the generator then finds.
 */

import { after, describe, test, type TestContext } from "node:test";
import assert from "node:assert/strict";
import fs from "fs";
import os from "os";
import path from "path";
import type { AppManifest } from "../src/lib/apps/types";
import { checkStaged, scanApps } from "./generate-project-registry";
import { FatalManifestError } from "./manifest-errors";
import { bareHandlerProblem, rawResponseRefusal, undeclaredRoleProblems } from "./route-contracts";

// ── fixtures ────────────────────────────────────────────────────────────────

const ROOT = path.resolve(__dirname, "..");
const tmp = fs.realpathSync(fs.mkdtempSync(path.join(os.tmpdir(), "mixos-route-reader-")));
// The generator imports each fixture's routes, and a route imports `zod`,
// which Node finds by walking up from the file. The link goes before the
// folder does, so removing the folder never follows it.
fs.symlinkSync(path.join(ROOT, "node_modules"), path.join(tmp, "node_modules"), "dir");
after(() => {
  fs.unlinkSync(path.join(tmp, "node_modules"));
  fs.rmSync(tmp, { recursive: true, force: true });
});

let n = 0;

type Files = Record<string, string>;

function write(dir: string, files: Files): void {
  for (const [rel, contents] of Object.entries(files)) {
    fs.mkdirSync(path.dirname(path.join(dir, rel)), { recursive: true });
    fs.writeFileSync(path.join(dir, rel), contents);
  }
}

/** The app's folder, and so its `registryId`: a base and its id. */
const SLUG = "probe-3f9a2c1b";
const ITEMS = "api/items/route.ts";

/** The imports a route starts with. */
const HEAD = `import { z } from "zod";\nimport { defineRoute } from "@/lib/apps/route";\n`;
/** The rest of a JSON route's options. */
const JSON_ROUTE = `output: z.object({ ok: z.boolean() }), handler: async () => ({ ok: true })`;
/** The rest of a raw route's options. */
const RAW_ROUTE = `handler: async () => new Response("x")`;

/** `app.json`, declaring the role "viewer", and `fields`. */
function manifest(fields: Record<string, unknown> = {}): string {
  return JSON.stringify({ $schema: "https://mixos.org/schemas/app/v1.json", registryId: SLUG, name: "Probe", roles: [{ key: "viewer", label: "Viewer" }], ...fields });
}

/** An app whose `api/items/route.ts` is `route`, with any other files. */
function app(route: string, files: Files = {}, fields: Record<string, unknown> = {}): Files {
  return { "app.json": manifest(fields), [ITEMS]: route, ...files };
}

/** What an install's check makes of the app: it reads, and runs nothing. */
async function byReader(files: Files) {
  const dir = path.join(tmp, `stage-${n++}`, SLUG);
  write(dir, files);
  return checkStaged("app", dir, { apps: [], connectors: [] });
}

/** What a build makes of the same app: registered, refused outright (the run stops), or skipped. */
type Built = { registered: AppManifest } | { fatal: string } | { skipped: string };

async function byBuild(t: TestContext, files: Files): Promise<Built> {
  const apps = path.join(tmp, `apps-${n++}`);
  write(path.join(apps, SLUG), files);
  const warnings: string[] = [];
  t.mock.method(console, "log", () => {});
  t.mock.method(console, "warn", (line: unknown) => warnings.push(String(line)));
  let manifests: AppManifest[];
  try {
    manifests = await scanApps(apps, { emit: false });
  } catch (err) {
    if (err instanceof FatalManifestError) return { fatal: err.message };
    throw err;
  }
  const registered = manifests.find((m) => m.slug === SLUG);
  if (registered) return { registered };
  const prefix = `  Skipping ${SLUG}/ — `;
  const skip = warnings.find((w) => w.startsWith(prefix));
  assert.ok(skip, `neither registered nor skipped:\n${warnings.join("\n")}`);
  return { skipped: skip.slice(prefix.length) };
}

const bare = (method: string, routePath = "items") => bareHandlerProblem(SLUG, routePath, method);
const ghost = (method: string, role = "ghost") =>
  undeclaredRoleProblems(SLUG, "items", method, [role], [{ key: "viewer" }])[0];
const rawRefusal = (method = "GET") => rawResponseRefusal(SLUG, [{ routePath: "items", method }], [])!;
const deferred = (why: string, what = "its contract is") =>
  `apps/${SLUG}/${ITEMS}: ${why}, so ${what} checked at registration, which loads it.`;

// ── where the reader can read, the two agree ────────────────────────────────

describe("a bare handler is refused by both, in the build's words", () => {
  test("the words", () => {
    assert.equal(
      bare("GET"),
      `apps/${SLUG}/${ITEMS}: GET must be the result of defineRoute({...}). A bare handler declares no input, ` +
        `output, auth or roles, so the gateway cannot validate it, the build cannot check it, and the generated ` +
        `client cannot type it.`,
    );
  });

  const forms: [string, string][] = [
    ["a function", `export function GET() {\n  return new Response("x");\n}\n`],
    ["an async function", `export async function GET() {\n  return new Response("x");\n}\n`],
    [
      "a function with overloads",
      `export function GET(): Response;\nexport function GET(text?: string): Response {\n  return new Response(text);\n}\n`,
    ],
    ["an arrow function", `export const GET = async () => new Response("x");\n`],
    ["a function expression", `export const GET = function () {\n  return new Response("x");\n};\n`],
    ["a `let`", `export let GET = async () => new Response("x");\n`],
    ["a class", `export class GET {}\n`],
    ["a value that is not a route at all", `export const GET = "GET";\n`],
    [
      "a local function exported under the method's name",
      `async function handler() {\n  return new Response("x");\n}\nexport { handler as GET };\n`,
    ],
    ["a local function by another name", `const handler = async () => new Response("x");\nexport const GET = handler;\n`],
  ];
  for (const [form, route] of forms) {
    test(form, async (t) => {
      const files = app(route);
      assert.deepEqual(await byReader(files), { problems: [bare("GET")], deferred: [] });
      assert.deepEqual(await byBuild(t, files), { fatal: bare("GET") });
    });
  }

  test("each method on its own: a good GET beside a bare POST", async (t) => {
    const files = app(`${HEAD}export const GET = defineRoute({ ${JSON_ROUTE} });\nexport async function POST() {}\n`);
    assert.deepEqual(await byReader(files), { problems: [bare("POST")], deferred: [] });
    assert.deepEqual(await byBuild(t, files), { fatal: bare("POST") });
  });
});

describe("an undeclared role is refused by both, naming the role", () => {
  test("the words", () => {
    assert.equal(
      ghost("GET"),
      `apps/${SLUG}/${ITEMS}: GET requires role "ghost", which the app does not declare in \`roles\`. ` +
        `No user can ever hold it, so the route would 403 forever.`,
    );
  });

  test("beside a declared one", async (t) => {
    const files = app(`${HEAD}export const GET = defineRoute({ roles: ["viewer", "ghost"], ${JSON_ROUTE} });\n`);
    assert.deepEqual(await byReader(files), { problems: [ghost("GET")], deferred: [] });
    assert.deepEqual(await byBuild(t, files), { fatal: ghost("GET") });
  });

  test("in an app that declares no roles at all", async (t) => {
    const files = {
      "app.json": JSON.stringify({ $schema: "https://mixos.org/schemas/app/v1.json", registryId: SLUG, name: "Probe" }),
      [ITEMS]: `${HEAD}export const POST = defineRoute({ roles: ["admin"], ${JSON_ROUTE} });\n`,
    };
    const expected = undeclaredRoleProblems(SLUG, "items", "POST", ["admin"], []);
    assert.deepEqual(await byReader(files), { problems: expected, deferred: [] });
    assert.deepEqual(await byBuild(t, files), { fatal: expected[0] });
  });

  test("through `defineRoute` imported under another name", async (t) => {
    const files = app(
      `import { z } from "zod";\nimport { defineRoute as route } from "@/lib/apps/route";\n` +
        `export const GET = route({ roles: ["ghost"], ${JSON_ROUTE} });\n`,
    );
    assert.deepEqual(await byReader(files), { problems: [ghost("GET")], deferred: [] });
    assert.deepEqual(await byBuild(t, files), { fatal: ghost("GET") });
  });
});

describe("`raw: true` and its escape", () => {
  const route = `${HEAD}export const GET = defineRoute({ raw: true, ${RAW_ROUTE} });\n`;

  test("without the escape, refused by both: the build's line names the route, the verdict its file", async (t) => {
    const files = app(route);
    const { message, problems } = rawRefusal();
    assert.equal(
      message,
      `GET /items returns its own Response (\`raw: true\`), which needs { "rule": "raw-response", "reason": "…" } ` +
        `under \`escapes\` in app.json.`,
    );
    assert.deepEqual(problems, [
      `apps/${SLUG}/${ITEMS}: GET returns its own Response (\`raw: true\`), which needs ` +
        `{ "rule": "raw-response", "reason": "…" } under \`escapes\` in app.json.`,
    ]);
    assert.deepEqual(await byReader(files), { problems, deferred: [] });
    assert.deepEqual(await byBuild(t, files), { skipped: message });
  });

  test("with the escape, accepted by both", async (t) => {
    const files = app(route, {}, { escapes: [{ rule: "raw-response", reason: "Streams the report as a CSV download." }] });
    assert.deepEqual(await byReader(files), { problems: [], deferred: [] });
    const built = await byBuild(t, files);
    assert.ok("registered" in built, JSON.stringify(built));
    assert.equal(built.registered.routes[0].methods[0].raw, true);
  });

  test("`raw: false`, written out, needs no escape", async (t) => {
    const files = app(`${HEAD}export const GET = defineRoute({ raw: false, ${JSON_ROUTE} });\n`);
    assert.deepEqual(await byReader(files), { problems: [], deferred: [] });
    assert.ok("registered" in (await byBuild(t, files)));
  });
});

describe("a good route is accepted by both, with nothing left to registration", () => {
  test("two routes, three methods, roles declared, and a type that names the export", async (t) => {
    const files: Files = {
      "app.json": manifest({ roles: [{ key: "viewer", label: "Viewer" }, { key: "editor", label: "Editor" }] }),
      "api/index/route.ts": `${HEAD}export const GET = defineRoute({ summary: "Ping.", ${JSON_ROUTE} });\n`,
      [ITEMS]:
        HEAD +
        `export const GET = defineRoute({\n  auth: ["session"],\n  roles: ["viewer", "editor"],\n  ${JSON_ROUTE},\n});\n` +
        `export const POST = defineRoute({\n  roles: ["editor"] as const,\n  input: z.object({ name: z.string() }),\n` +
        `  budget: { connectorCalls: 0, ms: 5_000 },\n  ${JSON_ROUTE},\n} satisfies object);\n` +
        `export type Listed = typeof GET;\n`,
    };
    assert.deepEqual(await byReader(files), { problems: [], deferred: [] });
    const built = await byBuild(t, files);
    assert.ok("registered" in built, JSON.stringify(built));
    assert.deepEqual(
      built.registered.routes.map((r) => [r.path, r.methods.map((m) => [m.method, m.roles])]),
      [
        ["", [["GET", []]]],
        ["items", [["GET", ["viewer", "editor"]], ["POST", ["editor"]]]],
      ],
    );
  });
});

describe("where an app breaks more than one rule", () => {
  test("the build stops at the first, and it is the first the reader lists", async (t) => {
    const files = app(`${HEAD}export const GET = defineRoute({ roles: ["ghost"], raw: true, ${RAW_ROUTE} });\n`, {
      "api/zz/route.ts": `export async function DELETE() {}\n`,
    });
    const read = await byReader(files);
    assert.deepEqual(read.problems, [bare("DELETE", "zz"), ghost("GET"), ...rawRefusal().problems]);
    assert.deepEqual(await byBuild(t, files), { fatal: read.problems[0] });
  });
});

// ── where it cannot, it says why, and the build decides ─────────────────────

describe("what the reader cannot read is deferred with the reason, and the build finds what it hid", () => {
  // Each: the route (and any other files), the deferred line, and what the
  // build makes of it, which the reader could not have known.
  const cases: [string, Files, string, (t: TestContext) => Built][] = [
    [
      "options in a variable",
      app(`${HEAD}const options = { roles: ["ghost"], ${JSON_ROUTE} };\nexport const GET = defineRoute(options);\n`),
      deferred("GET's options are in a variable"),
      () => ({ fatal: ghost("GET") }),
    ],
    [
      "options with a spread",
      app(`${HEAD}const base = { roles: ["ghost"] };\nexport const GET = defineRoute({ ...base, ${JSON_ROUTE} });\n`),
      deferred("GET's options include a spread"),
      () => ({ fatal: ghost("GET") }),
    ],
    [
      "options from a function call",
      app(`${HEAD}function options() {\n  return { roles: ["ghost"], ${JSON_ROUTE} };\n}\nexport const GET = defineRoute(options());\n`),
      deferred("GET's options are built by a function call"),
      () => ({ fatal: ghost("GET") }),
    ],
    [
      "a computed key",
      app(`${HEAD}const key = "raw";\nexport const GET = defineRoute({ [key]: true, ${RAW_ROUTE} });\n`),
      deferred("GET's options have a computed key"),
      () => ({ skipped: rawRefusal().message }),
    ],
    [
      "a role that is not a string written out",
      app(`${HEAD}const GHOST = "ghost";\nexport const GET = defineRoute({ roles: ["viewer", GHOST], ${JSON_ROUTE} });\n`),
      deferred("GET's `roles` include an entry that is not a string written out", "its roles are"),
      () => ({ fatal: ghost("GET") }),
    ],
    [
      "roles in a variable",
      app(`${HEAD}const roles = ["ghost"];\nexport const GET = defineRoute({ roles, ${JSON_ROUTE} });\n`),
      deferred("GET's `roles` are in a variable", "its roles are"),
      () => ({ fatal: ghost("GET") }),
    ],
    [
      "`raw` in a variable",
      app(`${HEAD}const raw = true as const;\nexport const GET = defineRoute({ raw, ${RAW_ROUTE} });\n`),
      deferred("GET's `raw` is in a variable", "whether it returns its own Response is"),
      () => ({ skipped: rawRefusal().message }),
    ],
    [
      "options imported from another file",
      app(`${HEAD}import { options } from "../../lib/options";\nexport const GET = defineRoute(options);\n`, {
        "lib/options.ts": `export const options = { raw: true as const, ${RAW_ROUTE} };\n`,
      }),
      deferred("GET's options are imported from another file"),
      () => ({ skipped: rawRefusal().message }),
    ],
    [
      "a method re-exported from another file, which is a bare handler",
      app(`export { GET } from "../../lib/handlers";\n`, {
        "lib/handlers.ts": `export async function GET() {\n  return new Response("x");\n}\n`,
      }),
      deferred("GET is re-exported from another file"),
      () => ({ fatal: bare("GET") }),
    ],
    [
      "everything re-exported from another file",
      app(`export * from "../../lib/handlers";\n`, {
        "lib/handlers.ts": `export async function POST() {\n  return new Response("x");\n}\n`,
      }),
      deferred("it re-exports everything from another file", "any method that file adds is"),
      () => ({ fatal: bare("POST") }),
    ],
    [
      "a method built by a call to something other than defineRoute",
      app(`const wrap = <T,>(handler: T) => handler;\nexport const GET = wrap(async () => new Response("x"));\n`),
      deferred("GET is built by a call to something other than defineRoute"),
      () => ({ fatal: bare("GET") }),
    ],
    [
      "a defineRoute of the app's own",
      app(`import { z } from "zod";\nconst defineRoute = (options: object) => options;\nexport const GET = defineRoute({ ${JSON_ROUTE} });\n`),
      deferred("GET calls a defineRoute that is not the one from @/lib/apps/route"),
      () => ({ fatal: bare("GET") }),
    ],
    [
      "an export the file changes after defining it",
      app(`${HEAD}export const GET = defineRoute({ roles: ["viewer"], ${JSON_ROUTE} });\nGET.roles.push("ghost");\n`),
      deferred("GET is used elsewhere in the file, where code could change it"),
      () => ({ fatal: ghost("GET") }),
    ],
    [
      "CommonJS exports",
      app(`exports.GET = async () => new Response("x");\n`),
      deferred("it uses CommonJS `exports`"),
      () => ({ fatal: bare("GET") }),
    ],
  ];
  for (const [what, files, line, expected] of cases) {
    test(what, async (t) => {
      assert.deepEqual(await byReader(files), { problems: [], deferred: [line] });
      assert.deepEqual(await byBuild(t, files), expected(t));
    });
  }

  // The reader defers options that set their prototype, but none reaches it
  // now: the scan refuses `__proto__` in app code first (app-containment.ts).
  test("options that set their prototype are refused by the scan, before the reader", async (t) => {
    const files = app(`${HEAD}export const GET = defineRoute({ __proto__: { raw: true }, ${RAW_ROUTE} } as never);\n`);
    const read = await byReader(files);
    assert.deepEqual(read.deferred, []);
    assert.match(read.problems.join("\n"), /__proto__ reaches an object's constructor or prototype/);
    const built = await byBuild(t, files);
    assert.ok("skipped" in built && /__proto__ reaches/.test(String(built.skipped)), JSON.stringify(built));
  });

  test("a method re-exported from another file may be a good route, which the build accepts", async (t) => {
    const files = app(`export { GET } from "../../lib/handlers";\n`, {
      "lib/handlers.ts": `${HEAD}export const GET = defineRoute({ ${JSON_ROUTE} });\n`,
    });
    assert.deepEqual(await byReader(files), { problems: [], deferred: [deferred("GET is re-exported from another file")] });
    assert.ok("registered" in (await byBuild(t, files)));
  });

  test("what it can read beside what it cannot: `raw` read and refused, `roles` left", async (t) => {
    const files = app(`${HEAD}const roles = ["viewer"];\nexport const GET = defineRoute({ roles, raw: true, ${RAW_ROUTE} });\n`);
    assert.deepEqual(await byReader(files), {
      problems: rawRefusal().problems,
      deferred: [deferred("GET's `roles` are in a variable", "its roles are")],
    });
    assert.deepEqual(await byBuild(t, files), { skipped: rawRefusal().message });
  });
});

// ── it imports nothing ──────────────────────────────────────────────────────

describe("the reader imports nothing", () => {
  type Marked = typeof globalThis & { mixosRouteFixtureLoads?: string[] };
  const loads = () => (globalThis as Marked).mixosRouteFixtureLoads;

  test("a route that records its own import is read, refused, and never loaded; the build loads it", async (t) => {
    const files = app(
      `${HEAD}import { mark } from "../../lib/mark";\nmark("${ITEMS}");\n` +
        `export const GET = defineRoute({ roles: ["ghost"], ${JSON_ROUTE} });\n`,
      {
        "lib/mark.ts":
          `const loads = ((globalThis as { mixosRouteFixtureLoads?: string[] }).mixosRouteFixtureLoads ??= []);\n` +
          `loads.push("lib/mark.ts");\nexport function mark(file: string): void {\n  loads.push(file);\n}\n`,
      },
    );
    assert.equal(loads(), undefined);

    assert.deepEqual(await byReader(files), { problems: [ghost("GET")], deferred: [] });
    assert.equal(loads(), undefined, "the reader loaded the route or what it imports");

    // It does record its import: the build loads it, and refuses it the same way.
    assert.deepEqual(await byBuild(t, files), { fatal: ghost("GET") });
    assert.deepEqual(loads(), ["lib/mark.ts", ITEMS]);
  });
});
