/* This Source Code Form is subject to the terms of the Mozilla Public
 * License, v. 2.0. If a copy of the MPL was not distributed with this
 * file, You can obtain one at https://mozilla.org/MPL/2.0/. */

/**
 * The token contract every theme must satisfy, and the surfaces a theme is
 * allowed to style.
 *
 * This file is the single source of truth read by the build-time validator
 * (scripts/theme-css.ts), the docs generator, and `/mix-theme`. Keeping one
 * list means the token set can never drift between what a theme is told to
 * declare, what the generator enforces, and what the UI actually consumes.
 *
 * The utility → variable mapping itself (`@theme inline`) stays in
 * src/app/globals.css and is NOT themeable: a theme supplies values, it can
 * never add or remove a Tailwind utility. That asymmetry is what keeps
 * `bg-card` meaning the same thing under every theme.
 */

export type TokenKind =
  /** A colour a theme must supply. */
  | "color"
  /** A length/scale value (e.g. --radius). */
  | "length"
  /** A font stack. */
  | "font";

export interface TokenSpec {
  name: string;
  kind: TokenKind;
  role: string;
}

/**
 * Every token a theme MUST define in its light block (and, if it declares dark
 * support, in its dark block too). A missing token aborts the build — an
 * undefined custom property does not fall back to something sensible, it
 * renders as `unset` and produces a transparent surface or invisible text.
 */
export const REQUIRED_TOKENS: TokenSpec[] = [
  { name: "background", kind: "color", role: "The page ground." },
  { name: "foreground", kind: "color", role: "Default body text." },
  { name: "card", kind: "color", role: "Raised surface: widgets, panels." },
  { name: "card-foreground", kind: "color", role: "Text on a card." },
  { name: "popover", kind: "color", role: "Menus, dropdowns, tooltips." },
  { name: "popover-foreground", kind: "color", role: "Text in a popover." },
  { name: "primary", kind: "color", role: "The primary action." },
  { name: "primary-foreground", kind: "color", role: "Label on a primary action." },
  { name: "secondary", kind: "color", role: "Secondary action surface." },
  { name: "secondary-foreground", kind: "color", role: "Label on a secondary action." },
  { name: "muted", kind: "color", role: "Recessed surface: table stripes, wells." },
  { name: "muted-foreground", kind: "color", role: "De-emphasised text, captions, help." },
  { name: "accent", kind: "color", role: "Hover/active surface for interactive rows." },
  { name: "accent-foreground", kind: "color", role: "Text on an accent surface." },
  { name: "destructive", kind: "color", role: "Errors and destructive actions." },
  { name: "destructive-foreground", kind: "color", role: "Label on a destructive surface." },
  { name: "success", kind: "color", role: "Success/healthy state." },
  { name: "success-foreground", kind: "color", role: "Label on a success surface." },
  { name: "warning", kind: "color", role: "Warning/degraded state." },
  { name: "warning-foreground", kind: "color", role: "Label on a warning surface." },
  { name: "cat-1", kind: "color", role: "Categorical ramp 1 — distinguishes, never grades." },
  { name: "cat-2", kind: "color", role: "Categorical ramp 2." },
  { name: "cat-3", kind: "color", role: "Categorical ramp 3." },
  { name: "cat-4", kind: "color", role: "Categorical ramp 4." },
  { name: "cat-5", kind: "color", role: "Categorical ramp 5." },
  { name: "cat-6", kind: "color", role: "Categorical ramp 6." },
  { name: "border", kind: "color", role: "Hairlines and dividers." },
  { name: "input", kind: "color", role: "Form control borders." },
  { name: "ring", kind: "color", role: "Focus ring. Never make this invisible." },
  { name: "brand", kind: "color", role: "The brand surface — the menu bar, the login page, a marketing panel." },
  { name: "brand-foreground", kind: "color", role: "Text on the brand surface." },
  { name: "brand-accent", kind: "color", role: "Accent ON the brand surface — never on the page ground." },
  { name: "radius", kind: "length", role: "Base corner radius; sm/md/lg derive from it." },
  // Named `--type-*`, not `--font-*`, on purpose. `--font-*` is Tailwind v4's
  // own theme namespace: a theme setting `--font-sans` would collide with the
  // key that DEFINES the `font-sans` utility rather than feed it. `@theme
  // inline` maps `--font-sans: var(--type-sans)`, so the utility resolves the
  // theme's stack per element at runtime.
  { name: "type-sans", kind: "font", role: "UI and body text." },
  { name: "type-heading", kind: "font", role: "Headings and the wordmark." },
  { name: "type-mono", kind: "font", role: "Code, terminal output, identifiers." },
];

