/* This Source Code Form is subject to the terms of the Mozilla Public
 * License, v. 2.0. If a copy of the MPL was not distributed with this
 * file, You can obtain one at https://mozilla.org/MPL/2.0/. */

/**
 * scripts/rename.ts and the rename ledger (scripts/extension-renames.ts): what a
 * rename moves and rewrites in a checkout, what it leaves for a person, what it
 * refuses, and what the generator holds the ledger to. What the release step
 * then moves in a database is scripts/sync-renames.integration.test.ts.
 */

import { after, describe, test } from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { compareSlugs, hasSlugId, splitSlug } from "../src/lib/extensions/slug-id";
import { RENAMES_FILE, readRenames, renameProblems, type ExtensionRename } from "./extension-renames";
import { RenameError, renameExtension } from "./rename";

const tmp = fs.mkdtempSync(path.join(os.tmpdir(), "mixos-rename-"));
after(() => fs.rmSync(tmp, { recursive: true, force: true }));
let n = 0;

const APP = "https://mixos.org/schemas/app/v1.json";

/** A checkout holding `files`, by path. */
function checkout(files: Record<string, string>): string {
  const root = path.join(tmp, `checkout-${n++}`);
  for (const [rel, text] of Object.entries(files)) {
    fs.mkdirSync(path.dirname(path.join(root, rel)), { recursive: true });
    fs.writeFileSync(path.join(root, rel), text);
  }
  return root;
}

const json = (v: unknown) => `${JSON.stringify(v, null, 2)}\n`;
const read = (root: string, rel: string) => fs.readFileSync(path.join(root, rel), "utf-8");

describe("slug ids", () => {
  test("a slug ends in an id only when its last part is eight hex characters", () => {
    assert.deepEqual(splitSlug("wall-e-3f9a2c1b"), { base: "wall-e", id: "3f9a2c1b" });
    assert.equal(hasSlugId("wall-e"), false);
    assert.equal(hasSlugId("wall-e-3f9a2c1"), false);
    assert.equal(hasSlugId("3f9a2c1b"), false);
  });

  test("themes sort by name before id, so the first doesn't depend on the id drawn", () => {
    for (const id of ["00000000", "ffffffff", "d0000000"]) {
      assert.ok(compareSlugs(`mixos-${id}`, "mixos-dark-11111111") < 0, id);
    }
  });
});

describe("renaming an app", () => {
  const root = checkout({
    "apps/wall-e/app.json": json({ $schema: APP, name: "Wall·E" }),
    "apps/wall-e/pages/Main.tsx": [
      'import { callAppRoute } from "@/lib/apps/call";',
      'import { pick } from "@apps/wall-e/lib/pick";',
      "// callAppRoute(\"wall-e\") in a comment is rewritten too: it is the same name",
      'export default async () => callAppRoute("wall-e", "GET /quote", {});',
      "",
    ].join("\n"),
    "apps/wall-e/widgets/quote.tsx": 'const c = createAppClient<"wall-e">(appSlug);\n',
    "apps/digest/app.json": json({
      $schema: APP,
      name: "Digest",
      consumes: [{ app: "wall-e", service: "quotes" }],
      listensTo: [{ app: "wall-e", hook: "quoted" }],
      remixedFrom: [{ app: "wall-e", commit: null }],
    }),
    "apps/digest/api/today/route.ts": 'await context.services.request("wall-e", "quotes", {});\n',
    "src/lib/screenshots.ts": 'const shot = "/screenshots/apps/wall-e/quote.png";\n',
  });
  const report = renameExtension({ root, kind: "app", slug: "wall-e", today: "2026-11-10" });

  test("moves the folder to the slug with a new id", () => {
    assert.match(report.to, /^wall-e-[0-9a-f]{8}$/);
    assert.equal(fs.existsSync(path.join(root, "apps/wall-e")), false);
    assert.ok(fs.existsSync(path.join(root, "apps", report.to, "app.json")));
  });

  test("gives its manifest the new slug as its registryId, right after $schema", () => {
    const manifest = JSON.parse(read(root, `apps/${report.to}/app.json`));
    assert.equal(manifest.registryId, report.to);
    assert.deepEqual(Object.keys(manifest), ["$schema", "registryId", "name"]);
  });

  test("rewrites the app's own slug in its code", () => {
    const page = read(root, `apps/${report.to}/pages/Main.tsx`);
    assert.match(page, new RegExp(`callAppRoute\\("${report.to}", "GET /quote"`));
    assert.match(page, new RegExp(`"@apps/${report.to}/lib/pick"`));
    assert.match(read(root, `apps/${report.to}/widgets/quote.tsx`), new RegExp(`createAppClient<"${report.to}">`));
  });

  test("rewrites what other apps name it by, and never their remixedFrom", () => {
    const digest = JSON.parse(read(root, "apps/digest/app.json"));
    assert.equal(digest.consumes[0].app, report.to);
    assert.equal(digest.listensTo[0].app, report.to);
    assert.equal(digest.remixedFrom[0].app, "wall-e");
    assert.match(read(root, "apps/digest/api/today/route.ts"), new RegExp(`request\\("${report.to}"`));
  });

  test("lists what it leaves for a person", () => {
    assert.deepEqual(
      report.leftovers.map((l) => `${l.file}:${l.line}`),
      ["apps/digest/app.json:18", "src/lib/screenshots.ts:1"],
    );
  });

  test("records the rename in the ledger", () => {
    assert.deepEqual(readRenames(root), [{ kind: "app", from: "wall-e", to: report.to, date: "2026-11-10" }]);
  });
});

