/* This Source Code Form is subject to the terms of the Mozilla Public
 * License, v. 2.0. If a copy of the MPL was not distributed with this
 * file, You can obtain one at https://mozilla.org/MPL/2.0/. */

import { after, test } from "node:test";
import assert from "node:assert/strict";
import fs from "fs";
import os from "os";
import path from "path";
import { compileTheme, ThemeError } from "./theme-css";
import { RawThemeManifestSchema } from "./manifest-schemas";

// ── fixtures ────────────────────────────────────────────────────────────────

const root = fs.mkdtempSync(path.join(os.tmpdir(), "mixos-theme-css-"));
after(() => fs.rmSync(root, { recursive: true, force: true }));

/** A complete palette that passes every pair: themes/_template's values. */
const PALETTE: Record<string, string> = {
  background: "#ffffff",
  foreground: "#0f172a",
  card: "#ffffff",
  "card-foreground": "#0f172a",
  popover: "#ffffff",
  "popover-foreground": "#0f172a",
  primary: "#0369a1",
  "primary-foreground": "#f8fafc",
  secondary: "#f1f5f9",
  "secondary-foreground": "#0f172a",
  muted: "#f1f5f9",
  "muted-foreground": "#64748b",
  accent: "#f1f5f9",
  "accent-foreground": "#0f172a",
  destructive: "#dc2626",
  "destructive-foreground": "#f8fafc",
  success: "#047857",
  "success-foreground": "#f8fafc",
  warning: "#b45309",
  "warning-foreground": "#f8fafc",
  "cat-1": "#0369a1",
  "cat-2": "#7c3aed",
  "cat-3": "#0f766e",
  "cat-4": "#be185d",
  "cat-5": "#1d4ed8",
  "cat-6": "#4d7c0f",
  border: "#e2e8f0",
  input: "#64748b",
  ring: "#0369a1",
  brand: "#0f172a",
  "brand-foreground": "#f8fafc",
  "brand-accent": "#38bdf8",
  radius: "0.5rem",
  "type-sans": "ui-sans-serif, system-ui, sans-serif",
  "type-heading": "ui-sans-serif, system-ui, sans-serif",
  "type-mono": "ui-monospace, monospace",
};

let n = 0;

/**
 * Compile a theme whose `:root` is PALETTE with `tokens` merged over it (a
 * `null` value removes the token), followed by `css`. `files` are written
 * under the theme's `assets/`; `fonts` and `surfaces` are what its theme.json
 * declares.
 */
function compile({
  tokens = {},
  css = "",
  fonts = [],
  surfaces = [],
  files = [],
}: {
  tokens?: Record<string, string | null>;
  css?: string;
  fonts?: string[];
  surfaces?: string[];
  files?: string[];
} = {}) {
  const dir = path.join(root, `theme-${n++}`);
  for (const file of files) {
    fs.mkdirSync(path.dirname(path.join(dir, "assets", file)), { recursive: true });
    fs.writeFileSync(path.join(dir, "assets", file), "");
  }
  const merged = { ...PALETTE, ...tokens };
  const decls = Object.entries(merged)
    .filter(([, v]) => v != null)
    .map(([k, v]) => `  --${k}: ${v};`)
    .join("\n");
  fs.mkdirSync(dir, { recursive: true });
  fs.writeFileSync(path.join(dir, "theme.css"), `:root {\n${decls}\n}\n${css}`);
  return compileTheme({
    slug: "fixture",
    dir,
    escapes: [],
    declaredSurfaces: surfaces,
    declaredFonts: fonts,
  });
}

/** Assert `fn` fails the build with a message matching every pattern. */
function fails(fn: () => unknown, ...patterns: RegExp[]) {
  assert.throws(fn, (err: Error) => {
    assert.ok(err instanceof ThemeError, `expected a ThemeError, got ${err}`);
    for (const p of patterns) assert.match(err.message, p);
    return true;
  });
}

