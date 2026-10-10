/* This Source Code Form is subject to the terms of the Mozilla Public
 * License, v. 2.0. If a copy of the MPL was not distributed with this
 * file, You can obtain one at https://mozilla.org/MPL/2.0/. */

import fs from "fs";
import path from "path";
import type { AppBranding } from "../src/lib/apps/types";
import type {
  BrandHook,
  BrandLogo,
  BrandLogoAsset,
} from "../src/lib/branding/types";
import {
  BRAND_HOOKS,
  BRAND_LOGO_EXTENSIONS,
  BRAND_LOGO_HOOKS,
  BRAND_LOGO_MAX_BYTES,
  THEME_LOGO_EXTENSIONS,
  brandLogoUrl,
} from "../src/lib/branding/types";
import { FatalManifestError } from "./manifest-errors";
import { readImageSize, readSvgSize } from "./image-size";
import { ThemeError } from "./theme-css";

/**
 * The registry generator's brand checks: an app's `branding` declaration held
 * to its `hooks.ts`, and app and theme logos verified and measured.
 *
 * Its own module so it can be tested against fixture directories. The
 * generator runs on import, so nothing inside it can be.
 */

const BRAND_HOOK_SET = new Set<string>(BRAND_HOOKS);

/**
 * Where in an app's source each brand hook is registered: hook → files,
 * relative to the app root. A literal first argument to `.addFilter(`, the same
 * approach as the generator's `scanHooks`, so a hook name held in a variable is
 * invisible here — the runtime dispatcher, which counts only declared
 * registrations from `hooks.ts`, is what catches that.
 */