/**
 * Tokens a theme MAY define. Absent ones fall back to a derived default.
 */
export const OPTIONAL_TOKENS: TokenSpec[] = [
  { name: "brand-cyan", kind: "color", role: "Literal brand colour, for large text and non-text accents." },
  { name: "brand-teal", kind: "color", role: "Literal brand colour, for large text and non-text accents." },
  { name: "brand-violet", kind: "color", role: "Literal brand colour, for large text and non-text accents." },
];

/**
 * Tokens a theme may never define.
 *
 * Empty today, and the check is kept rather than deleted: it is the hook for
 * any future value that must survive a theme change — an environment banner, a
 * legally-mandated colour. The list held `--brand-local` / `--brand-local-mark`
 * (the localhost menu-bar band) until that treatment was dropped in favour of
 * the theme rendering identically everywhere.
 */
export const FORBIDDEN_TOKENS = [] as const;

export type ContrastKind =
  /** Body text: WCAG AA, 4.5:1. */
  | "text"
  /** Large text (>=24px, or >=18.66px bold): 3:1. */
  | "large-text"
  /** Non-text UI: borders, focus rings, control boundaries. 3:1. */
  | "ui";

export const RATIO_FOR: Record<ContrastKind, number> = {
  text: 4.5,
  "large-text": 3,
  ui: 3,
};

export interface ContrastPair {
  /** Stable id — this is what an `escapes` entry names. */
  id: string;
  fg: string;
  bg: string;
  kind: ContrastKind;
  why: string;
}

/**
 * Every pair the generator verifies, in both the light and the dark block.
 *
 * Two directions are checked for each status colour, and that pairing is the
 * whole point: a status colour is used BOTH as text on the page ground
 * (`text-destructive`) and as a filled surface carrying its own foreground
 * (`bg-destructive text-destructive-foreground`). Passing one direction and
 * failing the other is the single most common way a palette ships unreadable —
 * it is exactly the bug the previous hardcoded `.dark` block carried unnoticed
 * for as long as that block was unreachable.
 *
 * `border` is deliberately NOT gated. WCAG 1.4.11 covers non-text contrast for
 * components that convey information or state; a hairline between two table
 * rows is decoration, and gating it at 3:1 would force every divider in the
 * product to a mid-slate that no design system actually ships. `input` IS
 * gated — a form control's boundary is what tells a user where the control is
 * — and so is `ring`, which is an accessibility floor rather than a taste.
 *
 * Note what is also NOT here: `muted-foreground` on `muted`. Two legal
 * tokens can still make an illegal element, and that combination is one of
 * them. It is caught per-element by eslint-rules/no-low-contrast-token-pairs,
 * because whether it occurs is a property of the markup, not of the theme.
 */
