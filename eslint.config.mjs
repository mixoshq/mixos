/* This Source Code Form is subject to the terms of the Mozilla Public
 * License, v. 2.0. If a copy of the MPL was not distributed with this
 * file, You can obtain one at https://mozilla.org/MPL/2.0/. */

import { defineConfig, globalIgnores } from "eslint/config";
import nextVitals from "eslint-config-next/core-web-vitals";
import nextTs from "eslint-config-next/typescript";
import noLowContrastTokenPairs from "./eslint-rules/no-low-contrast-token-pairs.mjs";
import appImports from "./eslint-rules/app-imports.mjs";

/**
 * Why each containment ban exists, worded the same as the registry generator's
 * scan (scripts/app-containment.ts) so the editor and the build agree.
 */
const CONTAINMENT = {
  env: "Apps must not read the process environment — it carries the platform's own secrets. Declare what you need under `env` in app.json and read it as context.env.<KEY>.",
  network:
    "Apps must not reach the network directly — that is the SSRF hole. Use context.http (bounded by the manifest's `egress` allowlist, with a resolve-and-recheck against private ranges), or a connector for a fixed upstream.",
  html: "Apps must not render markup they did not author. Render Markdown with <Markdown> from @/components/ui/markdown.",
  code: "Apps must not run a string as code.",
};

/**
 * Every file an app can run, whatever it is written in. A rule scoped to
 * `{ts,tsx}` alone would wave a `.js` or `.mjs` file straight past it, and the
 * generator's scan reads all of these.
 */
const APP_SOURCE = "apps/**/*.{ts,tsx,mts,cts,js,jsx,mjs,cjs}";

const PALETTE_MESSAGE =
  "Raw palette colours dodge the contrast guarantee. Use semantic tokens: text-foreground, text-muted-foreground, text-success, text-warning, text-destructive, bg-card, bg-muted, bg-primary. See docs/apps/ux.md#color--contrast.";
const OPAQUE_FILL_MESSAGE =
  "An opaque bg-white / bg-black is a theme surface in disguise. Use bg-card, bg-background, or bg-muted. Alpha over a known ground (bg-white/10, bg-black/70) is fine and is not flagged.";
const DARK_VARIANT_MESSAGE =
  "There is no dark: variant to write — a theme has one palette, and a dark look is a different theme (MixOS / MixOS Dark). Drop the variant and use a semantic token; it resolves per theme, and the build verifies every theme. See docs/themes/contrast.md.";

/**
 * The secrets the server reads through src/lib/env/secrets.ts, which
 * `readSecret()` holds once `process.env` no longer does. Kept equal to
 * `mixosSecretNames()` by src/lib/env/secrets.test.ts.
 */
export const SECRET_NAMES = [
  "CONNECTOR_ENCRYPTION_KEY",
  "USER_OAUTH_ENCRYPTION_KEY",
  "MCP_TOKEN_KEY",
  "APP_API_KEY_SECRET",
  "APP_SETTINGS_ENCRYPTION_KEY",
  "APP_UNLOCK_SECRET",
  "GITHUB_APP_ENCRYPTION_KEY",
  "AUTH_SECRET",
  "CRON_SECRET",
  "VAPID_PRIVATE_KEY",
  "DATABASE_URL",
  "POSTGRES_URL",
  "PGPASSWORD",
];
const SECRET_PATTERN = `/^(?:${SECRET_NAMES.join("|")})$/`;
const SECRET_MESSAGE =
  "The server takes its secrets out of process.env when it starts. Read this one with readSecret() from @/lib/env/secrets.";
const SECRET_FENCE = [
  {
    selector: `MemberExpression[object.type='MemberExpression'][object.object.name='process'][object.property.name='env'][property.name=${SECRET_PATTERN}]`,
    message: SECRET_MESSAGE,
  },
  {
    selector: `MemberExpression[object.type='MemberExpression'][object.object.name='process'][object.property.name='env'][computed=true][property.value=${SECRET_PATTERN}]`,
    message: SECRET_MESSAGE,
  },
];

/**
 * The colour fence, as `no-restricted-syntax` selectors. Why each one exists
 * is written at the design-system block below.
 *
 * A constant because more than one block sets `no-restricted-syntax` for app
 * `.tsx` files, and flat config REPLACES a rule's options rather than merging
 * them: a later block that sets the rule must restate these, or it switches
 * them off for every file it matches.
 */
