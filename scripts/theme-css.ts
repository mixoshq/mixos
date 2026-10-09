/* This Source Code Form is subject to the terms of the Mozilla Public
 * License, v. 2.0. If a copy of the MPL was not distributed with this
 * file, You can obtain one at https://mozilla.org/MPL/2.0/. */

/**
 * Build-time validator and compiler for a theme's `theme.css`.
 *
 * A theme is powerful enough to be worth constraining: it repaints every app in
 * the install at once. Three properties are enforced here, and each one exists
 * because its absence has a specific failure mode:
 *
 *  1. **A closed token set.** A typo'd custom property is not a no-op — it is a
 *     token that silently keeps its previous value while the author believes
 *     they changed it. Unknown names are rejected.
 *  2. **A closed selector set.** Without it, app internals become an accidental
 *     public API: a theme selects `.chart-legend`, a refactor renames it, and
 *     the theme breaks in a way nobody attributes to the refactor.
 *  3. **Verified contrast.** Every pair in the token contract is measured. A
 *     palette that fails AA cannot ship unless the theme names the exact pair
 *     and says why.
 *
 * Parsing uses postcss, already present via @tailwindcss/postcss — no new
 * dependency. The same pass that validates also rewrites `:root` to
 * `[data-theme="<slug>"]`, which is what lets every installed theme be bundled
 * together and the active one selected by an attribute rather than a rebuild.
 */

import fs from "fs";
import path from "path";
import postcss from "postcss";
import type { Rule, AtRule, Declaration } from "postcss";
import {
  REQUIRED_TOKENS,
  FORBIDDEN_TOKENS,
  TOKEN_NAMES,
  CONTRAST_PAIRS,
  RATIO_FOR,
  SURFACE_ALLOWLIST,
  ALL_TOKENS,
} from "../src/lib/themes/tokens";
import {
  parseColor,
  resolveVar,
  contrastRatio,
  ratioText,
} from "../src/lib/themes/color";
import type {
  ThemeEscape,
  ThemeSwatch,
  ThemeTypeface,
} from "../src/lib/themes/types";

/** Aborts the whole generator run, exactly as a malformed app manifest does. */
export class ThemeError extends Error {
  constructor(message: string) {
    super(message);
    this.name = "ThemeError";
  }
}

/**
 * The one block a theme may declare tokens in. Anything else is an error.
 *
 * A theme has exactly one palette. The mode axis this file used to carry — a
 * second `:root[data-mode="dark"]` block, verified separately — was collapsed
 * into the theme axis, because "which colours am I looking at" already had an
 * answer and two answers could disagree. A dark look is a different theme.
 * See docs/plans/20260826_2041-single-palette-themes.md.
 */
const TOKEN_SELECTOR = ":root";

/** Recognised only to give its author a message that names the replacement. */
const LEGACY_DARK_SELECTOR = ':root[data-mode="dark"]';

const ALLOWED_AT_RULES = new Set([
  "font-face",
  "media",
  "supports",
  "keyframes",
]);

const SURFACES = new Set<string>(SURFACE_ALLOWLIST);

const KIND_OF = new Map(ALL_TOKENS.map((t) => [t.name, t.kind]));

/** Tokens shown as swatches in the admin picker, in the order they read best. */
const SWATCH_TOKENS = [
  "background",
  "foreground",
  "primary",
  "brand",
  "brand-accent",
  "success",
  "warning",
  "destructive",
];

/**
 * The type roles shown in the admin picker, in the order they read on a card.
 * These are the `--type-*` tokens, which is the only place a theme says which
 * of its families is the heading face and which is body text — `fonts[]` is a
 * list of files and carries no roles.
 */
const TYPEFACE_ROLES: Array<{ token: string; label: string }> = [
  { token: "type-heading", label: "Heading" },
  { token: "type-sans", label: "Body" },
  { token: "type-mono", label: "Code" },
];

/**
 * CSS generic families and system keywords. A stack that begins with one of
 * these names no real typeface, so the picker says "System" rather than
 * printing `ui-sans-serif` at an admin as though it were a font choice.
 */