test("the fixture palette compiles", () => {
  const compiled = compile();
  assert.equal(compiled.report.length, 24);
});

test("both bundled themes compile with their own manifests", () => {
  for (const slug of ["mixos", "mixos-dark"]) {
    const dir = path.resolve(__dirname, "../themes", slug);
    const manifest = RawThemeManifestSchema.parse(
      JSON.parse(fs.readFileSync(path.join(dir, "theme.json"), "utf-8")),
    );
    assert.doesNotThrow(() =>
      compileTheme({
        slug,
        dir,
        escapes: manifest.escapes ?? [],
        declaredSurfaces: manifest.surfaces ?? [],
        declaredFonts: (manifest.fonts ?? []).map((f) => f.file),
      }),
    );
  }
});

// ── tokens live in one top-level :root ──────────────────────────────────────

test("a token set on a surface fails the build", () => {
  // #f8fafc on #fde047 is 1.26:1, on every button, and this used to build.
  fails(
    () => compile({ css: `.mix-button { --primary: #fde047; }`, surfaces: [".mix-button"] }),
    /"\.mix-button" sets --primary/,
    /set in :root and nowhere else/,
  );
});

test("a dark palette under prefers-color-scheme fails, and names the sibling theme", () => {
  // Every value here would pass the gate, which is what let it through: the
  // nested block was read as more of the top-level one.
  fails(
    () =>
      compile({
        css: `@media (prefers-color-scheme: dark) {\n  :root { --brand: #020617; }\n}`,
      }),
    /":root" inside @media \(prefers-color-scheme: dark\)/,
    /themes\/fixture-dark\/theme\.css/,
  );
});

test("a :root inside @supports fails the build", () => {
  fails(
    () => compile({ css: `@supports (display: grid) { :root { --radius: 1rem; } }` }),
    /":root" inside @supports \(display: grid\)/,
  );
});

test("a custom property inside @font-face fails the build", () => {
  fails(
    () =>
      compile({
        css: `@font-face { font-family: "X"; src: url("x.woff2"); --primary: #000; }`,
        fonts: ["x.woff2"],
        files: ["x.woff2"],
      }),
    /@font-face sets --primary/,
  );
});

test("a surface rule inside @media with ordinary properties still builds", () => {
  assert.doesNotThrow(() =>
    compile({
      css: `@media (min-width: 640px) { .mix-card { border-width: 2px; } }`,
      surfaces: [".mix-card"],
    }),
  );
});

// ── every value is evaluated ────────────────────────────────────────────────

test("a var() naming an undeclared token fails, instead of skipping its pairs", () => {
  fails(
    () => compile({ tokens: { primary: "var(--brand-cyan)" } }),
    /--primary resolves to var\(--brand-cyan\), but :root never sets --brand-cyan/,
  );
});

test("the chain a missing token is reached through is named", () => {
  fails(
    () => compile({ tokens: { primary: "var(--ring)", ring: "var(--brand-cyan)" } }),
    /--primary resolves through --ring to var\(--brand-cyan\)/,
  );
});

test("a var() loop fails the build", () => {
  fails(
    () => compile({ tokens: { primary: "var(--ring)", ring: "var(--primary)" } }),
    /--primary never resolves: --primary → --ring → --primary is a loop/,
  );
});

test("a var() chain ending in a literal resolves, and is measured", () => {
  const compiled = compile({
    tokens: { "brand-cyan": "#0369a1", primary: "var(--brand-cyan)" },
  });
  assert.equal(compiled.tokens.primary, "#0369a1");
  assert.ok(compiled.report.some((l) => /primary\/background\s+5\.93:1/.test(l)));
});

