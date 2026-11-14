/* This Source Code Form is subject to the terms of the Mozilla Public
 * License, v. 2.0. If a copy of the MPL was not distributed with this
 * file, You can obtain one at https://mozilla.org/MPL/2.0/. */

import { after, test } from "node:test";
import assert from "node:assert/strict";
import fs from "fs";
import os from "os";
import path from "path";
import { resolveThemeLogo, validateAppBranding } from "./brand-checks";
import { FatalManifestError } from "./manifest-errors";
import { RawAppManifestSchema, RawThemeManifestSchema } from "./manifest-schemas";
import { ThemeError } from "./theme-css";

// ── fixtures ────────────────────────────────────────────────────────────────

const root = fs.mkdtempSync(path.join(os.tmpdir(), "mixos-brand-checks-"));
after(() => fs.rmSync(root, { recursive: true, force: true }));

let n = 0;

/** A directory holding `files`, relative path → contents. */
function fixture(files: Record<string, string | Buffer>): string {
  const dir = path.join(root, `fixture-${n++}`);
  for (const [rel, contents] of Object.entries(files)) {
    fs.mkdirSync(path.dirname(path.join(dir, rel)), { recursive: true });
    fs.writeFileSync(path.join(dir, rel), contents);
  }
  fs.mkdirSync(dir, { recursive: true });
  return dir;
}

/** Enough of a PNG for the header reader, padded to `bytes`. */
function png(width: number, height: number, bytes = 33): Buffer {
  const buf = Buffer.alloc(Math.max(bytes, 33));
  buf.writeUInt32BE(0x89504e47, 0);
  buf.writeUInt32BE(width, 16);
  buf.writeUInt32BE(height, 20);
  return buf;
}

const hooksTs = (...hooks: string[]) =>
  `export default function register(hooks) {\n${hooks
    .map((h) => `  hooks.addFilter("${h}", (v) => v);`)
    .join("\n")}\n}\n`;

const reason = "Brands this install as Acme for the Acme rollout.";

// ── app declarations ────────────────────────────────────────────────────────

test("a declaration matching hooks.ts resolves, with its logos measured", () => {
  const dir = fixture({
    "hooks.ts": hooksTs("brand-name", "menu-bar-logo"),
    "branding/mark.png": png(600, 150),
  });
  const branding = validateAppBranding(
    { hooks: ["brand-name", "menu-bar-logo"], reason, logos: ["branding/mark.png"] },
    "acme",
    dir,
  );
  assert.deepEqual(branding, {
    hooks: ["brand-name", "menu-bar-logo"],
    reason,
    logos: [
      { file: "branding/mark.png", url: "/branding/apps/acme/mark.png", width: 600, height: 150 },
    ],
  });
});

test("an app with no branding and no brand registrations is fine", () => {
  const dir = fixture({ "hooks.ts": `export default function register() {}\n` });
  assert.equal(validateAppBranding(undefined, "acme", dir), null);
});

test("a registered but undeclared brand hook fails the build", () => {
  const dir = fixture({ "hooks.ts": hooksTs("brand-name", "login-logo") });
  assert.throws(
    () => validateAppBranding({ hooks: ["brand-name"], reason }, "acme", dir),
    (err: Error) =>
      err instanceof FatalManifestError &&
      /registers "login-logo", but app\.json does not declare it/.test(err.message),
  );
});

test("a declared but unregistered brand hook fails the build", () => {
  const dir = fixture({ "hooks.ts": hooksTs("brand-name") });
  assert.throws(
    () => validateAppBranding({ hooks: ["brand-name", "login-logo"], reason }, "acme", dir),
    (err: Error) =>
      err instanceof FatalManifestError && /declares "login-logo".*never registers it/.test(err.message),
  );
});

test("a brand hook registered outside hooks.ts fails the build, naming the file", () => {
  const dir = fixture({
    "hooks.ts": hooksTs("brand-name"),
    "lib/extra.ts": `hooks.addFilter("brand-name", () => "x");\n`,
  });
  assert.throws(
    () => validateAppBranding({ hooks: ["brand-name"], reason }, "acme", dir),
    (err: Error) =>
      err instanceof FatalManifestError &&
      /apps\/acme\/lib\/extra\.ts registers the brand hook "brand-name"/.test(err.message),
  );
});

test("an app may not ship an SVG logo", () => {
  const dir = fixture({
    "hooks.ts": hooksTs("login-logo"),
    "branding/mark.svg": '<svg viewBox="0 0 10 10"/>',
  });
  assert.throws(
    () =>
      validateAppBranding(
        { hooks: ["login-logo"], reason, logos: ["branding/mark.svg"] },
        "acme",
        dir,
      ),
    (err: Error) => err instanceof FatalManifestError && /is a \.svg file/.test(err.message),
  );
});