const COLOUR_FENCE = [
  {
    selector:
      "Literal[value=/(?:^|[\\s\"'`:])(?:text|bg|border|ring|fill|stroke|from|to|via|divide)-(?:slate|gray|zinc|neutral|stone|red|orange|amber|yellow|lime|green|emerald|teal|cyan|sky|blue|indigo|violet|purple|fuchsia|pink|rose)-\\d{2,3}(?![\\w\\/-])/]",
    message: PALETTE_MESSAGE,
  },
  {
    selector:
      "TemplateElement[value.raw=/(?:^|[\\s\"'`:])(?:text|bg|border|ring|fill|stroke|from|to|via|divide)-(?:slate|gray|zinc|neutral|stone|red|orange|amber|yellow|lime|green|emerald|teal|cyan|sky|blue|indigo|violet|purple|fuchsia|pink|rose)-\\d{2,3}(?![\\w\\/-])/]",
    message: PALETTE_MESSAGE,
  },
  {
    selector: "Literal[value=/(?:^|[\\s\"'`:])bg-(?:white|black)(?![\\w\\/-])/]",
    message: OPAQUE_FILL_MESSAGE,
  },
  {
    selector:
      "TemplateElement[value.raw=/(?:^|[\\s\"'`:])bg-(?:white|black)(?![\\w\\/-])/]",
    message: OPAQUE_FILL_MESSAGE,
  },
  {
    selector: "Literal[value=/(?:^|[\\s\"'`:])dark:/]",
    message: DARK_VARIANT_MESSAGE,
  },
  {
    selector: "TemplateElement[value.raw=/(?:^|[\\s\"'`:])dark:/]",
    message: DARK_VARIANT_MESSAGE,
  },
];

