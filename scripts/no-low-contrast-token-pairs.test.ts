/* This Source Code Form is subject to the terms of the Mozilla Public
 * License, v. 2.0. If a copy of the MPL was not distributed with this
 * file, You can obtain one at https://mozilla.org/MPL/2.0/. */

/**
 * eslint-rules/no-low-contrast-token-pairs.mjs, against fixture palettes.
 *
 * Lives here because `npm test` collects tests from scripts/ and src/. The
 * rule's default export reads src/generated/theme-tokens.json; these hand it
 * palettes instead, so they need no generated registry.
 */

import { test } from "node:test";
import assert from "node:assert/strict";
import { Linter } from "eslint";
import { createRule, palettesFrom } from "../eslint-rules/no-low-contrast-token-pairs.mjs";

const LIGHT = {
  background: "#ffffff",
  foreground: "#0f172a",
  muted: "#f1f5f9",
  "muted-foreground": "#334155",
  destructive: "#dc2626",
  "brand-cyan": "#0284c7",
  radius: "0.5rem",
};

const DARK = {
  background: "#000000",
  foreground: "#ffffff",
  muted: "#111111",
  "muted-foreground": "#444444",
  destructive: "#f87171",
};

/** The rule's messages for one element carrying `className`. */
function lint(themes: Record<string, Record<string, string>> | null, className: string) {
  const rule = createRule(themes == null ? null : palettesFrom(themes));
  return new Linter()
    .verify(
      `const x = <p className="${className}">x</p>;`,
      [
        {
          files: ["**/*.jsx"],
          languageOptions: { parserOptions: { ecmaFeatures: { jsx: true } } },
          plugins: { mos: { rules: { contrast: rule } } },
          rules: { "mos/contrast": "error" },
        },
      ],
      "fixture.jsx",
    )
    .map((m) => m.message);
}

test("a pair that fails under only one installed theme is reported, naming it", () => {
  // 9.45:1 under light. The rule used to read only the fallback theme, so
  // the 1.94:1 under dark was never seen.
  const [message, ...rest] = lint({ light: LIGHT, dark: DARK }, "bg-muted text-muted-foreground");
  assert.equal(rest.length, 0);
  assert.match(
    message,
    /`text-muted-foreground` on `bg-muted` is 1\.94:1 under dark — under the 4\.5:1 floor/,
  );
  assert.doesNotMatch(message, /under light/);
});

test("a pair that fails under several themes names each, with its ratio", () => {
  const [message] = lint({ light: LIGHT, dark: DARK }, "bg-destructive text-foreground");
  assert.match(message, /is \d\.\d\d:1 under light and \d\.\d\d:1 under dark/);
});

test("an alpha fill is composited over each theme's own background", () => {
  // Over white, a 10% destructive wash under destructive text is 4.13:1 and
  // fails; over black, the same construction passes easily.
  const [message, ...rest] = lint(
    { light: LIGHT, dark: DARK },
    "bg-destructive/10 text-destructive",
  );
  assert.equal(rest.length, 0);
  assert.match(message, /under light/);
  assert.doesNotMatch(message, /under dark/);
});

test("a dimmed token is measured under every theme, each on its own ground", () => {
  const [message] = lint({ light: LIGHT, dark: DARK }, "text-muted-foreground/70");
  assert.match(message, /thins a colour token to 4\.35:1 under light and 1\.59:1 under dark/);
});

test("a token only some themes set is measured where it is set", () => {
  const messages = lint({ light: LIGHT, dark: DARK }, "bg-brand-cyan text-foreground");
  assert.equal(messages.length, 1);
  assert.match(messages[0], /is 4\.36:1 under light — /);
});

test("the suggested text token must clear the floor under every theme", () => {
  // 16.30:1 under light is the worse of the two, so that is what is quoted.
  const [ok] = lint({ light: LIGHT, dark: DARK }, "bg-muted text-muted-foreground");
  assert.match(
    ok,
    /raise the text to `text-foreground` \(at least 16\.30:1 under every installed theme\)/,
  );

  // A dark foreground of #777777 is 4.22:1 on its muted, so text-foreground
  // clears the floor under light but not under dark, and is not suggested.
  const [none] = lint(
    { light: LIGHT, dark: { ...DARK, foreground: "#777777" } },
    "bg-muted text-muted-foreground",
  );
  assert.match(none, /raise the text to a token that clears the floor on it/);
});

test("with no palettes the rule is inert, not a crash", () => {
  assert.deepEqual(lint(null, "bg-muted text-muted-foreground"), []);
});