const GENERIC_FAMILIES = new Set([
  "ui-sans-serif",
  "ui-serif",
  "ui-monospace",
  "ui-rounded",
  "system-ui",
  "-apple-system",
  "blinkmacsystemfont",
  "sans-serif",
  "serif",
  "monospace",
  "cursive",
  "fantasy",
]);

/** The first named family in a font stack, or "System" if there isn't one. */
function primaryFamily(stack: string): string {
  const first = stack.split(",")[0]?.trim() ?? "";
  const bare = first.replace(/^["']|["']$/g, "");
  return GENERIC_FAMILIES.has(bare.toLowerCase()) ? "System" : bare;
}

export interface CompiledTheme {
  /** CSS scoped to `[data-theme="<slug>"]`, ready to concatenate. */
  css: string;
  /** Allowlisted surfaces the CSS actually styles. */
  surfaces: string[];
  swatches: ThemeSwatch[];
  typefaces: ThemeTypeface[];
  /** Every resolved token. Consumed by the contrast lint rule. */
  tokens: Record<string, string>;
  /** Human-readable ratio lines, echoed by the generator so CI shows the maths. */
  report: string[];
}

function norm(selector: string): string {
  return selector.replace(/\s+/g, " ").trim();
}

const URL_REF = /url\(\s*['"]?([^'")]+)['"]?\s*\)/g;

/** A `url()` reference as a path inside `assets/`, the way theme.json spells one. */
function assetPath(ref: string): string {
  return ref.trim().replace(/^\.?\//, "");
}

/**
 * Every class named anywhere in the selector must be an allowlisted surface,
 * and the selector may not reach for an id or a bare element. Pseudo-classes,
 * pseudo-elements, `[data-*]` states and combinators between allowlisted
 * classes are all fine — that is the expressive room a theme actually needs.
 */
function assertSurfaceSelector(selector: string, slug: string): string {
  const sel = norm(selector);

  if (/#[\w-]/.test(sel)) {
    throw new ThemeError(
      `themes/${slug}/theme.css: selector "${sel}" targets an id. ` +
        `A theme may only style the allowlisted .mix-* surfaces.`,
    );
  }

  const classes = [...sel.matchAll(/\.[-\w]+/g)].map((m) => m[0]);
  if (classes.length === 0) {
    throw new ThemeError(
      `themes/${slug}/theme.css: selector "${sel}" targets bare elements. ` +
        `Style one of the allowlisted surfaces instead: ${[...SURFACES].join(", ")}.`,
    );
  }

  for (const cls of classes) {
    if (!SURFACES.has(cls)) {
      throw new ThemeError(
        `themes/${slug}/theme.css: selector "${sel}" reaches "${cls}", which is not an ` +
          `allowlisted surface. App and platform internals are deliberately out of a theme's ` +
          `reach — a rename inside a component would break your theme with no way to notice. ` +
          `Allowed: ${[...SURFACES].join(", ")}.`,
      );
    }
  }

  // Anything not part of a class compound, a combinator, a pseudo, or an
  // attribute selector means an element crept in (`.mix-card span`).
  const residue = sel
    .replace(/\.[-\w]+/g, "")
    .replace(/::?[-\w]+(\([^)]*\))?/g, "")
    .replace(/\[[^\]]*\]/g, "")
    .replace(/[>+~,\s]/g, "");
  if (residue.length > 0) {
    throw new ThemeError(
      `themes/${slug}/theme.css: selector "${sel}" includes element selectors ("${residue}"). ` +
        `Restrict the selector to the allowlisted .mix-* surfaces and their states.`,
    );
  }

  return classes[0];
}

/**
 * A theme's assets are its own. An external `url()` would reintroduce exactly
 * the third-party request this abstraction removes (today's Google Fonts
 * `@import`), and would let a theme phone home on every page load. `data:` is
 * allowed because it is self-contained.
 */
function assertLocalUrls(decl: Declaration, slug: string, dir: string): void {
  for (const m of decl.value.matchAll(URL_REF)) {
    const ref = m[1].trim();
    if (ref.startsWith("data:")) continue;
    if (/^[a-z][a-z0-9+.-]*:/i.test(ref) || ref.startsWith("//")) {
      throw new ThemeError(
        `themes/${slug}/theme.css: "${decl.prop}" loads "${ref}" from another host. ` +
          `A theme may only reference files under its own assets/ directory — ship the font, ` +
          `image or icon with the theme instead.`,
      );
    }
    const cleaned = assetPath(ref);
    const onDisk = path.join(dir, "assets", cleaned);
    if (!fs.existsSync(onDisk)) {
      throw new ThemeError(
        `themes/${slug}/theme.css: "${decl.prop}" references "${ref}", which does not exist. ` +
          `Expected it at themes/${slug}/assets/${cleaned}.`,
      );
    }
  }
}

function rewriteUrls(value: string, slug: string): string {
  return value.replace(URL_REF, (whole, ref: string) => {
    const r = ref.trim();
    if (r.startsWith("data:")) return whole;
    return `url("/themes/${slug}/${assetPath(r)}")`;
  });
}

/** Resolve a block's declarations to concrete values, following `var()` chains. */
function resolveBlock(raw: Map<string, string>): Map<string, string> {
  const out = new Map<string, string>();
  for (const [name, value] of raw) {
    const resolved = resolveVar(value, raw);
    if (resolved != null) out.set(name, resolved);
  }
  return out;
}

function checkContrast(
  resolved: Map<string, string>,
  slug: string,
  escapes: ThemeEscape[],
  report: string[],
): Set<string> {
  const used = new Set<string>();

  for (const pair of CONTRAST_PAIRS) {
    const fgRaw = resolved.get(pair.fg);
    const bgRaw = resolved.get(pair.bg);
    if (fgRaw == null || bgRaw == null) continue; // completeness is checked separately

    const fg = parseColor(fgRaw);
    const bg = parseColor(bgRaw);
    if (fg == null || bg == null) {
      const bad = fg == null ? pair.fg : pair.bg;
      throw new ThemeError(
        `themes/${slug}/theme.css: --${bad} is "${fg == null ? fgRaw : bgRaw}", which the ` +
          `build cannot evaluate. Contrast is verified at build time, so every colour token must be a ` +
          `hex, rgb() or hsl() literal — or a var() chain ending in one. A value the build cannot read ` +
          `is a token the contrast gate silently stops covering.`,
      );
    }

    const ratio = contrastRatio(fg, bg);
    const required = RATIO_FOR[pair.kind];
    const ok = ratio >= required;
    const escape = escapes.find((e) => e.pair === pair.id);

    if (escape) used.add(pair.id);

    if (ok && escape) {
      throw new ThemeError(
        `themes/${slug}/theme.json: escapes declares "${pair.id}", but that pair passes at ` +
          `${ratioText(ratio)}. Remove the escape — a stale one reads as "reviewed and accepted" to the ` +
          `next person while protecting nothing.`,
      );
    }

    if (!ok && !escape) {
      throw new ThemeError(
        `themes/${slug}/theme.css: --${pair.fg} on --${pair.bg} is ${ratioText(ratio)}, ` +
          `below the ${required}:1 required for ${pair.kind}.\n` +
          `  ${pair.why}\n` +
          `  --${pair.fg}: ${fgRaw}\n  --${pair.bg}: ${bgRaw}\n` +
          `  Darken or lighten one of them, or — if this is a brand value you cannot move — declare it ` +
          `in theme.json:\n` +
          `    "escapes": [{ "rule": "contrast-aa", "pair": "${pair.id}", "reason": "…" }]`,
      );
    }

    report.push(
      `      ${ok ? "ok  " : "ESC "} ${pair.id.padEnd(38)} ${ratioText(ratio).padStart(8)}`,
    );
  }

  return used;
}

export function compileTheme(args: {
  slug: string;
  dir: string;
  escapes: ThemeEscape[];
  declaredSurfaces: string[];
  /** `fonts[].file` from theme.json, cross-checked against every `@font-face`. */
  declaredFonts: string[];
}): CompiledTheme {
  const { slug, dir, escapes, declaredSurfaces, declaredFonts } = args;
  const file = path.join(dir, "theme.css");

  if (!fs.existsSync(file)) {
    throw new ThemeError(
      `themes/${slug}/theme.css is missing. Every theme needs one.`,
    );
  }

  const source = fs.readFileSync(file, "utf-8");
  let root: postcss.Root;
  try {
    root = postcss.parse(source, { from: file });
  } catch (err) {
    throw new ThemeError(
      `themes/${slug}/theme.css could not be parsed: ${err instanceof Error ? err.message : String(err)}`,
    );
  }

  const tokens = new Map<string, string>();
  const surfacesStyled = new Set<string>();

  root.walkAtRules((at: AtRule) => {
    if (at.name === "import") {
      throw new ThemeError(
        `themes/${slug}/theme.css: @import is not allowed. Themes are self-contained — ` +
          `inline the rules and ship any font or image under assets/.`,
      );
    }
    if (!ALLOWED_AT_RULES.has(at.name)) {
      throw new ThemeError(
        `themes/${slug}/theme.css: @${at.name} is not allowed. ` +
          `A theme may use ${[...ALLOWED_AT_RULES].map((r) => `@${r}`).join(", ")}.`,
      );
    }
    if (at.name === "keyframes") {
      const animName = at.params.trim();
      if (!animName.startsWith(`${slug}-`)) {
        throw new ThemeError(
          `themes/${slug}/theme.css: @keyframes "${animName}" must be prefixed "${slug}-". ` +
            `Every installed theme is bundled together, so an unprefixed animation name collides ` +
            `across themes.`,
        );
      }
    }
  });

  root.walkDecls((decl: Declaration) => assertLocalUrls(decl, slug, dir));

  root.walkRules((rule: Rule) => {
    // Rules nested inside @font-face/@keyframes are handled by their at-rule.
    const parentAt = rule.parent && (rule.parent as AtRule).name;
    if (parentAt === "keyframes") return;

    const selectors = rule.selectors.map(norm);

    for (const sel of selectors) {
      // Caught explicitly. Without this the selector would fall through to
      // assertSurfaceSelector and the author would be told their theme "reaches
      // a class that is not an allowlisted surface", which is true and useless.
      if (sel === LEGACY_DARK_SELECTOR) {
        throw new ThemeError(
          `themes/${slug}/theme.css: "${sel}" is no longer a token block. A theme now declares ` +
            `exactly ONE palette, in :root — the light/dark mode axis was collapsed into the theme ` +
            `axis. Move this block into its own theme (themes/${slug}-dark/theme.css, as its :root) ` +
            `and an admin selects it at /admin/themes. See docs/themes/architecture.md.`,
        );
      }

      if (sel === TOKEN_SELECTOR) {
        if (selectors.length > 1) {
          throw new ThemeError(
            `themes/${slug}/theme.css: "${sel}" must be its own rule, not part of a selector list.`,
          );
        }

        rule.walkDecls((decl) => {
          if (!decl.prop.startsWith("--")) {
            throw new ThemeError(
              `themes/${slug}/theme.css: "${sel}" declares "${decl.prop}". The token blocks may only ` +
                `set custom properties — style the allowlisted .mix-* surfaces instead.`,
            );
          }
          const name = decl.prop.slice(2);
          if ((FORBIDDEN_TOKENS as readonly string[]).includes(name)) {
            throw new ThemeError(
              `themes/${slug}/theme.css: --${name} is not themeable — it is a value that must ` +
                `survive a theme change. See FORBIDDEN_TOKENS in src/lib/themes/tokens.ts.`,
            );
          }
          if (!TOKEN_NAMES.has(name)) {
            throw new ThemeError(
              `themes/${slug}/theme.css: --${name} is not a known token, so nothing reads it. ` +
                `See docs/themes/tokens.md for the full contract.`,
            );
          }
          tokens.set(name, decl.value.trim());
        });
        continue;
      }

      surfacesStyled.add(assertSurfaceSelector(sel, slug));
    }
  });

  // ── completeness ──────────────────────────────────────────────────────────
  const missing = REQUIRED_TOKENS.filter((t) => !tokens.has(t.name));
  if (missing.length > 0) {
    throw new ThemeError(
      `themes/${slug}/theme.css: :root is missing ${missing.length} required token(s):\n` +
        missing.map((t) => `  --${t.name} — ${t.role}`).join("\n") +
        `\nAn undefined custom property does not fall back to something sensible; it renders as ` +
        `unset, which is a transparent surface or invisible text.`,
    );
  }

  // ── contrast ──────────────────────────────────────────────────────────────
  const report: string[] = [];
  const resolved = resolveBlock(tokens);
  const usedEscapes = checkContrast(resolved, slug, escapes, report);

  for (const e of escapes) {
    if (!usedEscapes.has(e.pair)) {
      throw new ThemeError(
        `themes/${slug}/theme.json: escapes names pair "${e.pair}", which is not a pair this ` +
          `platform verifies. Valid ids: ${CONTRAST_PAIRS.map((p) => p.id).join(", ")}.`,
      );
    }
  }

  // ── the manifest must tell the truth about what it styles ─────────────────
  const styled = [...surfacesStyled].sort();
  const declared = [...new Set(declaredSurfaces)].sort();
  const undeclared = styled.filter((s) => !declared.includes(s));
  const unstyled = declared.filter((s) => !styled.includes(s));
  if (undeclared.length > 0 || unstyled.length > 0) {
    throw new ThemeError(
      `themes/${slug}/theme.json: "surfaces" does not match theme.css.` +
        (undeclared.length
          ? `\n  styled but not declared: ${undeclared.join(", ")}`
          : "") +
        (unstyled.length
          ? `\n  declared but not styled: ${unstyled.join(", ")}`
          : "") +
        `\nThe manifest is how a reviewer sees a theme's reach without reading its CSS; it has to be ` +
        `accurate to be worth anything.`,
    );
  }

  // ── …and about the fonts it ships, in both directions ─────────────────────
  // Read from each @font-face's `src`, not by searching the file for the name,
  // which a comment satisfies. `data:` sources carry no file to declare.
  const loaded = new Set<string>();
  root.walkAtRules("font-face", (at: AtRule) => {
    at.walkDecls("src", (decl: Declaration) => {
      for (const m of decl.value.matchAll(URL_REF)) {
        if (!m[1].trim().startsWith("data:")) loaded.add(assetPath(m[1]));
      }
    });
  });
  const manifestFonts = new Set(declaredFonts.map(assetPath));
  for (const file of manifestFonts) {
    if (!loaded.has(file)) {
      throw new ThemeError(
        `themes/${slug}/theme.json: fonts[] declares "${file}", but no @font-face in ` +
          `theme.css loads it. A font file shipped to every user and never used is pure weight.`,
      );
    }
  }
  for (const file of loaded) {
    if (!manifestFonts.has(file)) {
      throw new ThemeError(
        `themes/${slug}/theme.css: an @font-face loads "${file}", which fonts[] in theme.json ` +
          `does not declare. The manifest is how a reviewer sees what a theme ships; a font ` +
          `missing from it is a dependency hidden from review. Add an entry with its family, ` +
          `file, weight and style.`,
      );
    }
  }

  // ── rewrite ───────────────────────────────────────────────────────────────
  const scope = `[data-theme="${slug}"]`;
  root.walkDecls((decl) => {
    if (decl.value.includes("url(")) decl.value = rewriteUrls(decl.value, slug);
  });
  root.walkRules((rule: Rule) => {
    if (rule.parent && (rule.parent as AtRule).name === "keyframes") return;
    rule.selectors = rule.selectors.map((raw) => {
      const sel = norm(raw);
      if (sel === TOKEN_SELECTOR) return scope;
      return `${scope} ${sel}`;
    });
  });

  const swatches: ThemeSwatch[] = SWATCH_TOKENS.filter((t) =>
    resolved.has(t),
  ).map((token) => ({ token, value: resolved.get(token)! }));

  const typefaces: ThemeTypeface[] = TYPEFACE_ROLES.filter((r) =>
    resolved.has(r.token),
  ).map((r) => {
    const stack = resolved.get(r.token)!;
    return {
      token: r.token,
      label: r.label,
      family: primaryFamily(stack),
      stack,
    };
  });

  return {
    tokens: Object.fromEntries(resolved),
    css: root.toString(),
    surfaces: styled,
    swatches,
    typefaces,
    report,
  };
}

/** Re-exported so the generator can echo the token contract in its output. */
export { REQUIRED_TOKENS, KIND_OF };
