/* This Source Code Form is subject to the terms of the Mozilla Public
 * License, v. 2.0. If a copy of the MPL was not distributed with this
 * file, You can obtain one at https://mozilla.org/MPL/2.0/. */

/**
 * The design-system rules, linted through the real eslint.config.mjs.
 *
 * Testing the config rather than a rule in isolation is the point: the gap
 * this covers was not in any rule, but in how two config blocks combined.
 * Flat config replaces a rule's options when a later block sets it again, so
 * the primitives block switched the colour fence off for every app .tsx file
 * while each block, read on its own, looked right.
 */

import { test } from "node:test";
import assert from "node:assert/strict";
import path from "path";
import { ESLint } from "eslint";

const repo = path.resolve(__dirname, "..");
const eslint = new ESLint({ cwd: repo });

/** The `no-restricted-syntax` messages `code` draws at `file`. */
async function restricted(file: string, code: string): Promise<string[]> {
  const [result] = await eslint.lintText(code, { filePath: path.join(repo, file) });
  return result.messages
    .filter((m) => m.ruleId === "no-restricted-syntax")
    .map((m) => m.message);
}

const WIDGET = `
export default function Fixture() {
  return (
    <div className="text-red-500 dark:text-foreground">
      <span className={\`bg-white \${"p-2"}\`}>x</span>
      <button>go</button>
    </div>
  );
}
`;

for (const file of ["apps/fixture/widgets/fixture.tsx", "apps/fixture/pages/Main.tsx"]) {
  test(`${file}: the colour fence and the primitives both apply`, async () => {
    const messages = await restricted(file, WIDGET);
    assert.ok(messages.some((m) => m.startsWith("Raw palette colours")), "palette");
    assert.ok(messages.some((m) => m.startsWith("There is no dark: variant")), "dark:");
    assert.ok(messages.some((m) => m.startsWith("An opaque bg-white")), "opaque fill");
    assert.ok(messages.some((m) => m.startsWith("Use <Button>")), "raw <button>");
  });
}

test("platform code keeps the colour fence, without the app-only primitives", async () => {
  const messages = await restricted("src/components/fixture.tsx", WIDGET);
  assert.ok(messages.some((m) => m.startsWith("Raw palette colours")));
  assert.ok(messages.some((m) => m.startsWith("There is no dark: variant")));
  assert.ok(!messages.some((m) => m.startsWith("Use <Button>")));
});
