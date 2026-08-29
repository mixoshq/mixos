/* This Source Code Form is subject to the terms of the Mozilla Public
 * License, v. 2.0. If a copy of the MPL was not distributed with this
 * file, You can obtain one at https://mozilla.org/MPL/2.0/. */

import { defineConfig, globalIgnores } from "eslint/config";
import nextVitals from "eslint-config-next/core-web-vitals";
import nextTs from "eslint-config-next/typescript";
import noLowContrastTokenPairs from "./eslint-rules/no-low-contrast-token-pairs.mjs";

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
  ]),
  // ── Security: prevent apps from bypassing the edge gateway ──
  // App widgets and pages must NOT import DB or connector modules directly.
  // Only app API routes (apps/**/api/**), service handlers (apps/**/services/**),
  // scheduled job handlers (apps/**/jobs/**), and the server-only data builders
  // they delegate to (apps/**/lib/server/**) are allowed to use connectors — all
  // run server-side behind the authenticated gateway. The lib/server/services
  // modules import connectors as `import type` only (erased at build time) and are
  // never imported by client pages/widgets.
  //
  // Jobs belong to this tier by construction: the platform scheduler invokes them
  // with a user-less SystemAppContext that carries tenant connectors, and they are
  // unreachable from the browser. They were omitted here originally, which is why
  // every job that types a connector off `ctx` reported a false positive.
  {
    files: ["apps/**/*.{ts,tsx}"],
    ignores: [
      "apps/**/api/**",
      "apps/**/lib/server/**",
      "apps/**/services/**",
      "apps/**/mcp/**",
      "apps/**/jobs/**",
    ],
    rules: {
      "no-restricted-imports": [
        "error",
        {
          patterns: [
            {
              group: ["@/lib/db", "@/lib/db/*"],
              message:
                "Direct DB access is not allowed in app code. Use createAppClient() from @/lib/apps/sdk to call your API routes instead.",
            },
            {
              group: ["@connectors/*"],
              message:
                "Direct connector imports are not allowed in app code. Connectors are available via AppContext in your API route handlers.",
            },
            {
              group: ["@/lib/connectors/*"],
              message:
                "Direct connector utility imports are not allowed in app code. Use createAppClient() from @/lib/apps/sdk.",
            },
            {
              group: ["@/lib/apps/services", "@/lib/apps/context"],
              message:
                "The App Services broker and context builder are platform-internal. Use the injected context.services client from your API route/service handler instead.",
            },
            {
              group: ["@/lib/apps/scoped-db"],
              // The NAMES, not the module: `import type { ScopedClient }` is how
              // an app types a handler that receives `context.db`, and a type
              // cannot construct anything. It is the factory that must not be
              // reachable.
              importNames: ["createScopedClient", "createReadOnlyScopedClient"],
              message:
                "Do not construct a scoped DB client. `createScopedClient(slug)` takes ANY slug and builds a service-role client for it, so an app could name another app's prefix and read or write its tables — the `_app_<slug>_` prefix only bounds the table name, never the app. Use the injected `context.db`, which the gateway pins to your own app. (`import type { ScopedClient }` is fine.)",
            },
          ],
        },
      ],
    },
  },
  // ── Security: a page or widget must not reach its app's own server tier ──
  //
  // `apps/**/lib/server/**` is allowlisted to import connectors, which is what
  // makes it the app's server tier. A page importing it reaches connectors and
  // the database WITHOUT passing the gateway — no auth-tier resolution, no role
  // gate, no input or output validation, no budget, no telemetry. That is the
  // second authorization surface Phase 1 existed to delete, and the reason
  // `docs/secure-edge-gateway-architecture.md` and `eslint.config.mjs`
  // contradicted each other for so long.
  //
  // A server page gets its data the same way a browser does — through its own
  // declared route:
  //
  //   const { items } = await callAppRoute("my-app", "GET /items", { limit: 20 });
  //
  // Same pipeline, no network hop. See docs/apps/api-routes.md#server-components.
  {
    files: ["apps/**/pages/**/*.{ts,tsx}", "apps/**/widgets/**/*.{ts,tsx}"],
    rules: {
      "no-restricted-imports": [
        "error",
        {
          patterns: [
            {
              group: ["**/lib/server/**", "**/lib/server"],
              message:
                'A page or widget must not import its app\'s server tier — that reaches connectors and the DB without the gateway (no roles, no validation, no budget, no telemetry). Server pages: await callAppRoute(slug, "GET /path", input). Widgets: createAppClient(appSlug).call(...).',
            },
            {
              group: [
                "@/lib/db",
                "@/lib/db/*",
                "@connectors/*",
                "@/lib/connectors/*",
              ],
              message:
                "Direct DB or connector access is not allowed in a page or widget. Go through your app's declared routes.",
            },
            // RESTATED, not inherited. ESLint flat config REPLACES a rule's
            // options rather than merging them, so this block overrides the
            // `apps/**` one above wholesale. Anything omitted here is permitted
            // in pages and widgets — which is how the most client-facing tier
            // ended up the only one able to import the context builder.
            {
              group: ["@/lib/apps/services", "@/lib/apps/context"],
              message:
                "The App Services broker and context builder are platform-internal and server-only. A page or widget must not import them: use callAppRoute() from a server page, or createAppClient() from a widget.",
            },
            {
              group: ["@/lib/apps/scoped-db"],
              // The NAMES, not the module: `import type { ScopedClient }` is how
              // an app types a handler that receives `context.db`, and a type
              // cannot construct anything. It is the factory that must not be
              // reachable.
              importNames: ["createScopedClient", "createReadOnlyScopedClient"],
              message:
                "Do not construct a scoped DB client. `createScopedClient(slug)` takes ANY slug and builds a service-role client for it, so an app could name another app's prefix and read or write its tables — the `_app_<slug>_` prefix only bounds the table name, never the app. Use the injected `context.db`, which the gateway pins to your own app. (`import type { ScopedClient }` is fine.)",
            },
          ],
        },
      ],
    },
  },
  // ── Security: server-side app code (routes, service handlers, lib/server, mcp) ──
  // These run behind the gateway and may import connectors (type-only), but must
  // NOT touch the RAW DB client — that bypasses per-app scoping and could read
  // another app's tables. RLS is enabled on every table but grants nothing to
  // anyone: the platform connects with the service role, which bypasses it
  // outright, so table-name scoping is the only isolation there is. Read your
  // own data via `context.db`
  // (scoped) and other apps' data via `context.services` (the App Services
  // broker). The broker/context builders themselves stay platform-internal.
  //
  // MCP tool handlers (apps/**/mcp/**) belong to this tier too: they are server
  // code invoked by the MCP broker with a read-only context. The raw DB client
  // would hand them write access the whole feature is designed to withhold.
  {
    files: [
      "apps/**/api/**/*.{ts,tsx}",
      "apps/**/lib/server/**/*.{ts,tsx}",
      "apps/**/services/**/*.{ts,tsx}",
      "apps/**/mcp/**/*.{ts,tsx}",
      "apps/**/jobs/**/*.{ts,tsx}",
    ],
    rules: {
      "no-restricted-imports": [
        "error",
        {
          patterns: [
            {
              group: ["@/lib/db", "@/lib/db/*"],
              message:
                "Apps must not use the raw DB client — it bypasses per-app scoping. Use context.db (your data) and context.services (other apps' data).",
            },
            {
              group: ["@/lib/apps/services", "@/lib/apps/context"],
              message:
                "The App Services broker and context builder are platform-internal. Use the injected context.services client instead.",
            },
            {
              group: ["@/lib/apps/scoped-db"],
              // The NAMES, not the module: `import type { ScopedClient }` is how
              // an app types a handler that receives `context.db`, and a type
              // cannot construct anything. It is the factory that must not be
              // reachable.
              importNames: ["createScopedClient", "createReadOnlyScopedClient"],
              message:
                "Do not construct a scoped DB client. `createScopedClient(slug)` takes ANY slug and builds a service-role client for it, so an app could name another app's prefix and read or write its tables — the `_app_<slug>_` prefix only bounds the table name, never the app. Use the injected `context.db`, which the gateway pins to your own app. (`import type { ScopedClient }` is fine.)",
            },
          ],
        },
      ],
    },
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
  //    a dark look is a different theme an admin selects — `mixos` and
  //    `mixos-dark` are two themes, not two modes of one. So a `dark:` variant
  //    is not "the wrong place to fork colour", it is a fork with nothing on the
  //    other side: it hard-codes a second answer somewhere the contrast gate
  //    cannot see, and it is wrong the moment a third theme appears.
  //
  // WHY src/ IS IN SCOPE AS OF THE THEME ABSTRACTION. This block used to read
  // "the platform is light-only today — nothing applies the `.dark` class", and
  // was scoped to apps/** on the strength of it. `feat/theme-abstraction` made a
  // dark palette reachable and that assumption expired: the platform's own
  // chrome had accumulated ~120 raw palette utilities and 13 `dark:` variants
  // that apps/ had been forbidden from writing for years. Extending the glob is
  // what makes that a one-time repair rather than a recurring cleanup — the
  // platform is now held to the rule it wrote. See
  // docs/plans/20260826_1959-dark-mode-legibility.md.
  //
  // OPAQUE FILLS ONLY. `bg-white/10` as a hover on a navy panel and
  // `bg-black/70` as a modal scrim are alpha over a *known* ground and stay
  // legal — a rule that flagged those would be a rule people rightly ignore.
  // What's banned is an opaque fill pretending to be a theme surface.
  //
  // KNOWN LIMITATION: this reads string literals and template chunks, so it
  // cannot see a class assembled at runtime (`` `text-${tone}-600` ``). It
  // catches the common case; `/mix-app review <slug>` covers the rest by
  // reading the code.
  //
  // See docs/apps/ux.md and apps/AGENTS.md invariant 22.
  {
    files: ["apps/**/*.{ts,tsx}", "src/**/*.{ts,tsx}"],
    rules: {
      "no-restricted-syntax": [
        "error",
        {
          selector:
            "Literal[value=/(?:^|[\\s\"'`:])(?:text|bg|border|ring|fill|stroke|from|to|via|divide)-(?:slate|gray|zinc|neutral|stone|red|orange|amber|yellow|lime|green|emerald|teal|cyan|sky|blue|indigo|violet|purple|fuchsia|pink|rose)-\\d{2,3}(?![\\w\\/-])/]",
          message:
            "Raw palette colours dodge the contrast guarantee. Use semantic tokens: text-foreground, text-muted-foreground, text-success, text-warning, text-destructive, bg-card, bg-muted, bg-primary. See docs/apps/ux.md#color--contrast.",
        },
        {
          selector:
            "TemplateElement[value.raw=/(?:^|[\\s\"'`:])(?:text|bg|border|ring|fill|stroke|from|to|via|divide)-(?:slate|gray|zinc|neutral|stone|red|orange|amber|yellow|lime|green|emerald|teal|cyan|sky|blue|indigo|violet|purple|fuchsia|pink|rose)-\\d{2,3}(?![\\w\\/-])/]",
          message:
            "Raw palette colours dodge the contrast guarantee. Use semantic tokens: text-foreground, text-muted-foreground, text-success, text-warning, text-destructive, bg-card, bg-muted, bg-primary. See docs/apps/ux.md#color--contrast.",
        },
        {
          selector:
            "Literal[value=/(?:^|[\\s\"'`:])bg-(?:white|black)(?![\\w\\/-])/]",
          message:
            "An opaque bg-white / bg-black is a theme surface in disguise. Use bg-card, bg-background, or bg-muted. Alpha over a known ground (bg-white/10, bg-black/70) is fine and is not flagged.",
        },
        {
          selector:
            "TemplateElement[value.raw=/(?:^|[\\s\"'`:])bg-(?:white|black)(?![\\w\\/-])/]",
          message:
            "An opaque bg-white / bg-black is a theme surface in disguise. Use bg-card, bg-background, or bg-muted. Alpha over a known ground (bg-white/10, bg-black/70) is fine and is not flagged.",
        },
        {
          selector: "Literal[value=/(?:^|[\\s\"'`:])dark:/]",
          message:
            "There is no dark: variant to write — a theme has one palette, and a dark look is a different theme (mixos / mixos-dark). Drop the variant and use a semantic token; it resolves per theme, and the build verifies every theme. See docs/themes/contrast.md.",
        },
        {
          selector: "TemplateElement[value.raw=/(?:^|[\\s\"'`:])dark:/]",
          message:
            "There is no dark: variant to write — a theme has one palette, and a dark look is a different theme (mixos / mixos-dark). Drop the variant and use a semantic token; it resolves per theme, and the build verifies every theme. See docs/themes/contrast.md.",
        },
      ],
    },
  },
  // ── Containment: an app reaches the environment and the network by declaration ──
  //
  // `process.env` in app code can read CONNECTOR_ENCRYPTION_KEY and
  // SUPABASE_SERVICE_ROLE_KEY — the keys that decrypt every third-party
  // credential and bypass RLS on every table. `context.env` can read only what
  // the manifest declared and an admin filled in.
  //
  // A raw `fetch` is the SSRF hole docs/security-architecture.md §13 flagged as
  // "a gap to close BEFORE the next feature that fetches a URL", while app
  // routes could already do it. `context.http` checks the hostname against the
  // manifest's `egress`, resolves it, re-checks every returned address, and
  // repeats both on each redirect hop. Fixed, admin-configured hosts belong in a
  // connector instead.
  //
  // Both are escapable — `process-env` and `raw-fetch` in the manifest's
  // `escapes` — but only on the record, with a reason a reviewer can act on.
  {
    files: ["apps/**/*.{ts,tsx}"],
    rules: {
      "no-restricted-properties": [
        "error",
        {
          object: "process",
          property: "env",
          message:
            "Apps must not read process.env — it carries the platform's own secrets. Declare what you need under `env` in app.json and read it as context.env.<KEY>.",
        },
      ],
      "no-restricted-globals": [
        "error",
        {
          name: "fetch",
          message:
            "Apps must not call fetch directly — that is the SSRF hole. Use context.http (bounded by the manifest's `egress` allowlist, with a resolve-and-recheck against private ranges), or a connector for a fixed upstream.",
        },
      ],
    },
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
  {
    files: ["apps/**/*.tsx"],
    rules: {
      "no-restricted-syntax": [
        "error",
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
      "mos-design": {
        rules: { "no-low-contrast-token-pairs": noLowContrastTokenPairs },
      },
    },
    rules: { "mos-design/no-low-contrast-token-pairs": "error" },
  },
]);

export default eslintConfig;