test("an ungated colour token in oklch() or color-mix() fails the build", () => {
  fails(() => compile({ tokens: { muted: "oklch(0.97 0 0)" } }), /--muted is "oklch/);
  fails(
    () => compile({ tokens: { border: "color-mix(in srgb, #000 10%, #fff)" } }),
    /--border is "color-mix/,
    /cannot evaluate/,
  );
  fails(
    () => compile({ tokens: { "brand-violet": "oklch(0.55 0.25 290)" } }),
    /--brand-violet is "oklch/,
  );
});

// ── alpha is not ignored ────────────────────────────────────────────────────

test("a translucent token fails instead of being measured as opaque", () => {
  // Opaque, this is 4.76:1 and passes. At half alpha over white it is #b2bac5,
  // which is 1.96:1 — the build used to drop the alpha and report the 4.76.
  fails(
    () => compile({ tokens: { "muted-foreground": "rgb(100 116 139 / 0.5)" } }),
    /--muted-foreground is "rgb\(100 116 139 \/ 0\.5\)", which is translucent/,
    /Over this theme's --background that is #b2bac5/,
  );
  fails(
    () => compile({ tokens: { muted: "#f1f5f980" } }),
    /--muted is "#f1f5f980", which is translucent/,
  );
  fails(() => compile({ tokens: { card: "hsla(0, 0%, 100%, 50%)" } }), /which is translucent/);
});

test("a translucent --border builds, composited over --background", () => {
  // Over this theme's ground, not over white: half black on #f8fafc is
  // #7c7d7e, where on white it would be #808080.
  const compiled = compile({ tokens: { background: "#f8fafc", border: "rgb(0 0 0 / 0.5)" } });
  assert.equal(compiled.tokens.border, "#7c7d7e");
  assert.equal(compile({ tokens: { border: "#0f172a1a" } }).tokens.border, "#e7e7e9");
});

test("the exception is the --border token, not a translucent value", () => {
  // --input is gated, so taking --border's value through var() does not take
  // the exception with it.
  fails(
    () => compile({ tokens: { border: "rgb(0 0 0 / 0.1)", input: "var(--border)" } }),
    /--input is "rgb\(0 0 0 \/ 0\.1\)", which is translucent/,
  );
  // And the ground a translucent --border is composited over stays opaque.
  fails(
    () =>
      compile({ tokens: { background: "rgb(255 255 255 / 0.5)", border: "rgb(0 0 0 / 0.1)" } }),
    /--background is "rgb\(255 255 255 \/ 0\.5\)", which is translucent/,
  );
});

test("an explicit full alpha is opaque, and every colour is emitted as hex", () => {
  const compiled = compile({
    tokens: {
      background: "rgba(255, 255, 255, 1)",
      card: "hsl(0 0% 100% / 100%)",
      border: "#e2e8f0ff",
    },
  });
  assert.equal(compiled.tokens.background, "#ffffff");
  assert.equal(compiled.tokens.card, "#ffffff");
  assert.equal(compiled.tokens.border, "#e2e8f0");
  // Not a colour, so left as written.
  assert.equal(compiled.tokens.radius, "0.5rem");
});

// ── fonts are declared in both directions ───────────────────────────────────

const fontFace = (file: string) =>
  `@font-face { font-family: "Inter"; src: url("${file}") format("woff2"); font-display: swap; }`;

test("an @font-face missing from fonts[] fails the build", () => {
  fails(
    () => compile({ css: fontFace("fonts/inter.woff2"), files: ["fonts/inter.woff2"] }),
    /an @font-face loads "fonts\/inter\.woff2", which fonts\[\] in theme\.json does not declare/,
  );
});

test("a declared font named only in a comment fails the build", () => {
  fails(
    () =>
      compile({
        css: `/* fonts/inter.woff2 is coming soon */`,
        fonts: ["fonts/inter.woff2"],
        files: ["fonts/inter.woff2"],
      }),
    /fonts\[\] declares "fonts\/inter\.woff2", but no @font-face in theme\.css loads it/,
  );
});

test("a font declared and loaded builds, however its path is spelled", () => {
  assert.doesNotThrow(() =>
    compile({
      css: fontFace("./fonts/inter.woff2"),
      fonts: ["fonts/inter.woff2"],
      files: ["fonts/inter.woff2"],
    }),
  );
});
