/* This Source Code Form is subject to the terms of the Mozilla Public
 * License, v. 2.0. If a copy of the MPL was not distributed with this
 * file, You can obtain one at https://mozilla.org/MPL/2.0/. */

/**
 * `registryId` (src/lib/extensions/slug-id.ts) and `npm run new`
 * (scripts/new-extension.ts): an extension created from each real template
 * has a minted id, a folder named after it, a manifest the schema accepts, and
 * no reference left to the template's own name.
 */

import { after, describe, test } from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import {
  PLACEHOLDER_SLUG_ID,
  REGISTRY_ID_PATTERN,
  registryIdProblem,
  splitSlug,
  withRegistryId,
} from "../src/lib/extensions/slug-id";
import { RawAppManifestSchema, RawConnectorManifestSchema, RawThemeManifestSchema } from "./manifest-schemas";
import { NewExtensionError, createExtension } from "./new-extension";
import { scanApps } from "./generate-project-registry";
import { FatalManifestError } from "./manifest-errors";

const REPO = path.resolve(__dirname, "..");
const tmp = fs.mkdtempSync(path.join(os.tmpdir(), "mixos-new-"));
after(() => fs.rmSync(tmp, { recursive: true, force: true }));
let n = 0;

/** A checkout holding this repository's templates, as they are. */
function checkout(): string {
  const root = path.join(tmp, `checkout-${n++}`);
  for (const rel of ["apps/_template", "connectors/_template", "connectors/_template-oauth", "themes/_template"]) {
    fs.cpSync(path.join(REPO, rel), path.join(root, rel), { recursive: true });
  }
  return root;
}

const read = (root: string, rel: string) => fs.readFileSync(path.join(root, rel), "utf-8");

/** Every file's text under `dir`. */
function texts(dir: string): string[] {
  return fs
    .readdirSync(dir, { recursive: true, withFileTypes: true })
    .filter((e) => e.isFile())
    .map((e) => fs.readFileSync(path.join(e.parentPath, e.name), "utf-8"));
}

describe("registryId", () => {
  test("is a name, a hyphen and an eight-character hex id", () => {
    assert.ok(REGISTRY_ID_PATTERN.test("sales-tracker-3f9a2c1b"));
    for (const bad of ["sales-tracker", "sales_tracker-3f9a2c1b", "Sales-3f9a2c1b", "sales-3F9A2C1B", "3f9a2c1b", "sales--3f9a2c1b"]) {
      assert.ok(!REGISTRY_ID_PATTERN.test(bad), bad);
    }
  });

  test("names the folder it is in, and nothing else", () => {
    assert.equal(registryIdProblem("app", "app.json", "careers-83462f9f", "careers-83462f9f"), null);
    assert.match(
      registryIdProblem("app", "apps/careers-baa28a1b/app.json", "careers-83462f9f", "careers-baa28a1b") ?? "",
      /"registryId" is "careers-83462f9f", but its folder is apps\/careers-baa28a1b.*npm run rename -- app\/careers-baa28a1b/,
    );
  });

  test("the templates' placeholder id is never an extension's", () => {
    const placeholder = `acme-${PLACEHOLDER_SLUG_ID}`;
    assert.match(registryIdProblem("theme", "theme.json", placeholder, placeholder) ?? "", /placeholder.*npm run new -- theme/);
  });

  test("is written right after $schema, every other key in place", () => {
    assert.deepEqual(
      Object.keys(withRegistryId({ $schema: "s", name: "Acme", registryId: "old-00000000", icon: "box" }, "acme-3f9a2c1b")),
      ["$schema", "registryId", "name", "icon"],
    );
    assert.deepEqual(Object.keys(withRegistryId({ name: "Acme" }, "acme-3f9a2c1b")), ["registryId", "name"]);
  });
});