const eslintConfig = defineConfig([
  ...nextVitals,
  ...nextTs,
  // Override default ignores of eslint-config-next.
  globalIgnores([
    // Default ignores of eslint-config-next:
    ".next/**",
    "out/**",
    "build/**",
    "next-env.d.ts",
    // The bundled release step (`npm run build:ops`): generated, gitignored,
    // and linted at its source in scripts/.
    "ops/**",
    // Installs from the Registry waiting to be registered: someone else's
    // code, checked by the install's own check and by the build once it is
    // registered, and never part of this project until then.
    ".mixos/**",
  ]),
  // ── Security: what app code may import ──
  //
  // App code imports its own files, the platform modules on a published list
  // and a few packages, and nothing else; it loads no module any other way
  // (`require`, `module`, a computed `import()`, `import.meta`, a bundler's own
  // loader); it calls callAppRoute only with its own slug; and it writes to
  // nothing it imported. An import is judged by the file it lands on, so no
  // spelling (`@/lib/db/../db/client`, a relative path into src/) gets round it.
  //
  // An allowlist, in one rule, rather than `no-restricted-imports` blocks: a
  // denylist of spellings would have to restate itself in every tier, because
  // flat config replaces a rule's options. The rule runs
  // src/lib/apps/import-policy.mjs, the same code the registry generator runs on
  // every build and every Registry install (scripts/app-containment.ts), so the
  // editor and the build cannot drift. The page/widget → lib/server tier rule is
  // part of the policy.
  {
    files: [APP_SOURCE],
    plugins: { "mixos-apps": { rules: { "app-imports": appImports } } },
    rules: { "mixos-apps/app-imports": "error" },
  },
  // ── Design system: apps use semantic colour tokens, never raw palette ──
  // Two rules, one reason.
  //
  // 1. RAW PALETTE COLOURS DODGE THE CONTRAST GUARANTEE. The tokens in
  //    globals.css are verified to clear WCAG AA in both directions; a
  //    `text-emerald-600` is not. That specific class was used 18 times in this
  //    repo at 3.76:1 — below the 4.5:1 floor for body text. Use text-success /
  //    text-warning / text-destructive / text-muted-foreground instead.
  //
  // 2. THERE IS NO `dark:` VARIANT TO WRITE. A theme declares ONE palette, and
  //    a dark look is a different theme an admin selects — MixOS and
  //    MixOS Dark are two themes, not two modes of one. So a `dark:` variant
  //    is not "the wrong place to fork colour", it is a fork with nothing on the
  //    other side: it hard-codes a second answer somewhere the contrast gate
  //    cannot see, and it is wrong the moment a third theme appears.
  //
  // WHY src/ IS IN SCOPE. Any installed theme can be dark, so the platform's own
  // chrome renders under every palette an app does, and a raw palette utility
  // or a `dark:` variant there fails the same way. The platform is held to the
  // rule it sets for apps.
  //
  // OPAQUE FILLS ONLY. `bg-white/10` as a hover on a navy panel and
  // `bg-black/70` as a modal scrim are alpha over a *known* ground and stay
  // legal — a rule that flagged those would be a rule people rightly ignore.
  // What's banned is an opaque fill pretending to be a theme surface.
  //
  // KNOWN LIMITATION: this reads string literals and template chunks, so it
  // cannot see a class assembled at runtime (`` `text-${tone}-600` ``). It
  // catches the common case; `/mixos app review <slug>` covers the rest by
  // reading the code.
  //
  // See docs/apps/ux.md and apps/AGENTS.md invariant 22.
  {
    files: ["apps/**/*.{ts,tsx}", "src/**/*.{ts,tsx}"],
    rules: {
      "no-restricted-syntax": ["error", ...COLOUR_FENCE],
    },
  },
  // ── Secrets: through src/lib/env/secrets.ts, never process.env ─────────────
  //
  // The server takes its secrets out of process.env when it starts, so a read
  // there finds nothing in production while it works in every test and script.
  // readSecret() reads where they are. src/lib/env/secrets.test.ts holds the
  // same list to mixosSecretNames(), and checks the tree too, since lint runs
  // only where someone runs it.
  //
  // RESTATES the colour fence, for the reason given at COLOUR_FENCE.
  {
    files: ["src/**/*.{ts,tsx}"],
    ignores: ["src/lib/env/secrets.ts", "src/**/*.test.ts"],
    rules: {
      "no-restricted-syntax": ["error", ...COLOUR_FENCE, ...SECRET_FENCE],
    },
  },
  // ── Containment: an app reaches the environment and the network by declaration ──
  //
  // `process.env` in app code can read CONNECTOR_ENCRYPTION_KEY and
  // DATABASE_URL — the key that decrypts every third-party credential and the
  // connection string that owns every table. `context.env` can read only what
  // the manifest declared and an admin filled in.
  //
  // A raw `fetch` in app code is an SSRF hole (docs/security-architecture.md
  // §13): it can reach anything the server can. `context.http` checks the
  // hostname against the manifest's `egress`, resolves it, re-checks every
  // returned address, and repeats both on each redirect hop. Fixed,
  // admin-configured hosts belong in a connector instead.
  //
  // Markup the app did not author is an XSS sink; Markdown renders through
  // <Markdown> from @/components/ui/markdown. And a string run as code is the
  // way round all of the above.
  //
  // NONE OF THIS IS ESCAPABLE. These rules are the editor's copy of the
  // containment scan in scripts/app-containment.ts, which the registry
  // generator runs on every build and every Registry install — lint runs only
  // on pull requests to this repository, so the generator's copy is the one
  // that holds. Keep the two lists in step. See
  // docs/plans/20261005_2150-app-escapes.md.
  //
  // How code is LOADED — `require`, `module`, `import()` and the rest — is the
  // import policy's, and mixos-apps/app-imports above reports it with the scan's
  // own words.
  //
  // Only this block sets these rules for apps/**, so nothing here is replaced
  // by a later block's options. Every app source extension, `.js` included,
  // because the scan reads every one.
  {
    files: [APP_SOURCE],
    rules: {
      "no-restricted-properties": [
        "error",
        ...["globalThis", "window", "self", "global"].flatMap((object) => [
          { object, property: "process", message: CONTAINMENT.env },
          { object, property: "fetch", message: CONTAINMENT.network },
          { object, property: "WebSocket", message: CONTAINMENT.network },
          { object, property: "EventSource", message: CONTAINMENT.network },
          { object, property: "XMLHttpRequest", message: CONTAINMENT.network },
          { object, property: "eval", message: CONTAINMENT.code },
          { object, property: "Function", message: CONTAINMENT.code },
        ]),
        { property: "innerHTML", message: CONTAINMENT.html },
        { property: "outerHTML", message: CONTAINMENT.html },
        { property: "insertAdjacentHTML", message: CONTAINMENT.html },
        { object: "document", property: "write", message: CONTAINMENT.html },
        { object: "document", property: "writeln", message: CONTAINMENT.html },
      ],
      "no-restricted-globals": [
        "error",
        { name: "process", message: CONTAINMENT.env },
        { name: "fetch", message: CONTAINMENT.network },
        { name: "WebSocket", message: CONTAINMENT.network },
        { name: "EventSource", message: CONTAINMENT.network },
        { name: "XMLHttpRequest", message: CONTAINMENT.network },
      ],
      "no-eval": "error",
      "no-implied-eval": "error",
      "no-new-func": "error",
    },
  },
  // react/no-danger, for the same files less `.cjs`: the React plugin is only
  // registered for the extensions eslint-config-next lints.
  {
    files: ["apps/**/*.{ts,tsx,mts,cts,js,jsx,mjs}"],
    rules: { "react/no-danger": "error" },
  },
  // ── Design system: apps compose from the primitives, not from raw elements ──
  //
  // A hand-rolled `<button>` is where ux.md's rules go to die: the pending state
  // nobody remembered, the focus ring somebody restyled away, the icon button
  // with no accessible name. A hand-rolled `<table>` loses the card chrome its
  // skeleton must mirror and pushes the page into horizontal scroll. A bare
  // `<input>` has no label wired to it.
  //
  // None of that is a review problem any more. `Button` takes `busy` and makes
  // the disabled/spinner/aria-busy trio one fact; `IconButton` requires a
  // `label`; `Field` owns the id so `htmlFor` cannot point at nothing;
  // `DataTable` ships `TableSkeleton` built from the same constants.
  //
  // The 86 hand-rolled `rounded-xl border border-border bg-card` shells that
  // drifted across 16 apps are the other half: `Card`/`SectionCard` export
  // CARD_SHELL, and a literal copy of it is now an error rather than the 87th.
  //
  // RESTATES the colour fence. This block sets no-restricted-syntax for
  // apps/**/*.tsx, and flat config replaces a rule's options rather than
  // merging them, so on its own it switched the palette, opaque-fill and
  // `dark:` checks off for every widget and page — the files they were written
  // for — while app .ts files and src/ kept them.
  {
    files: ["apps/**/*.tsx"],
    rules: {
      "no-restricted-syntax": [
        "error",
        ...COLOUR_FENCE,
        {
          selector: "JSXOpeningElement[name.name='button']",
          message:
            "Use <Button> / <IconButton> from @/components/ui/button. A raw <button> loses the busy state (ux.md requires one), the focus ring, and — for an icon button — the accessible name.",
        },
        {
          selector: "JSXOpeningElement[name.name='input']",
          message:
            "Use <Input> / <Checkbox> / <Switch> from @/components/ui/input, inside a <Field> from @/components/ui/field. Field owns the id, so the label can never point at nothing.",
        },
        {
          selector: "JSXOpeningElement[name.name='select']",
          message: "Use <Select> from @/components/ui/input, inside a <Field>.",
        },
        {
          selector: "JSXOpeningElement[name.name='textarea']",
          message:
            "Use <Textarea> from @/components/ui/input, inside a <Field>.",
        },
        {
          selector: "JSXOpeningElement[name.name='table']",
          message:
            "Use <DataTable> from @/components/ui/data-table. It owns the card chrome, the horizontal scroll container, and a TableSkeleton built from the same constants — a hand-rolled table's skeleton drifts from it immediately.",
        },
        {
          // Any radius, not just rounded-xl: the drift this rule exists to stop
          // arrived as rounded-lg and rounded-md, which the xl-only pattern
          // waved straight through.
          selector:
            "Literal[value=/rounded-(?:md|lg|xl|2xl|3xl)\\s+border\\s+border-border\\s+bg-card/]",
          message:
            "That is CARD_SHELL. Use <Card> or <SectionCard> from @/components/ui — hand-rolled copies of this string drifted on radius, padding, header size and heading level. Cards are flat (no shadow-*) and inset by p-5. A bordered group INSIDE a card is a different thing: rounded-md border border-border p-4, no bg-card. See docs/apps/app-shell.md#cards-one-shell-per-thing-and-every-card-says-who-owns-it.",
        },
      ],
    },
  },
  // ── Design system: token pairs are verified by measurement, not by name ──
  // The rule above checks *which* colours you used. This one checks what they
  // come out to when combined on one element — the gap that let ~200 sub-AA
  // elements across 16 apps pass CI. Read the rule file for the measurements and
  // the deliberate blind spots.
  //
  // ERROR. It shipped as a warning because it flagged ~215 pre-existing elements
  // across 16 apps whose fix was a visual decision for each app's owner. Those
  // apps are not in this repository, so the backlog the exemption existed for no
  // longer exists — and a floor that only warns is not a floor.
  //
  // src/ is in scope too: a floor the platform's own components don't clear is
  // not a floor.
  {
    files: ["apps/**/*.{ts,tsx}", "src/**/*.{ts,tsx}"],
    plugins: {
      "mixos-design": {
        rules: { "no-low-contrast-token-pairs": noLowContrastTokenPairs },
      },
    },
    rules: { "mixos-design/no-low-contrast-token-pairs": "error" },
  },
]);

export default eslintConfig;
