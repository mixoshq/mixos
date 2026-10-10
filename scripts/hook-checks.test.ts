/* This Source Code Form is subject to the terms of the Mozilla Public
 * License, v. 2.0. If a copy of the MPL was not distributed with this
 * file, You can obtain one at https://mozilla.org/MPL/2.0/. */

import { after, test } from "node:test";
import assert from "node:assert/strict";
import fs from "fs";
import os from "os";
import path from "path";
import {
  checkHookNamespaces,
  formatHookFindings,
  scanHooks,
  validateHookWiring,
  type HookFinding,
} from "./hook-checks";
import { FatalManifestError } from "./manifest-errors";
import type { HookEmit, HookListen } from "../src/lib/apps/types";

// ── fixtures ────────────────────────────────────────────────────────────────

const root = fs.mkdtempSync(path.join(os.tmpdir(), "mixos-hook-checks-"));
after(() => fs.rmSync(root, { recursive: true, force: true }));

let n = 0;

/** An app directory holding `files`, relative path → contents. */
function fixture(files: Record<string, string>): string {
  const dir = path.join(root, `app-${n++}`);
  for (const [rel, contents] of Object.entries(files)) {
    fs.mkdirSync(path.dirname(path.join(dir, rel)), { recursive: true });
    fs.writeFileSync(path.join(dir, rel), contents);
  }
  fs.mkdirSync(dir, { recursive: true });
  return dir;
}

/** Scan an app and run the per-app check, as the generator does. */
function check(slug: string, files: Record<string, string>, listensTo: HookListen[] = []) {
  const scan = scanHooks(fixture(files), slug);
  return { scan, findings: checkHookNamespaces(slug, scan.calls, listensTo) };
}

/** Each finding as `file:line why`, the way the skip message prints it. */
const lines = (findings: HookFinding[]) => findings.map((f) => `${f.file}:${f.line} ${f.why}`);

const fatal = (pattern: RegExp) => (err: unknown) =>
  err instanceof FatalManifestError && pattern.test(err.message);

const entrypoint = (body: string) =>
  `export default function register(hooks) {\n${body}\n}\n`;

// ── listening (RB-15) ───────────────────────────────────────────────────────

test("listening to another app's hook without listensTo is a finding, naming file and line", () => {
  const { findings } = check("reporting", {
    "hooks.ts": entrypoint(`  hooks.addAction("sales:deal-won", (deal) => deal);`),
  });
  assert.equal(findings.length, 1);
  assert.match(
    lines(findings)[0],
    /^hooks\.ts:2 listens to "sales:deal-won", a hook of "sales", without declaring it\. Add \{ "app": "sales", "hook": "deal-won" \}/,
  );
});

test("an undeclared filter on another app's hook is one too, wherever it is registered", () => {
  const { findings } = check("reporting", {
    "api/items/route.ts": `export const x = (context) => context.hooks.addFilter("sales:price", (v) => v);\n`,
  });
  assert.deepEqual(
    lines(findings).map((l) => l.split(" without")[0]),
    ['api/items/route.ts:1 listens to "sales:price", a hook of "sales",'],
  );
});

test("a declared listener has no finding", () => {
  const { scan, findings } = check(
    "reporting",
    { "hooks.ts": entrypoint(`  hooks.addAction("sales:deal-won", () => {});`) },
    [{ app: "sales", hook: "deal-won" }],
  );
  assert.deepEqual(findings, []);
  assert.deepEqual(scan.listens.actions, ["sales:deal-won"]);
});

test("an app's own hooks and core hooks need no declaration", () => {
  const { scan, findings } = check("crm", {
    "hooks.ts": entrypoint(
      [
        `  hooks.addAction("ready", () => {});`,
        `  hooks.addAction("crm:ready", () => {});`,
        `  hooks.addFilter("user-display-name", (n) => n);`,
        `  hooks.addFilter("brand-name", () => "Acme");`,
      ].join("\n"),
    ),
    "api/items/route.ts": `export const x = (c) => c.hooks.doAction("ready");\n`,
  });
  assert.deepEqual(findings, []);
  assert.deepEqual(scan.listens.actions, ["crm:ready"]);
  assert.deepEqual(scan.listens.filters, ["brand-name", "user-display-name"]);
  assert.deepEqual(scan.emits.actions, ["crm:ready"]);
});

// ── firing (RB-16) ──────────────────────────────────────────────────────────

