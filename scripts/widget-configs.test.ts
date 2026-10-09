/* This Source Code Form is subject to the terms of the Mozilla Public
 * License, v. 2.0. If a copy of the MPL was not distributed with this
 * file, You can obtain one at https://mozilla.org/MPL/2.0/. */

import { after, test } from "node:test";
import assert from "node:assert/strict";
import fs from "fs";
import os from "os";
import path from "path";
import { FatalManifestError } from "./manifest-errors";
import { applyWidgetConfigs } from "./widget-configs";

// ── fixtures ────────────────────────────────────────────────────────────────

const root = fs.mkdtempSync(path.join(os.tmpdir(), "mixos-widget-configs-"));
after(() => fs.rmSync(root, { recursive: true, force: true }));

let n = 0;

/** An app directory named `acme-<n>` holding `widgets.ts`, when one is given. */
function appDir(widgetsTs?: string): string {
  const dir = path.join(root, `acme-${n++}`);
  fs.mkdirSync(dir, { recursive: true });
  if (widgetsTs !== undefined) fs.writeFileSync(path.join(dir, "widgets.ts"), widgetsTs);
  return dir;
}

const titleField = { key: "title", label: "Title", type: "text", required: true, default: "" };

const exportsConfigFor = (component: string) =>
  `export default { ${JSON.stringify(component)}: [${JSON.stringify(titleField)}] };\n`;

const manifest = (config?: unknown[]) => ({
  name: "Acme",
  widgets: [
    {
      name: "Favorites",
      description: "Links you keep coming back to",
      component: "widgets/favorites.tsx",
      ...(config ? { config } : {}),
    },
  ],
});

/** Asserts `promise` rejects with a FatalManifestError whose message matches. */
async function rejectsFatally(promise: Promise<unknown>, message: RegExp) {
  await assert.rejects(
    promise,
    (err: Error) => err instanceof FatalManifestError && message.test(err.message),
  );
}

// ── merging ─────────────────────────────────────────────────────────────────

test("config from widgets.ts lands on the widget it names", async () => {
  const m = manifest();
  await applyWidgetConfigs(appDir(exportsConfigFor("widgets/favorites.tsx")), m);
  assert.deepEqual(m.widgets[0], { ...manifest().widgets[0], config: [titleField] });
});

test("an app without widgets.ts is left as it is", async () => {
  const m = manifest([titleField]);
  await applyWidgetConfigs(appDir(), m);
  assert.deepEqual(m, manifest([titleField]));
});

// ── drift fails the build ───────────────────────────────────────────────────

test("a widgets.ts key that names no widget fails the build", async () => {
  await rejectsFatally(
    applyWidgetConfigs(appDir(exportsConfigFor("widgets/favourites.tsx")), manifest()),
    /widgets\.ts has config for "widgets\/favourites\.tsx", which no widget in app\.json declares\. Known components: widgets\/favorites\.tsx\./,
  );
});

test("a widget with config in both files fails the build", async () => {
  await rejectsFatally(
    applyWidgetConfigs(appDir(exportsConfigFor("widgets/favorites.tsx")), manifest([titleField])),
    /widget "widgets\/favorites\.tsx" declares config in BOTH app\.json and widgets\.ts/,
  );
});

test("a widgets.ts that does not export a map of field arrays fails the build", async () => {
  await rejectsFatally(
    applyWidgetConfigs(appDir(`export default [];\n`), manifest()),
    /must default-export an object keyed by each widget's "component" path/,
  );
  await rejectsFatally(
    applyWidgetConfigs(
      appDir(`export default { "widgets/favorites.tsx": { key: "title" } };\n`),
      manifest(),
    ),
    /"widgets\/favorites\.tsx" must map to an array of config fields/,
  );
});

test("a widgets.ts that cannot be imported fails the build", async () => {
  await rejectsFatally(
    applyWidgetConfigs(appDir(`throw new Error("boom");\n`), manifest()),
    /^apps\/acme-\d+\/widgets\.ts could not be imported: boom$/,
  );
});
