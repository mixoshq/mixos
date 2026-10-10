/* This Source Code Form is subject to the terms of the Mozilla Public
 * License, v. 2.0. If a copy of the MPL was not distributed with this
 * file, You can obtain one at https://mozilla.org/MPL/2.0/. */

/**
 * ESLint rule: no-low-contrast-token-pairs
 *
 * WHY THIS EXISTS. `src/app/globals.css` verifies every semantic colour token
 * "in BOTH directions — as text on the page background, and as a surface
 * carrying its own foreground." What it never verified is **token on token**.
 * So two individually-legal tokens can combine into an element that fails
 * WCAG AA, and the existing colour rule — which matches token *names* — sees
 * nothing wrong, because nothing is wrong with either name.
 *
 * The measured result, across `apps/` at the time this rule was written:
 *
 *   text-muted-foreground on bg-muted          4.34:1   135 elements, 16 apps
 *   text-warning     on bg-warning/10          4.39:1
 *   text-destructive on bg-destructive/10      4.13:1    68 elements, 11 apps
 *   text-destructive on bg-muted               4.41:1
 *   text-muted-foreground/70 (any ground)      2.71:1
 *
 * Roughly 200 sub-AA elements, all green in CI. Note how close to legal several
 * of those are: `text-success` on `bg-success/10` is **4.78:1 and passes**,
 * while the same construction in warning fails at 4.39:1. That is the real
 * argument for a rule over a doc. Nobody can eyeball a 0.4 difference, and a
 * convention that requires computing a ratio by hand every time will not be
 * followed — the author of this rule broke it four times in one app while
 * actively auditing for it.
 *
 * WHAT IT DOES. Ratios are computed, not tabulated. Token values are read from
 * `src/generated/theme-tokens.json`, emitted by the registry generator, so the
 * rule can never disagree with the theme: re-tone a token and the rule
 * re-derives on the next generate.
 *
 * It lints against EVERY installed theme. Which theme is *active* is a database
 * value the build cannot know, so an element has to clear the floor under each
 * palette it could be rendered in. It used to read only the fallback theme, so
 * a combination that failed under `mixos-dark`, or under a theme you authored,
 * was never reported. scripts/theme-css.ts verifies each palette wholesale;
 * this rule exists for the one thing that pass cannot see, which is which two
 * tokens a given element puts together.
 *
 * Two checks:
 *
 *   1. PAIR — an element that sets both a `bg-*` and a `text-*` token. The
 *      background is composited over each theme's own page background when it
 *      carries alpha; the ratio must clear 4.5:1, or 3:1 for text that WCAG
 *      counts as large.
 *   2. DIM — a text token dimmed by `/N` or a bare `opacity-N`. There is no
 *      ground on which this passes: `muted-foreground` **is** the dimmed step of
 *      the ladder, and dimming it again lands at 2.71:1.
 *
 * DELIBERATE NON-COVERAGE, so nobody reads a clean run as proof:
 *
 *   - Classes assembled at runtime (`` `bg-${tone}/10` ``) are invisible, as
 *     they are to the existing colour rule.
 *   - Constants imported from another module are invisible; a class list that
 *     lives in one string literal is checked wherever that literal is written.
 *   - `disabled:`-prefixed states are skipped: WCAG 1.4.3 exempts inactive
 *     controls, and flagging `disabled:opacity-60` would train people to ignore
 *     the rule.
 *   - An element with no `bg-*` of its own is not pair-checked. Assuming a white
 *     ground would flag every `text-primary-foreground` inside a navy panel,
 *     which is correct code.
 *   - Non-text pairs (`border-*` on `bg-*`, 3:1) are not checked.
 *
 * Variants are resolved per state rather than pooled, so `hover:bg-muted` is
 * checked against the text colour that applies *while hovering* — which is how
 * `text-muted-foreground hover:bg-muted hover:text-foreground` comes out clean
 * and `text-muted-foreground hover:bg-muted` comes out flagged.
 *
 * See docs/apps/ux.md#verified-pairs-two-legal-tokens-can-make-an-illegal-element and apps/AGENTS.md invariant 22.
 */

import { readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { dirname, resolve } from "node:path";

const THEME_TOKENS = resolve(
  dirname(fileURLToPath(import.meta.url)),
  "../src/generated/theme-tokens.json",
);

// ── colour maths ────────────────────────────────────────────────────────────

function hexToRgb(hex) {
  const h = hex.length === 4 ? `#${hex[1]}${hex[1]}${hex[2]}${hex[2]}${hex[3]}${hex[3]}` : hex;
  return [1, 3, 5].map((i) => parseInt(h.slice(i, i + 2), 16));
}

function relativeLuminance([r, g, b]) {
  const lin = (c) => {
    const v = c / 255;
    return v <= 0.03928 ? v / 12.92 : ((v + 0.055) / 1.055) ** 2.4;
  };
  return 0.2126 * lin(r) + 0.7152 * lin(g) + 0.0722 * lin(b);
}

function contrast(a, b) {
  const [hi, lo] = [relativeLuminance(a), relativeLuminance(b)].sort((x, y) => y - x);
  return (hi + 0.05) / (lo + 0.05);
}

/** Alpha-composite `fg` at `alpha` over the opaque `bg`. */
function composite(fg, bg, alpha) {
  return fg.map((c, i) => Math.round(c * alpha + bg[i] * (1 - alpha)));
}

// ── token tables, from the generated theme registry ─────────────────────────

/**
 * Every installed theme's colours, slug → Map(token → rgb), from the `tokens`
 * object of theme-tokens.json. The theme compiler has already followed `var()`
 * chains and writes every colour as `#rrggbb`, whatever the theme wrote, so a
 * hex is all this reads; anything else (a radius, a font stack) is not a colour.
 *
 * @param {Record<string, Record<string, unknown>> | undefined} tokensBySlug
 * @returns {Map<string, Map<string, number[]>> | null}
 */
export function palettesFrom(tokensBySlug) {
  const palettes = new Map();
  for (const [slug, values] of Object.entries(tokensBySlug ?? {})) {
    const tokens = new Map();
    for (const [name, value] of Object.entries(values ?? {})) {
      if (typeof value === "string" && /^#(?:[0-9a-f]{3}|[0-9a-f]{6})$/i.test(value)) {
        tokens.set(name, hexToRgb(value));
      }
    }
    if (tokens.size > 0) palettes.set(slug, tokens);
  }
  return palettes.size > 0 ? palettes : null;
}

let PALETTES = null;
try {
  PALETTES = palettesFrom(JSON.parse(readFileSync(THEME_TOKENS, "utf8")).tokens);
} catch {
  PALETTES = null;
}
if (PALETTES == null) {
  // A no-op beats a crash: a broken parse must not take editor linting with it.
  // Loud enough to notice in CI output, quiet enough not to fail the run.
  console.warn(
    "[no-low-contrast-token-pairs] could not read src/generated/theme-tokens.json — run `npm run registry`. The contrast check is inactive until you do.",
  );
}

const WHITE = [255, 255, 255];

/**
 * A few tokens are defined against a ground that is NOT the page background.
 * `--brand-foreground` and `--brand-accent` exist to sit on `--brand` — the
 * menu bar, the login page, a branded panel — which the theme contract requires
 * to be a surface dark enough to carry them (scripts/theme-css.ts verifies
 * `brand-foreground/brand` at 4.5:1 in every theme).
 *
 * Without this, `text-brand-foreground/70` on the menu bar measures against
 * white and reports 1.03:1 — a false positive on markup that is correct, and
 * the kind of noise that gets a whole rule disabled.
 */
const GROUND_TOKEN_FOR = {
  "brand-foreground": "brand",
  "brand-accent": "brand",
};

/**
 * The ground a token is defined against in one palette: that theme's page
 * background for almost everything, its `--brand` for the two that exist to
 * sit on the brand surface. An alpha fill is composited over it.
 *
 * This applies to a *fill* as much as to text. `bg-brand-foreground/10` is the
 * menu bar's own hover tint — a 10% wash of the bar's text colour over the bar
 * — so compositing it over the page background reports a near-white fill that
 * nothing on the bar could sit on.
 */
function groundFor(token, palette) {
  const via = GROUND_TOKEN_FOR[token];
  return (via && palette.get(via)) ?? palette.get("background") ?? WHITE;
}

// ── class parsing ───────────────────────────────────────────────────────────

/** px per Tailwind font-size step, for the WCAG large-text threshold. */
const FONT_PX = {
  "text-xs": 12,
  "text-sm": 14,
  "text-base": 16,
  "text-lg": 18,
  "text-xl": 20,
  "text-2xl": 24,
  "text-3xl": 30,
  "text-4xl": 36,
  "text-5xl": 48,
  "text-6xl": 60,
  "text-7xl": 72,
  "text-8xl": 96,
  "text-9xl": 128,
};
const BOLD = new Set(["font-semibold", "font-bold", "font-extrabold", "font-black"]);

/** WCAG exempts inactive controls, so these states are not evaluated. */
const EXEMPT_VARIANTS = /(?:^|:)(?:disabled|aria-disabled|group-disabled|peer-disabled)$/;

/** `hover:bg-muted/50` → `{ variant: "hover", base: "bg-muted", alpha: 0.5 }` */
function parseClass(cls) {
  const lastColon = cls.lastIndexOf(":");
  const variant = lastColon === -1 ? "" : cls.slice(0, lastColon);
  const bare = lastColon === -1 ? cls : cls.slice(lastColon + 1);
  const slash = bare.lastIndexOf("/");
  if (slash === -1) return { variant, base: bare, alpha: 1 };
  const n = Number(bare.slice(slash + 1));
  if (!Number.isFinite(n)) return { variant, base: bare, alpha: 1 };
  return { variant, base: bare.slice(0, slash), alpha: n / 100 };
}

/** The class as the author wrote it, alpha included — so the message quotes real code. */
function written(p) {
  return p.alpha === 1 ? p.base : `${p.base}/${Math.round(p.alpha * 100)}`;
}

/**
 * Groups a class list into the states it produces: the resting state, plus one
 * per variant, each inheriting from resting. `known` is every colour token any
 * installed theme sets.
 */
function statesFor(classString, known) {
  const parsed = classString
    .split(/\s+/)
    .filter(Boolean)
    .map(parseClass)
    .filter((p) => !EXEMPT_VARIANTS.test(p.variant));

  const resting = { text: null, bg: null, opacity: null, px: 16, bold: false };
  const variants = new Map();

  for (const p of parsed) {
    const target =
      p.variant === ""
        ? resting
        : (variants.get(p.variant) ?? variants.set(p.variant, {}).get(p.variant));

    if (FONT_PX[p.base] != null) {
      target.px = FONT_PX[p.base];
    } else if (BOLD.has(p.base)) {
      target.bold = true;
    } else if (p.base.startsWith("text-")) {
      const token = p.base.slice(5);
      if (known.has(token)) target.text = { token, alpha: p.alpha, cls: written(p) };
    } else if (p.base.startsWith("bg-")) {
      const token = p.base.slice(3);
      // An unknown fill (bg-cat-1, bg-[#fff], a Tailwind palette class the other
      // rule already flags) means an unknown ground — better silent than wrong.
      target.bg = known.has(token) ? { token, alpha: p.alpha, cls: written(p) } : "unknown";
    } else if (/^opacity-\d+$/.test(p.base)) {
      target.opacity = Number(p.base.slice(8)) / 100;
    }
  }

  const states = [{ name: "", ...resting }];
  for (const [name, over] of variants) {
    states.push({ name, ...resting, ...over });
  }
  return states;
}

function isLarge(state) {
  return state.px >= 24 || (state.px >= 18.66 && state.bold);
}

/**
 * The "raise the text colour" half of the fix, **computed rather than assumed**.
 *
 * The obvious phrasing — "use the fill's own foreground, `text-<fill>-foreground`"
 * — is wrong for the single most common failure this rule finds. `bg-muted` with
 * `text-muted-foreground` is 4.34:1, and `muted-foreground` *is* literally
 * `<fill>-foreground`, so that advice hands back the failing pair. (The genuinely
 * verified pairs for that surface are `bg-secondary text-secondary-foreground` and
 * `bg-accent text-accent-foreground`, whose fills happen to be the same colour.)
 *
 * So the candidates are measured: the fill's own foreground, then plain
 * `text-foreground`, and only a candidate that clears the floor under every
 * theme that sets the fill is suggested.
 */
function swapSuggestion(state, palettes) {
  const floor = isLarge(state) ? 3 : 4.5;
  for (const token of [`${state.bg.token}-foreground`, "foreground"]) {
    if (token === state.text.token) continue;
    let worst = Infinity;
    for (const palette of palettes.values()) {
      const bg = palette.get(state.bg.token);
      if (bg == null) continue; // this theme does not set the fill
      const rgb = palette.get(token);
      if (rgb == null) {
        worst = 0;
        break;
      }
      const fill = composite(bg, groundFor(state.bg.token, palette), state.bg.alpha);
      worst = Math.min(worst, contrast(rgb, fill));
    }
    if (worst !== Infinity && worst >= floor) {
      const at = palettes.size > 1
        ? `at least ${worst.toFixed(2)}:1 under every installed theme`
        : `${worst.toFixed(2)}:1`;
      return `keep the fill and raise the text to \`text-${token}\` (${at})`;
    }
  }
  return "keep the fill and raise the text to a token that clears the floor on it";
}

/**
 * What one state's text comes out to under one theme's palette, or null when
 * that palette does not set a token the state uses — an optional token, such
 * as `--brand-cyan`, that only some themes declare. `thinned` is the combined
 * alpha of a dimmed text token, or null for a plain pair.
 */
function ratioUnder(palette, state, thinned) {
  const text = palette.get(state.text.token);
  if (text == null) return null;
  // The element's own fill when it has one; otherwise the ground the alpha
  // maths assumes. An element with no fill of its own isn't pair-checked at
  // all (see the header), but a *dimmed* token fails on any light ground.
  let ownFill = null;
  if (state.bg != null && state.bg !== "unknown") {
    const bg = palette.get(state.bg.token);
    if (bg == null) return null;
    ownFill = composite(bg, groundFor(state.bg.token, palette), state.bg.alpha);
  }
  if (thinned != null) {
    const ground = ownFill ?? groundFor(state.text.token, palette);
    return contrast(composite(text, ground, thinned), ground);
  }
  return ownFill == null ? null : contrast(text, ownFill);
}

/** "4.13:1 under mixos and 3.90:1 under mixos-dark" */
function measuredUnder(failing) {
  const parts = failing.map(({ slug, ratio }) => `${ratio.toFixed(2)}:1 under ${slug}`);
  return parts.length > 1
    ? `${parts.slice(0, -1).join(", ")} and ${parts[parts.length - 1]}`
    : parts[0];
}

/**
 * Failures in one class list, as `{ key, message }`. `key` identifies the
 * finding so the same one isn't reported twice for one element, and a finding
 * names every theme it fails under.
 */
function failuresIn(classString, palettes, known) {
  const out = [];
  const seen = new Set();
  const add = (key, message) => {
    if (seen.has(key)) return;
    seen.add(key);
    out.push({ key, message });
  };

  for (const state of statesFor(classString, known)) {
    const where = state.name === "" ? "" : ` in the \`${state.name}:\` state`;

    if (state.text == null) continue;
    const floor = isLarge(state) ? 3 : 4.5;

    // DIM is a text token thinned by /N or a bare opacity-N; otherwise this is
    // a PAIR, two opaque tokens on one element, and needs a fill of its own.
    const dim = state.text.alpha < 1 ? state.text.alpha : null;
    const faded = state.opacity != null && state.opacity < 1 ? state.opacity : null;
    const thinned = dim != null && faded != null ? dim * faded : (dim ?? faded);
    if (thinned == null && (state.bg == null || state.bg === "unknown")) continue;

    const failing = [];
    for (const [slug, palette] of palettes) {
      const ratio = ratioUnder(palette, state, thinned);
      if (ratio != null && ratio < floor) failing.push({ slug, ratio });
    }
    if (failing.length === 0) continue;

    if (thinned != null) {
      const how = faded != null
        ? `\`opacity-${Math.round(faded * 100)}\` on \`${state.text.cls}\``
        : `\`${state.text.cls}\``;
      add(
        `dim:${state.text.cls}:${thinned}`,
        `${how}${where} thins a colour token to ${measuredUnder(failing)} against its ground — under the ${floor}:1 floor. The token ladder already has a quiet step: use text-muted-foreground for secondary text, and don't dim *that* (text-muted-foreground/70 is 2.71:1). See docs/apps/ux.md#never-dim-a-token.`,
      );
      continue; // a thinned token isn't also a clean pair
    }

    add(
      `pair:${state.text.cls}:${state.bg.cls}`,
      `\`${state.text.cls}\` on \`${state.bg.cls}\`${where} is ${measuredUnder(failing)} — under the ${floor}:1 floor. The theme build verifies each token against the page background and against its own foreground, never against another token, so this pair is legal by name and illegal by measurement. Fixes: drop the fill and keep the text colour on the page background; ${swapSuggestion(state, palettes)}; or carry the meaning with a label or \`StatusDot\` instead of a tint. See docs/apps/ux.md#verified-pairs-two-legal-tokens-can-make-an-illegal-element.`,
    );
  }
  return out;
}

// ── AST plumbing ────────────────────────────────────────────────────────────

/** Does this string plausibly contain Tailwind classes? Cheap pre-filter. */
const LOOKS_LIKE_CLASSES = /(?:^|\s)(?:text|bg|border|opacity|font)-[\w-]/;

/**
 * Every static string a className expression can produce. Conditionals branch
 * rather than pool, so `cond ? "bg-muted" : "text-muted-foreground"` isn't read
 * as an element that sets both.
 */
function variantsOf(node, depth = 0) {
  if (node == null || depth > 6) return [""];
  switch (node.type) {
    case "Literal":
      return [typeof node.value === "string" ? node.value : ""];
    case "JSXExpressionContainer":
      return variantsOf(node.expression, depth + 1);
    case "TemplateLiteral": {
      let acc = [""];
      node.quasis.forEach((q, i) => {
        const next = i < node.expressions.length ? variantsOf(node.expressions[i], depth + 1) : [""];
        acc = acc.flatMap((a) => next.map((n) => `${a}${q.value.cooked ?? ""} ${n}`));
      });
      return acc.slice(0, 24);
    }
    case "ConditionalExpression":
      return [
        ...variantsOf(node.consequent, depth + 1),
        ...variantsOf(node.alternate, depth + 1),
      ].slice(0, 24);
    case "LogicalExpression":
      // `cond && "..."` contributes its right side or nothing.
      return ["", ...variantsOf(node.right, depth + 1)].slice(0, 24);
    case "CallExpression": {
      // cn(...) / clsx(...) / twMerge(...): every argument lands on the element.
      let acc = [""];
      for (const arg of node.arguments) {
        const next = variantsOf(arg, depth + 1);
        acc = acc.flatMap((a) => next.map((n) => `${a} ${n}`)).slice(0, 24);
      }
      return acc;
    }
    default:
      return [""];
  }
}

/**
 * The rule, measuring against `palettes` (from `palettesFrom`, or null for
 * none). The default export measures every installed theme; this is exported
 * so a test can hand it fixture palettes instead.
 *
 * @param {Map<string, Map<string, number[]>> | null} palettes
 * @returns {import("eslint").Rule.RuleModule}
 */
export function createRule(palettes) {
  const known = new Set(
    palettes == null ? [] : [...palettes.values()].flatMap((p) => [...p.keys()]),
  );

  return {
    meta: {
      type: "problem",
      docs: {
        description:
          "Disallow same-element semantic colour token pairs that fall below the WCAG AA contrast floor.",
        url: "https://github.com/MixOSWork/mixos/blob/main/docs/apps/ux.md#verified-pairs-two-legal-tokens-can-make-an-illegal-element",
      },
      schema: [],
      messages: { lowContrast: "{{detail}}" },
    },
    create(context) {
      if (palettes == null) return {};
      /** Ranges of className attributes already handled, so literals inside them don't double-report. */
      const handled = [];

      const report = (node, failures) => {
        for (const f of failures) {
          context.report({ node, messageId: "lowContrast", data: { detail: f.message } });
        }
      };

      return {
        JSXAttribute(node) {
          if (node.name?.name !== "className" || node.value == null) return;
          handled.push(node.value.range);
          const strings = variantsOf(node.value);
          const failures = new Map();
          for (const s of strings) {
            if (!LOOKS_LIKE_CLASSES.test(s)) continue;
            for (const f of failuresIn(s, palettes, known)) failures.set(f.key, f);
          }
          report(node, [...failures.values()]);
        },
        Literal(node) {
          if (typeof node.value !== "string") return;
          if (!LOOKS_LIKE_CLASSES.test(node.value)) return;
          if (handled.some(([start, end]) => node.range[0] >= start && node.range[1] <= end)) return;
          report(node, failuresIn(node.value, palettes, known));
        },
      };
    },
  };
}

export default createRule(PALETTES);