test("firing another app's hook is a finding, declared or not", () => {
  const files = {
    "api/items/route.ts": [
      `export const handler = async (context) => {`,
      `  await context.hooks.doAction("sales:deal-won", { id: 1 });`,
      `};`,
    ].join("\n"),
  };
  const expected = /^api\/items\/route\.ts:2 fires "sales:deal-won", a hook of "sales"/;
  assert.match(lines(check("forger", files).findings)[0], expected);
  // listensTo is consent to LISTEN; it never makes another app's hook yours to fire.
  assert.match(
    lines(check("forger", files, [{ app: "sales", hook: "deal-won" }]).findings)[0],
    expected,
  );
});

test("an applyFilters on another app's hook is one too", () => {
  const { findings } = check("forger", { "lib/x.ts": `hooks.applyFilters("sales:price", 10);\n` });
  assert.match(lines(findings)[0], /^lib\/x\.ts:1 fires "sales:price"/);
});

test("every finding in an app is reported, one line each, for the skip message", () => {
  const { findings } = check("forger", {
    "hooks.ts": entrypoint(
      [
        `  hooks.addAction("sales:deal-won", () => {});`,
        `  hooks.addFilter("billing:invoice", (v) => v);`,
      ].join("\n"),
    ),
    "lib/x.ts": `hooks.doAction("sales:deal-won");\n`,
  });
  assert.equal(findings.length, 3);
  const text = formatHookFindings(findings);
  assert.equal(text.split("\n").length, 4);
  assert.match(text, /\n {6}hooks\.ts:2 — listens to "sales:deal-won"/);
  assert.match(text, /\n {6}hooks\.ts:3 — listens to "billing:invoice"/);
  assert.match(text, /\n {6}lib\/x\.ts:1 — fires "sales:deal-won"/);
});

// ── what the scan reads ─────────────────────────────────────────────────────

test("a call in a comment or a string is not a call", () => {
  const { scan } = check("crm", {
    "lib/notes.ts": [
      `// Before listensTo existed, this was: hooks.addAction("sales:deal-won", fn)`,
      `/* hooks.doAction("sales:deal-won") */`,
      `export const example = 'hooks.addAction("sales:deal-won", fn)';`,
    ].join("\n"),
  });
  assert.deepEqual(scan.calls, []);
});

test("a name built at runtime is counted, and left to the registrar to check", () => {
  const { scan } = check("crm", {
    "lib/fire.ts": [
      "export async function fire(hooks, app, kind) {",
      "  await hooks.doAction(`${app}:changed`);",
      '  await hooks.doAction("item-" + kind);',
      "  hooks.addAction(`${app}:changed`, () => {});",
      "}",
    ].join("\n"),
  });
  assert.equal(scan.counts.actions, 2);
  assert.deepEqual(scan.calls, []);
});

test("calls inside JSX are read, in .tsx and .jsx alike", () => {
  const widget = (ext: string) => ({
    [`widgets/panel.${ext}`]: [
      `export default function Panel({ hooks }) {`,
      `  return <span onClick={() => hooks.doAction("sales:deal-won")}>Won</span>;`,
      `}`,
    ].join("\n"),
  });
  for (const ext of ["tsx", "jsx"]) {
    assert.match(
      lines(check("forger", widget(ext)).findings)[0],
      new RegExp(`^widgets/panel\\.${ext}:2 fires "sales:deal-won"`),
    );
  }
});

test("a template literal with no substitution is a literal name", () => {
  const { findings } = check("crm", {
    "hooks.ts": entrypoint("  hooks.addAction(`sales:deal-won`, () => {});"),
  });
  assert.match(lines(findings)[0], /listens to "sales:deal-won"/);
});

// ── both halves (validateHookWiring, still fatal) ───────────────────────────

function app(slug: string, emits: HookEmit[] = [], listensTo: HookListen[] = []) {
  return { slug, emits, listensTo };
}

test("a declared listener the emitter does not allow fails the build", () => {
  assert.throws(
    () =>
      validateHookWiring([
        app("sales", [{ name: "deal-won", consumers: ["finance"] }]),
        app("reporting", [], [{ app: "sales", hook: "deal-won" }]),
      ]),
    fatal(/apps\/sales does not allow "reporting" to listen to "deal-won"/),
  );
});

test("a declared listener the emitter allows, by name or by \"*\", passes", () => {
  validateHookWiring([
    app("sales", [
      { name: "deal-won", consumers: ["reporting"] },
      { name: "deal-lost", consumers: "*" },
    ]),
    app("reporting", [], [
      { app: "sales", hook: "deal-won" },
      { app: "sales", hook: "deal-lost" },
    ]),
  ]);
});