describe("renaming a connector", () => {
  const root = checkout({
    "connectors/crm/connector.json": json({ $schema: "https://mixos.org/schemas/connector/v1.json", displayName: "CRM" }),
    "apps/ledger/app.json": json({
      $schema: APP,
      name: "Ledger",
      connectors: [{ name: "crm", version: "1.0.0" }],
      mcp: [{ name: "totals", sources: ["crm", "mixos"] }],
    }),
    "apps/ledger/lib/server/deals.ts": "const a = context.connectors.crm;\nconst b = context.connectors['crm'];\n",
  });
  const report = renameExtension({ root, kind: "connector", slug: "crm", to: "crm-0000beef", today: "2026-11-10" });

  test("takes the slug it is given, and its registryId follows", () => {
    assert.equal(report.to, "crm-0000beef");
    assert.equal(JSON.parse(read(root, "connectors/crm-0000beef/connector.json")).registryId, "crm-0000beef");
  });

  test("the apps that use it name it by its new name, in their manifests and their code", () => {
    const ledger = JSON.parse(read(root, "apps/ledger/app.json"));
    assert.equal(ledger.connectors[0].name, "crm-0000beef");
    assert.deepEqual(ledger.mcp[0].sources, ["crm-0000beef", "mixos"]);
    assert.equal(
      read(root, "apps/ledger/lib/server/deals.ts"),
      'const a = context.connectors["crm-0000beef"];\nconst b = context.connectors[\'crm-0000beef\'];\n',
    );
  });
});

describe("what a rename refuses, having changed nothing", () => {
  const record = json({ $schema: "https://mixos.org/schemas/registry-install/v1.json" });
  const root = checkout({
    "apps/installed/app.json": json({ $schema: APP, name: "Installed" }),
    "apps/installed/.registry.json": record,
    "apps/wall-e-3f9a2c1b/app.json": json({ $schema: APP, name: "Has an id" }),
    "themes/dusk/theme.json": json({ name: "Dusk" }),
    "themes/dusk-11111111/theme.json": json({ name: "Taken" }),
  });
  const refuses = (opts: Parameters<typeof renameExtension>[0], pattern: RegExp) =>
    assert.throws(() => renameExtension(opts), (err: unknown) => err instanceof RenameError && pattern.test(err.message));

  test("an extension installed from a Registry", () => {
    refuses({ root, kind: "app", slug: "installed" }, /installed from a Registry: its slug is its publisher's/);
  });
  test("a slug that has an id already, unless --to says what to", () => {
    refuses({ root, kind: "app", slug: "wall-e-3f9a2c1b" }, /already ends in an id\. Pass --to/);
  });
  test("a new slug without an id, or one that is taken", () => {
    refuses({ root, kind: "theme", slug: "dusk", to: "dusk-two" }, /doesn't end in an id/);
    refuses({ root, kind: "theme", slug: "dusk", to: "dusk-11111111" }, /themes\/dusk-11111111 already exists/);
    refuses({ root, kind: "theme", slug: "Dusk_2-11111111".toLowerCase() }, /There is no/);
  });
  test("templates, and folders that aren't there", () => {
    refuses({ root, kind: "app", slug: "_template" }, /template or set aside/);
    refuses({ root, kind: "connector", slug: "nope" }, /There is no connectors\/nope/);
  });
  test("left everything as it was", () => {
    assert.ok(fs.existsSync(path.join(root, "themes/dusk/theme.json")));
    assert.equal(fs.existsSync(path.join(root, RENAMES_FILE)), false);
  });
});

describe("a dry run", () => {
  test("says what it would do and changes nothing", () => {
    const root = checkout({ "themes/dusk/theme.json": json({ name: "Dusk" }) });
    const report = renameExtension({ root, kind: "theme", slug: "dusk", dryRun: true });
    assert.match(report.to, /^dusk-[0-9a-f]{8}$/);
    assert.ok(fs.existsSync(path.join(root, "themes/dusk")));
    assert.equal(fs.existsSync(path.join(root, RENAMES_FILE)), false);
  });
});

describe("the ledger, against the build", () => {
  const entry = (from: string, to: string, kind: ExtensionRename["kind"] = "theme"): ExtensionRename => ({
    kind,
    from,
    to,
    date: "2026-11-10",
  });
  const build = { app: ["wall-e-3f9a2c1b"], connector: [], theme: ["mixos-3f9a2c1b", "dusk-22222222"] };

  test("a rename to an extension in the build, from one that isn't, is fine", () => {
    assert.deepEqual(renameProblems([entry("mixos", "mixos-3f9a2c1b"), entry("wall-e", "wall-e-3f9a2c1b", "app")], build), []);
  });

  test("a chain is followed in order, and needs its end in the build", () => {
    assert.deepEqual(renameProblems([entry("dusk", "dusk-11111111"), entry("dusk-11111111", "dusk-22222222")], build), []);
    assert.match(renameProblems([entry("dusk", "dusk-11111111")], build).join("\n"), /carries no theme dusk-11111111/);
  });

  test("a slug renamed twice, kept in the build, or renamed to itself is refused", () => {
    const problems = renameProblems(
      [
        entry("mixos", "mixos-3f9a2c1b"),
        entry("mixos", "dusk-22222222"),
        entry("dusk-22222222", "mixos-3f9a2c1b"),
        entry("mixos-3f9a2c1b", "mixos-3f9a2c1b"),
      ],
      build,
    ).join("\n");
    assert.match(problems, /mixos is renamed twice/);
    assert.match(problems, /still carries theme dusk-22222222/);
    assert.match(problems, /renames a slug to itself/);
  });

  test("a name that isn't a slug of its kind is refused", () => {
    assert.match(renameProblems([entry("Mixos", "mixos-3f9a2c1b")], build).join("\n"), /"Mixos" is not a theme slug/);
  });
});