test("an app logo over the size limit fails the build", () => {
  const dir = fixture({
    "hooks.ts": hooksTs("login-logo"),
    "branding/mark.png": png(600, 150, 513 * 1024),
  });
  assert.throws(
    () =>
      validateAppBranding(
        { hooks: ["login-logo"], reason, logos: ["branding/mark.png"] },
        "acme",
        dir,
      ),
    (err: Error) => err instanceof FatalManifestError && /KB limit/.test(err.message),
  );
});

test("logos without a logo hook to select them fail the build", () => {
  const dir = fixture({ "hooks.ts": hooksTs("brand-name"), "branding/mark.png": png(10, 10) });
  assert.throws(
    () =>
      validateAppBranding(
        { hooks: ["brand-name"], reason, logos: ["branding/mark.png"] },
        "acme",
        dir,
      ),
    (err: Error) => err instanceof FatalManifestError && /nothing\s+could ever select them/.test(err.message),
  );
});

// ── manifest schemas ────────────────────────────────────────────────────────

const appBase = { $schema: "https://mixos.org/schemas/app/v1.json", registryId: "acme-3f9a2c1b", name: "Acme" };

test("app.json refuses an unknown brand hook and a placeholder reason", () => {
  const parsed = RawAppManifestSchema.safeParse({
    ...appBase,
    branding: { hooks: ["brand-name", "favicon"], reason: "rebrand" },
  });
  assert.equal(parsed.success, false);
  const messages = parsed.error!.issues.map((i) => `${i.path.join(".")}: ${i.message}`);
  assert.ok(messages.some((m) => /^branding\.hooks\.1: unknown brand hook "favicon"/.test(m)), messages.join("\n"));
  assert.ok(messages.some((m) => /^branding\.reason:/.test(m)), messages.join("\n"));
});

test("app.json logos must sit directly in branding/", () => {
  const parsed = RawAppManifestSchema.safeParse({
    ...appBase,
    branding: { hooks: ["login-logo"], reason, logos: ["assets/mark.png"] },
  });
  assert.equal(parsed.success, false);
  assert.deepEqual(
    parsed.error!.issues.map((i) => i.path.join(".")),
    ["branding.logos.0"],
  );
});

const themeBase = {
  $schema: "https://mixos.org/schemas/theme/v1.json",
  registryId: "acme-3f9a2c1b",
  name: "Acme",
  description: "A theme for the tests.",
};

test("theme.json refuses a brand name over 40 characters or on two lines", () => {
  for (const name of ["x".repeat(41), "Acme\nWorkspace", " Acme"]) {
    const parsed = RawThemeManifestSchema.safeParse({ ...themeBase, branding: { name } });
    assert.equal(parsed.success, false, JSON.stringify(name));
  }
  const ok = RawThemeManifestSchema.safeParse({ ...themeBase, branding: { name: "Acme Workspace" } });
  assert.equal(ok.success, true);
});

// ── theme logos ─────────────────────────────────────────────────────────────

test("a theme logo may be an SVG, measured from its viewBox", () => {
  const dir = fixture({ "assets/logo.svg": '<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 256 244"/>' });
  assert.deepEqual(resolveThemeLogo("acme", dir, "logo.svg", "assets.logo"), {
    src: "/themes/acme/logo.svg",
    width: 256,
    height: 244,
  });
});

test("a theme SVG that states no size fails the build", () => {
  const dir = fixture({ "assets/logo.svg": '<svg xmlns="http://www.w3.org/2000/svg"/>' });
  assert.throws(
    () => resolveThemeLogo("acme", dir, "logo.svg", "assets.logo"),
    (err: Error) => err instanceof ThemeError && /states no size/.test(err.message),
  );
});

test("a theme logo that does not exist fails the build", () => {
  const dir = fixture({});
  assert.throws(
    () => resolveThemeLogo("acme", dir, "missing.png", "branding.loginLogo"),
    (err: Error) => err instanceof ThemeError && /branding\.loginLogo.*does not exist/.test(err.message),
  );
});

test("a theme raster logo is measured from its header", () => {
  const dir = fixture({ "assets/logo.png": png(256, 244) });
  assert.deepEqual(resolveThemeLogo("acme", dir, "logo.png", "assets.logo"), {
    src: "/themes/acme/logo.png",
    width: 256,
    height: 244,
  });
});
