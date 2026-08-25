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
  // 2. COLOURS FORK IN globals.css, NEVER IN AN APP. The platform is light-only
  //    today — nothing applies the `.dark` class — but that block is kept
  //    complete and AA-correct so shipping dark mode stays a one-file change.
  //    Per-app `dark:` variants are precisely what would destroy that: twenty
  //    apps each half-supporting a theme none of them can test.
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
    files: ["apps/**/*.{ts,tsx}"],
    rules: {
      "no-restricted-syntax": [
        "error",
        {
          selector:
            "Literal[value=/(?:^|[\\s\"'`])(?:text|bg|border|ring|fill|stroke|from|to|via|divide)-(?:slate|gray|zinc|neutral|stone|red|orange|amber|yellow|lime|green|emerald|teal|cyan|sky|blue|indigo|violet|purple|fuchsia|pink|rose)-\\d{2,3}(?![\\w\\/-])/]",
          message:
            "Raw palette colours dodge the contrast guarantee. Use semantic tokens: text-foreground, text-muted-foreground, text-success, text-warning, text-destructive, bg-card, bg-muted, bg-primary. See docs/apps/ux.md#color--contrast.",
        },
        {
          selector:
            "TemplateElement[value.raw=/(?:^|[\\s\"'`])(?:text|bg|border|ring|fill|stroke|from|to|via|divide)-(?:slate|gray|zinc|neutral|stone|red|orange|amber|yellow|lime|green|emerald|teal|cyan|sky|blue|indigo|violet|purple|fuchsia|pink|rose)-\\d{2,3}(?![\\w\\/-])/]",
          message:
            "Raw palette colours dodge the contrast guarantee. Use semantic tokens: text-foreground, text-muted-foreground, text-success, text-warning, text-destructive, bg-card, bg-muted, bg-primary. See docs/apps/ux.md#color--contrast.",
        },
        {
          selector:
            "Literal[value=/(?:^|[\\s\"'`])bg-(?:white|black)(?![\\w\\/-])/]",
          message:
            "An opaque bg-white / bg-black is a theme surface in disguise. Use bg-card, bg-background, or bg-muted. Alpha over a known ground (bg-white/10, bg-black/70) is fine and is not flagged.",
        },
        {
          selector:
            "TemplateElement[value.raw=/(?:^|[\\s\"'`])bg-(?:white|black)(?![\\w\\/-])/]",
          message:
            "An opaque bg-white / bg-black is a theme surface in disguise. Use bg-card, bg-background, or bg-muted. Alpha over a known ground (bg-white/10, bg-black/70) is fine and is not flagged.",
        },
        {
          selector: "Literal[value=/(?:^|[\\s\"'`])dark:/]",
          message:
            "Colours fork in src/app/globals.css, never in an app. Drop the dark: variant and use a semantic token — the token already carries both themes. See docs/apps/ux.md#the-platform-is-light-only-today.",
        },
        {
          selector: "TemplateElement[value.raw=/(?:^|[\\s\"'`])dark:/]",
          message:
            "Colours fork in src/app/globals.css, never in an app. Drop the dark: variant and use a semantic token — the token already carries both themes. See docs/apps/ux.md#the-platform-is-light-only-today.",
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
  // WARN, NOT ERROR — for now. It flags real failures in 16 existing apps, and
  // the fix for each (drop the tint? raise the text? re-tone the token?) is a
  // visual decision belonging to that app's owner, not something to force in a
  // platform PR. Flip to "error" once the backlog is worked down; new code
  // should be written to it today.
  //
  // src/ is in scope too: a floor the platform's own components don't clear is
  // not a floor.
  {
    files: ["apps/**/*.{ts,tsx}", "src/**/*.{ts,tsx}"],
    plugins: {
      "mos-design": { rules: { "no-low-contrast-token-pairs": noLowContrastTokenPairs } },
    },
    rules: { "mos-design/no-low-contrast-token-pairs": "warn" },
  },
]);

export default eslintConfig;