export function scanBrandRegistrations(appDir: string): Map<BrandHook, string[]> {
  const out = new Map<BrandHook, string[]>();
  const re = /\.addFilter\s*\(\s*["'`]([^"'`]+)["'`]/g;

  function walk(dir: string) {
    for (const entry of fs.readdirSync(dir, { withFileTypes: true })) {
      const full = path.join(dir, entry.name);
      if (entry.isDirectory()) {
        walk(full);
      } else if (/\.(ts|tsx)$/.test(entry.name)) {
        const src = fs.readFileSync(full, "utf-8");
        let m: RegExpExecArray | null;
        while ((m = re.exec(src)) !== null) {
          if (!BRAND_HOOK_SET.has(m[1])) continue;
          const hook = m[1] as BrandHook;
          const rel = path.relative(appDir, full).split(path.sep).join("/");
          out.set(hook, [...(out.get(hook) ?? []), rel]);
        }
      }
    }
  }
  walk(appDir);
  return out;
}

/**
 * Verify and measure one logo file. Shared by app `branding.logos` and theme
 * logos, which differ in what they accept: `extensions` (themes may ship SVG),
 * `maxBytes` (only app logos are capped — theme assets never were), and the
 * error class `fail` builds.
 */
export function measureLogoFile(
  abs: string,
  label: string,
  fail: (message: string) => Error,
  {
    extensions,
    maxBytes,
  }: { extensions: readonly string[]; maxBytes?: number },
): { width: number; height: number } {
  if (!fs.existsSync(abs)) {
    throw fail(`${label} does not exist.`);
  }
  const ext = path.extname(abs).toLowerCase();
  if (!extensions.includes(ext)) {
    const svgNote = extensions.includes(".svg")
      ? ""
      : " An app's logo is served from an unauthenticated path, and an SVG is a script-bearing document.";
    throw fail(
      `${label} is a ${ext || "extensionless"} file. A logo must be ` +
        `${extensions.join(", ")}: the build measures it so it can be drawn ` +
        `at its own aspect ratio.${svgNote}`,
    );
  }
  const buf = fs.readFileSync(abs);
  if (maxBytes !== undefined && buf.byteLength > maxBytes) {
    throw fail(
      `${label} is ${Math.round(buf.byteLength / 1024)} KB, above the ` +
        `${Math.round(maxBytes / 1024)} KB limit. It is drawn at most 240px wide.`,
    );
  }

  if (ext === ".svg") {
    const size = readSvgSize(buf.toString("utf-8"));
    if (!size) {
      throw fail(
        `${label} states no size: its root <svg> has neither an absolute ` +
          `width and height nor a viewBox. Add a viewBox, so the mark can be ` +
          `drawn at its own aspect ratio.`,
      );
    }
    return size;
  }

  const size = readImageSize(buf);
  if (!size || size.width === 0 || size.height === 0) {
    throw fail(
      `${label} could not be read as a ${ext.slice(1)} image. Either it is not ` +
        `one, or it is truncated — re-export it.`,
    );
  }
  return size;
}

/**
 * Hold an app's `branding` declaration to its code, in both directions, and
 * resolve its logos.
 *
 * - A brand hook registered anywhere but `hooks.ts` is an error: the platform
 *   loads only that file before rendering the brand, so the registration would
 *   silently never count.
 * - A brand hook registered but not declared is an error: changing the sign-in
 *   page is something an admin is shown before activating the app.
 * - A brand hook declared but not registered is an error: a stale declaration
 *   tells that admin the app changes something it does not.
 */
export function validateAppBranding(
  raw: { hooks: BrandHook[]; reason: string; logos?: string[] } | undefined,
  slug: string,
  appDir: string,
): AppBranding | null {
  const where = `apps/${slug}`;
  const registered = scanBrandRegistrations(appDir);

  for (const [hook, files] of registered) {
    const outside = files.find((f) => f !== "hooks.ts");
    if (outside) {
      throw new FatalManifestError(
        `${where}/${outside} registers the brand hook "${hook}". Brand hooks are ` +
          `registered only from ${where}/hooks.ts — the platform loads that file ` +
          `before rendering the brand, and a registration anywhere else never counts.`,
      );
    }
  }

  const declared = new Set<string>(raw?.hooks ?? []);
  for (const hook of registered.keys()) {
    if (!declared.has(hook)) {
      throw new FatalManifestError(
        `${where}/hooks.ts registers "${hook}", but app.json does not declare it. ` +
          `Add it to \`branding.hooks\`, with a \`reason\`: an admin sees that ` +
          `before activating an app that changes the sign-in page.`,
      );
    }
  }
  for (const hook of declared) {
    if (!registered.has(hook as BrandHook)) {
      throw new FatalManifestError(
        `${where}/app.json declares "${hook}" under \`branding.hooks\`, but ` +
          `${where}/hooks.ts never registers it. A stale declaration tells an admin ` +
          `the app changes something it does not.`,
      );
    }
  }

  if (!raw) return null;

  const logos: BrandLogoAsset[] = (raw.logos ?? []).map((file) => ({
    file,
    url: brandLogoUrl(slug, file),
    ...measureLogoFile(
      path.join(appDir, file),
      `${where}/${file}`,
      (m) => new FatalManifestError(m),
      { extensions: BRAND_LOGO_EXTENSIONS, maxBytes: BRAND_LOGO_MAX_BYTES },
    ),
  }));

  const filtersALogo = raw.hooks.some((h) =>
    (BRAND_LOGO_HOOKS as readonly string[]).includes(h),
  );
  if (logos.length > 0 && !filtersALogo) {
    throw new FatalManifestError(
      `${where}/app.json declares \`branding.logos\` but neither ` +
        `${BRAND_LOGO_HOOKS.join(" nor ")} under \`branding.hooks\`, so nothing ` +
        `could ever select them. Remove them or declare the hook.`,
    );
  }

  return { hooks: raw.hooks, reason: raw.reason, logos };
}

/**
 * One theme logo, resolved to its public URL and measured. `field` is the
 * manifest path the error names, e.g. "branding.loginLogo"; `dir` is the
 * theme's own folder.
 */
export function resolveThemeLogo(
  slug: string,
  dir: string,
  rel: string,
  field: string,
): BrandLogo {
  const size = measureLogoFile(
    path.join(dir, "assets", rel),
    `themes/${slug}/theme.json: ${field} ("${rel}", expected at themes/${slug}/assets/${rel})`,
    (m) => new ThemeError(m),
    { extensions: THEME_LOGO_EXTENSIONS },
  );
  return { src: `/themes/${slug}/${rel}`, ...size };
}