export const CONTRAST_PAIRS: ContrastPair[] = [
  { id: "foreground/background", fg: "foreground", bg: "background", kind: "text", why: "Body text on the page." },
  { id: "card-foreground/card", fg: "card-foreground", bg: "card", kind: "text", why: "Text on every widget and panel." },
  { id: "popover-foreground/popover", fg: "popover-foreground", bg: "popover", kind: "text", why: "Menu and dropdown items." },
  { id: "primary-foreground/primary", fg: "primary-foreground", bg: "primary", kind: "text", why: "The label on the primary button." },
  { id: "primary/background", fg: "primary", bg: "background", kind: "text", why: "`text-primary` links and emphasis." },
  { id: "secondary-foreground/secondary", fg: "secondary-foreground", bg: "secondary", kind: "text", why: "The label on a secondary button." },
  { id: "accent-foreground/accent", fg: "accent-foreground", bg: "accent", kind: "text", why: "A hovered row or menu item." },
  { id: "muted-foreground/background", fg: "muted-foreground", bg: "background", kind: "text", why: "Captions and help text on the page ground." },
  { id: "destructive/background", fg: "destructive", bg: "background", kind: "text", why: "`text-destructive` error copy." },
  { id: "destructive-foreground/destructive", fg: "destructive-foreground", bg: "destructive", kind: "text", why: "The label on a destructive button." },
  { id: "success/background", fg: "success", bg: "background", kind: "text", why: "`text-success` status copy." },
  { id: "success-foreground/success", fg: "success-foreground", bg: "success", kind: "text", why: "The label on a success surface." },
  { id: "warning/background", fg: "warning", bg: "background", kind: "text", why: "`text-warning` status copy." },
  { id: "warning-foreground/warning", fg: "warning-foreground", bg: "warning", kind: "text", why: "The label on a warning surface." },
  { id: "cat-1/background", fg: "cat-1", bg: "background", kind: "text", why: "Categorical series label." },
  { id: "cat-2/background", fg: "cat-2", bg: "background", kind: "text", why: "Categorical series label." },
  { id: "cat-3/background", fg: "cat-3", bg: "background", kind: "text", why: "Categorical series label." },
  { id: "cat-4/background", fg: "cat-4", bg: "background", kind: "text", why: "Categorical series label." },
  { id: "cat-5/background", fg: "cat-5", bg: "background", kind: "text", why: "Categorical series label." },
  { id: "cat-6/background", fg: "cat-6", bg: "background", kind: "text", why: "Categorical series label." },
  { id: "brand-foreground/brand", fg: "brand-foreground", bg: "brand", kind: "text", why: "The wordmark and nav labels on the menu bar, and the login page copy." },
  // Gated as large-text on purpose: `--brand-accent` is for emphasis on the
  // brand surface — a heading, a rule, a numeral — not for body copy. The
  // published MixOS cyan is 4.36:1 on the brand slate, which is exactly the
  // band where "legal at 24px, illegal at 14px" is the honest answer.
  { id: "brand-accent/brand", fg: "brand-accent", bg: "brand", kind: "large-text", why: "Accent headings and rules on the brand surface." },
  { id: "ring/background", fg: "ring", bg: "background", kind: "ui", why: "The focus ring must be visible — this one is an accessibility floor, not a preference." },
  { id: "input/card", fg: "input", bg: "card", kind: "ui", why: "A form control's boundary against the card it sits on." },
];

/**
 * The only selectors a theme may write beyond the token blocks.
 *
 * Themes get real expressive range — flat vs. glassy, sharp vs. soft — without
 * app internals becoming an accidental public API that a refactor silently
 * breaks. A theme may target these classes, their pseudo-classes
 * (`:hover`, `:focus-visible`, `:disabled`), their `[data-*]` states, and their
 * own descendants. Anything else is a build error.
 */
export const SURFACE_ALLOWLIST = [
  ".mix-app-shell",
  ".mix-menubar",
  ".mix-card",
  ".mix-widget",
  ".mix-page-header",
  ".mix-button",
  ".mix-input",
  ".mix-modal",
  ".mix-popover",
  ".mix-table",
] as const;

export type MixSurface = (typeof SURFACE_ALLOWLIST)[number];

export const ALL_TOKENS = [...REQUIRED_TOKENS, ...OPTIONAL_TOKENS];
export const TOKEN_NAMES = new Set(ALL_TOKENS.map((t) => t.name));