describe("npm run new", () => {
  const SCHEMA = { app: RawAppManifestSchema, connector: RawConnectorManifestSchema, theme: RawThemeManifestSchema };
  const FILE = { app: "app.json", connector: "connector.json", theme: "theme.json" };

  for (const [kind, oauth] of [
    ["app", false],
    ["connector", false],
    ["connector", true],
    ["theme", false],
  ] as const) {
    test(`makes ${kind === "app" ? "an" : "a"} ${kind}${oauth ? " from the OAuth template" : ""}, named after its minted id`, () => {
      const root = checkout();
      const made = createExtension({ root, kind, base: "acme", oauth });
      assert.equal(splitSlug(made.registryId)?.base, "acme");
      assert.notEqual(splitSlug(made.registryId)?.id, PLACEHOLDER_SLUG_ID);
      assert.equal(path.basename(made.dir), made.registryId);

      const manifest = JSON.parse(fs.readFileSync(path.join(root, made.dir, FILE[kind]), "utf-8"));
      assert.equal(manifest.registryId, made.registryId);
      assert.equal(Object.keys(manifest)[1], "registryId", "right after $schema");
      const parsed = SCHEMA[kind].safeParse(manifest);
      assert.ok(parsed.success, JSON.stringify(!parsed.success && parsed.error.issues));
      assert.equal(registryIdProblem(kind, FILE[kind], manifest.registryId, path.basename(made.dir)), null);

      const template = oauth ? "_template-oauth" : "_template";
      for (const text of texts(path.join(root, made.dir))) {
        assert.ok(!text.includes(`"${template}"`), `still names "${template}"`);
        assert.ok(!text.includes(`/api/apps/${template}/`), `still routes to /api/apps/${template}/`);
      }
    });
  }

  test("an app's own route calls name the new app", () => {
    const root = checkout();
    const made = createExtension({ root, kind: "app", base: "acme", registryId: "acme-3f9a2c1b" });
    const main = fs.readFileSync(path.join(root, made.dir, "pages/Main.tsx"), "utf-8");
    assert.match(main, /callAppRoute<[^>]*>\(\s*"acme-3f9a2c1b"/);
  });

  test("--plan mints the id and makes only plans/; building that folder later keeps the plan", () => {
    const root = checkout();
    const planned = createExtension({ root, kind: "app", base: "acme", plan: true });
    assert.deepEqual(fs.readdirSync(path.join(root, planned.dir)), ["plans"]);
    fs.writeFileSync(path.join(root, planned.dir, "plans", "20261114_1000-acme.md"), "# The plan\n");

    const built = createExtension({ root, kind: "app", base: planned.registryId });
    assert.equal(built.registryId, planned.registryId);
    assert.equal(read(root, `${built.dir}/plans/20261114_1000-acme.md`), "# The plan\n");
    assert.equal(JSON.parse(read(root, `${built.dir}/app.json`)).registryId, planned.registryId);
  });

  test("refuses a bad name, an existing folder, a planned folder that is built or missing, and --oauth off a connector", () => {
    const root = checkout();
    createExtension({ root, kind: "app", base: "acme", registryId: "acme-3f9a2c1b" });
    const refused = (opts: Parameters<typeof createExtension>[0], message: RegExp) =>
      assert.throws(() => createExtension(opts), (err: unknown) => err instanceof NewExtensionError && message.test(err.message));
    refused({ root, kind: "app", base: "acme", registryId: "acme-3f9a2c1b" }, /already exists/);
    refused({ root, kind: "app", base: "acme-3f9a2c1b" }, /already holds more than a plan/);
    refused({ root, kind: "app", base: "acme-11111111" }, /There is no apps\/acme-11111111 to build/);
    refused({ root, kind: "app", base: "acme-3f9a2c1b", plan: true }, /--plan mints it/);
    refused({ root, kind: "app", base: "Acme Tasks" }, /lowercase letters, digits and single hyphens/);
    refused({ root, kind: "app", base: "a".repeat(40) }, /at most 39 characters/);
    refused({ root, kind: "theme", base: "dusk", oauth: true }, /only connectors/);
  });
});

describe("the build", () => {
  test("refuses an app whose folder was renamed by hand, by its name rather than by what its code calls", async () => {
    const root = checkout();
    const made = createExtension({ root, kind: "app", base: "acme", registryId: "acme-3f9a2c1b" });
    fs.renameSync(path.join(root, made.dir), path.join(root, "apps", "acme-11111111"));
    await assert.rejects(
      scanApps(path.join(root, "apps"), { emit: false }),
      (err: unknown) =>
        err instanceof FatalManifestError &&
        /^apps\/acme-11111111\/app\.json "registryId" is "acme-3f9a2c1b", but its folder is apps\/acme-11111111\./.test(err.message),
    );
  });
});
