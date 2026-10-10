/* This Source Code Form is subject to the terms of the Mozilla Public
 * License, v. 2.0. If a copy of the MPL was not distributed with this
 * file, You can obtain one at https://mozilla.org/MPL/2.0/. */

import { z } from "zod";
import { assertValidCron } from "../src/lib/apps/cron";
import {
  SCREENSHOT_DIR,
  SCREENSHOT_MAX_COUNT,
} from "../src/lib/screenshots";
import {
  BRAND_HOOKS,
  BRAND_LOGO_DIR,
  BRAND_LOGO_MAX_COUNT,
  BRAND_NAME_MAX_LENGTH,
  sanitizeBrandName,
} from "../src/lib/branding/types";

/**
 * Zod schemas for the *on-disk* manifest shapes — `apps/<slug>/app.json`
 * and `connectors/<name>/connector.json`.
 *
 * These validate what a developer writes, NOT the fully-derived registry
 * entry: fields the generator fills in from the filesystem (`slug`,
 * `hasPages`, `hookCounts`, `hooks`, widget `id`) are deliberately absent, so a
 * manifest that tries to set them fails the build.
 *
 * `lastUpdated` is the exception. It lives in the manifest as an ISO 8601
 * date-time and is stamped by scripts/stamp-updated.ts at commit
 * time, so it is accepted here — but it is tool-written, not hand-written.
 *
 * Every object is `strict()` — an unknown key is a hard error. This catches
 * typos (`connector` vs `connectors`, `defaultRoles` vs `defaultRole`) and
 * stops authors from hand-setting auto-generated fields. The authoritative
 * TypeScript types still live in `src/lib/apps/types.ts` and
 * `src/lib/connectors/types.ts`; keep these schemas in step with them.
 */

const authorSchema = z.strictObject({
  name: z.string().min(1),
  email: z.string().min(1),
});

const sizeSchema = z.strictObject({
  w: z.number(),
  h: z.number(),
});

const configOptionSchema = z.strictObject({
  label: z.string(),
  value: z.string(),
});

const widgetConfigFieldSchema = z.strictObject({
  key: z.string().min(1),
  label: z.string().min(1),
  type: z.enum(["text", "number", "boolean", "select", "multiselect"]),
  required: z.boolean().optional(),
  default: z.unknown().optional(),
  options: z.array(configOptionSchema).optional(),
  ordered: z.boolean().optional(),
});

const widgetSchema = z.strictObject({
  name: z.string().min(1),
  description: z.string().min(1),
  // `id` is derived from the component filename — never declared.
  component: z.string().min(1),
  defaultSize: sizeSchema.optional(),
  minSize: sizeSchema.optional(),
  config: z.array(widgetConfigFieldSchema).optional(),
});

/**
 * The cadence half of a schedule, shared by `schedules[]` and `sync[].schedule`.
 *
 * Factored out rather than re-declared: the exactly-one rule, the multiple-of-5
 * rule and the `assertValidCron` bridge are three places to get wrong, and two
 * copies of them drift the first time one is amended.
 */
const cadenceSchema = z
  .strictObject({
    // Minimum 5 (the tick size) and a multiple of 5, so the cadence is
    // predictable at 5-minute resolution.
    everyMinutes: z
      .number()
      .int()
      .min(5)
      .refine((n) => n % 5 === 0, {
        message: "everyMinutes must be a multiple of 5",
      })
      .optional(),
    // Standard 5-field CRON expression, evaluated at 5-minute tick resolution.
    cron: z.string().min(1).optional(),
    // IANA timezone for `cron` (default UTC). Only valid with `cron`.
    timezone: z.string().min(1).optional(),
  })
  .superRefine((s, ctx) => {
    const hasInterval = s.everyMinutes != null;
    const hasCron = s.cron != null;
    if (hasInterval === hasCron) {
      ctx.addIssue({
        code: "custom",
        message: "a schedule must set exactly one of `everyMinutes` or `cron`",
      });
    }
    if (s.timezone != null && !hasCron) {
      ctx.addIssue({
        code: "custom",
        message: "`timezone` is only valid alongside `cron`",
        path: ["timezone"],
      });
    }
    if (hasCron) {
      try {
        assertValidCron(s.cron as string, s.timezone);
      } catch (err) {
        ctx.addIssue({
          code: "custom",
          message: err instanceof Error ? err.message : String(err),
          path: ["cron"],
        });
      }
    }
  });

const scheduleSchema = cadenceSchema.extend({ name: z.string().min(1) });

const roleSchema = z.strictObject({
  key: z.string().min(1),
  label: z.string().min(1),
});

/**
 * The closed set of rules an app may escape.
 *
 * An escape is the only way out of a platform guarantee, and it is on the
 * record: declared in the manifest with a reason, surfaced on the app's admin
 * page, and visible in review. The set is closed deliberately — an unknown rule
 * name is a build failure rather than a no-op, because a typo'd escape reads as
 * "declared" to a reviewer while enforcing nothing at all.
 */
const ESCAPE_RULES = [
  /** Renders HTML the app did not author (`dangerouslySetInnerHTML`). */
  "raw-html",
  /** A route returns its own Response (`defineRoute({ raw: true })`). */
  "raw-response",
  /** Output validation runs only outside production, for a measured hot path. */
  "output-validate-dev-only",
  /** Reads `process.env` directly instead of declaring `env`. */
  "process-env",
  /** Calls `fetch` directly instead of a connector or `context.http`. */
  "raw-fetch",
] as const;

const escapeSchema = z.strictObject({
  rule: z.enum(ESCAPE_RULES, {
    error: (iss) =>
      `unknown escape rule ${JSON.stringify(iss.input)} — an escape must name one of: ${ESCAPE_RULES.join(", ")}`,
  }),
  // A sentence, not a word: a reviewer has to be able to act on this without
  // going and reading the code to find out what was escaped and why.
  reason: z
    .string()
    .min(
      20,
      "an escape must carry a reason a reviewer can act on, not a placeholder",
    ),
});

/**
 * An app-scoped setting an admin fills in, reached as `context.env.<KEY>`.
 *
 * This is what makes banning `process.env` in app code possible. An app reading
 * the raw environment can read `CONNECTOR_ENCRYPTION_KEY` and
 * `DATABASE_URL`; an app reading `context.env` sees only what it
 * declared here. `password` is the signal for the encrypt-at-rest path — the
 * same one connector credentials use.
 */
const appEnvFieldSchema = z.strictObject({
  key: z
    .string()
    .regex(
      /^[A-Z][A-Z0-9_]*$/,
      "an env key is SCREAMING_SNAKE_CASE (e.g. REPORT_WEBHOOK_URL), so it reads as configuration at the call site",
    ),
  label: z.string().min(1),
  type: z.enum(["text", "password"]),
  required: z.boolean().optional(),
});

/**
 * A one-line summary for a listing that has room for a sentence, not a
 * paragraph. Capped rather than merely encouraged: an over-long tagline is not
 * a style problem but a layout one — the catalogue grid truncates it, so the
 * half the author cared about is the half that disappears.
 */
const taglineSchema = z
  .string()
  .min(1)
  .max(
    100,
    "tagline is a single line for a listing card — keep it under 100 characters and put the full explanation in `description`",
  )
  .regex(/^[^\n\r]+$/, "tagline is a single line — no line breaks");

/**
 * One screenshot for the extension's listing gallery.
 *
 * Shape only. Whether the file exists, whether it is an image at all, and how
 * wide it is are the generator's business — this schema cannot open a file, and
 * a path that merely *looks* right is worth nothing.
 *
 * `file` carries its `screenshots/` prefix rather than leaving the directory
 * implied, the same way a connector's `icon` is written `assets/icon.svg`: the
 * manifest should say where the file actually is, so a reader can find it
 * without knowing a convention.
 *
 * `alt` is optional, but a renderer is told to treat its absence as "none
 * supplied" rather than "decorative" — see `src/lib/screenshots.ts`.
 */
const screenshotSchema = z.strictObject({
  file: z
    .string()
    .min(SCREENSHOT_DIR.length + 2)
    .refine(
      (v) => v.startsWith(`${SCREENSHOT_DIR}/`) && !v.includes(".."),
      `must be a path inside the extension's own ${SCREENSHOT_DIR}/ directory, written out in full — e.g. "${SCREENSHOT_DIR}/dashboard.png"`,
    ),
  alt: z.string().min(1).optional(),
  caption: z.string().min(1).optional(),
});

/**
 * The gallery, newest-idea-first: whatever order the author lists is the order
 * it renders. Capped here as well as in the generator so an over-long array
 * fails with a schema message pointing at the field.
 */
const screenshotsSchema = z
  .array(screenshotSchema)
  .max(
    SCREENSHOT_MAX_COUNT,
    `at most ${SCREENSHOT_MAX_COUNT} screenshots — a gallery longer than that is not read`,
  );

/**
 * One search/browse term. Lowercase and space- or hyphen-separated.
 *
 * The case rule is the load-bearing one: a facet list dedupes on the exact
 * string, so `Gmail` next to `gmail` renders as two filters for one idea and
 * splits the results between them.
 */
const keywordSchema = z
  .string()
  .min(2)
  .max(32)
  .regex(
    /^[a-z0-9]+(?:[ -][a-z0-9]+)*$/,
    "keywords are lowercase words separated by single spaces or hyphens (e.g. \"email\", \"time tracking\", \"crm\")",
  );

/** SPDX identifier characters — no spaces; operators are matched separately. */
const SPDX_ID = /^[A-Za-z0-9][A-Za-z0-9.+-]*$/;

/**
 * An SPDX licence identifier or expression, or `UNLICENSED`.
 *
 * Validated as a shape rather than against the full SPDX list, which is ~600
 * entries and grows. That still rejects the mistake worth rejecting: prose.
 * `"MIT License"` and `"Apache 2.0"` are what an author reaches for by default,
 * and a catalogue that has to parse those cannot answer "is this
 * redistributable" for anyone.
 */
const licenseSchema = z
  .string()
  .min(1)
  .max(64)
  .refine(
    (v) =>
      v === "UNLICENSED" ||
      v
        .replace(/[()]/g, "")
        .split(/ (?:AND|OR|WITH) /)
        .every((part) => SPDX_ID.test(part)),
    'license must be an SPDX identifier or expression — e.g. "MPL-2.0", "Apache-2.0 WITH LLVM-exception", or "UNLICENSED" for something not redistributable. Prose like "MIT License" is not one.',
  );

/**
 * A link the platform renders for a user. `https` only.
 *
 * Both listing URLs are shown on pages served over https, so an `http` link is
 * a downgrade the browser will warn about or block outright — and the author
 * would never see it, because their own dev server is http.
 */
const listingUrlSchema = z
  .string()
  .min(1)
  .refine(
    (v) => {
      try {
        return new URL(v).protocol === "https:";
      } catch {
        return false;
      }
    },
    "must be an absolute https:// URL",
  );

/**
 * A host `context.http` may reach.
 *
 * Bare hostname only — no scheme, port, path or credentials — because the
 * allowlist is compared against the *resolved* host after DNS, and any of those
 * would make the comparison ambiguous. IP literals are rejected outright: an IP
 * is the shape an SSRF payload takes (169.254.169.254 is the cloud metadata
 * endpoint), and it also bypasses the resolve-and-recheck that makes the
 * allowlist meaningful against DNS rebinding.
 */
const egressHostSchema = z
  .string()
  .min(1)
  .regex(
    /^(\*\.)?[a-z0-9]([a-z0-9-]*[a-z0-9])?(\.[a-z0-9]([a-z0-9-]*[a-z0-9])?)+$/,
    "egress entries are bare lowercase hostnames — no scheme, port or path (e.g. api.example.com, or *.example.com for one level of subdomain)",
  )
  .refine((h) => !/^(\d{1,3}\.){3}\d{1,3}$/.test(h), {
    message:
      "egress entries must be hostnames, not IP literals — an IP bypasses the resolve-and-recheck the allowlist depends on",
  });

/**
 * How far back a sync reaches, and the bounds its window may move between.
 * The platform does the tuning; the app supplies the bounds.
 */
const syncWindowSchema = z
  .strictObject({
    coldStartDays: z.number().int().min(1),
    defaultDays: z.number().int().min(1),
    minDays: z.number().int().min(1),
  })
  .superRefine((w, ctx) => {
    if (w.defaultDays > w.coldStartDays) {
      ctx.addIssue({
        code: "custom",
        message:
          "`defaultDays` cannot exceed `coldStartDays` — the cold start is the widest window a sync ever opens",
        path: ["defaultDays"],
      });
    }
    if (w.minDays > w.defaultDays) {
      ctx.addIssue({
        code: "custom",
        message: "`minDays` cannot exceed `defaultDays`",
        path: ["minDays"],
      });
    }
  });

/**
 * A declarative incremental sync. The app writes only `fetchPage` and `upsert`
 * in apps/<slug>/sync/<name>.ts; the platform owns the watermark, the window
 * tuning, the budget and the invalidation — and owns the pagination cursor,
 * which is why it can guarantee the cursor never outlives one run.
 */
const syncDefinitionSchema = z.strictObject({
  name: z.string().min(1),
  schedule: cadenceSchema,
  // Cross-checked by the generator against the app's declared `connectors`
  // (plus the literal "mixos"), exactly as mcp[].sources is — a schema can't see
  // sibling fields from inside a nested object.
  source: z.string().min(1),
  window: syncWindowSchema,
  // The scheduler ticks every 5 minutes, so a budget beyond one tick can never
  // be honoured — it would simply be truncated at runtime with no signal.
  budgetMs: z.number().int().min(1_000).max(300_000),
});

/**
 * A hook this app fires, and who may listen.
 *
 * Cross-app hook listening was the one channel between apps with NO consent at
 * all: any app could `addAction("other-app:thing", fn)` using the full prefixed
 * name and observe another app's events. App Services requires two-sided
 * consent for a *pull*; a push had none.
 *
 * So an emitter now declares its consumers, exactly as `provides` does, and the
 * generator enforces both sides. Undeclared is default-deny.
 */
const hookEmitSchema = z.strictObject({
  name: z.string().min(1),
  description: z.string().optional(),
  // An allowlist of app slugs, or "*" for any app that declares the dependency.
  consumers: z.union([z.array(z.string().min(1)), z.literal("*")]),
});

/** A hook this app listens for, named as `<emitter-slug>:<hook>`. */
const hookListenSchema = z.strictObject({
  app: z.string().min(1),
  hook: z.string().min(1),
});

/**
 * An app's declaration that it filters the brand: which of the three brand
 * hooks, why, and the marks it ships for them.
 *
 * Shape only. That `hooks` matches what `hooks.ts` actually registers, and that
 * each logo exists and is an image the build can measure, is the generator's
 * business.
 */
const appBrandingSchema = z.strictObject({
  hooks: z
    .array(
      z.enum(BRAND_HOOKS, {
        error: (iss) =>
          `unknown brand hook ${JSON.stringify(iss.input)} — must be one of: ${BRAND_HOOKS.join(", ")}`,
      }),
    )
    .min(1, "declare at least one brand hook, or omit `branding`")
    .refine((h) => new Set(h).size === h.length, {
      message: "duplicate brand hook",
    }),
  // The same bar as an escape: the admin reads this at activation, and it has
  // to tell them what will change on the sign-in page without reading code.
  reason: z
    .string()
    .min(
      20,
      "give a reason an admin can act on — this is shown before they activate the app",
    ),
  logos: z
    .array(
      z
        .string()
        .refine(
          (v) => new RegExp(`^${BRAND_LOGO_DIR}/[^/]+$`).test(v) && !v.includes(".."),
          `must be a file directly inside the app's own ${BRAND_LOGO_DIR}/ directory, written out in full — e.g. "${BRAND_LOGO_DIR}/mark.png"`,
        ),
    )
    .max(BRAND_LOGO_MAX_COUNT, `at most ${BRAND_LOGO_MAX_COUNT} logos`)
    .refine((l) => new Set(l).size === l.length, { message: "duplicate logo" })
    .optional(),
});

const appTelemetryEventSchema = z.strictObject({
  name: z.string().min(1),
  description: z.string().optional(),
});

const connectorTelemetryEventSchema = z.strictObject({
  method: z.string().min(1),
  description: z.string().optional(),
  /**
   * Does this method change anything upstream?
   *
   * This is the gap the platform could not close before. MCP tools are
   * read-only, enforced three ways for `ctx.db` — type, runtime Proxy, ESLint —
   * but `docs/apps/mcp.md` had to say outright: "Connectors are the gap the
   * platform can't close. It cannot know which connector methods mutate... a
   * reviewer has to confirm it."
   *
   * Declared here, the platform can. The MCP context wraps `ctx.connectors` and
   * throws on a method marked `mutates`, so a read-only tool calling a write is
   * a runtime error rather than a blocking review finding somebody has to catch.
   *
   * Defaults to `false`, which is safe for the wrong reason and stated here so
   * nobody mistakes it for a guarantee: an UNDECLARED method is invisible to
   * this check entirely. Declaring a connector's writes is what buys the
   * enforcement.
   */
  mutates: z.boolean().optional(),
});

const serviceDefinitionSchema = z.strictObject({
  name: z.string().min(1),
  description: z.string().optional(),
  audience: z.enum(["user", "app"]).optional(),
  // Explicit allowlist of consumer slugs, or "*" for any app that declares the
  // dependency. Default deny — there is no implicit access.
  consumers: z.union([z.literal("*"), z.array(z.string().min(1))]),
});

const serviceDependencySchema = z.strictObject({
  app: z.string().min(1),
  service: z.string().min(1),
});

/**
 * Phrases that assert jurisdiction over a subject area instead of describing
 * data, rejected in any model-facing MCP string.
 *
 * A client pools our tools into one flat list with every other server the user
 * has connected. Most of those servers describe mechanics and stop there
 * ("searches CRM records with filters"). A tool that instead says "start here
 * for any question about onboarding" reads as an instruction rather than a
 * capability, and the asserting tool wins the routing decision — including the
 * many cases where the neighbouring server held the better answer. One app
 * writing that sentence degrades every other connector the user owns, which is
 * why this is a build failure rather than a review note.
 *
 * The rule is narrow on purpose: it catches the unconditional forms, not every
 * soft topic claim. `sources` and `notCovered` do the positive work of keeping
 * a description bounded.
 */
const JURISDICTION_CLAIMS: { pattern: RegExp; why: string }[] = [
  {
    pattern: /\bstart here\b/i,
    why: "it ranks this tool ahead of tools it cannot see",
  },
  {
    pattern: /\bfirst (?:stop|port of call|place to look)\b/i,
    why: "it ranks this tool ahead of tools it cannot see",
  },
  {
    pattern: /\bany\s+(?:[\w-]+\s+){0,4}questions?\b/i,
    why: "it claims a subject area, which is always wider than the data",
  },
  {
    pattern: /\bfor all (?:questions|things|matters|requests)\b/i,
    why: "it claims a subject area, which is always wider than the data",
  },
  {
    pattern:
      /\b(?:always|by default)\s+(?:use|call|prefer|reach for|start with)\b/i,
    why: "an unconditional routing instruction leaves no room for a better source",
  },
  {
    pattern: /\bprefer(?:\s+[\w-]+){0,3}\s+over\b/i,
    why: "ranking this tool against others is a claim a description cannot support",
  },
  {
    pattern:
      /\b(?:authoritative|canonical|definitive|single|sole|only)\s+source\b/i,
    why: "a sole-source claim suppresses tools that may be better suited",
  },
  {
    pattern: /\bbefore (?:using|calling|trying|querying) any other\b/i,
    why: "sequencing other servers' tools is outside what this tool can know",
  },
];

/**
 * A model-facing MCP string: non-empty, and free of jurisdiction language.
 * The failing phrase is quoted back so the fix is obvious from the build log.
 */
function modelFacingText() {
  return z
    .string()
    .min(1)
    .superRefine((value, ctx) => {
      for (const { pattern, why } of JURISDICTION_CLAIMS) {
        const hit = pattern.exec(value);
        if (!hit) continue;
        ctx.addIssue({
          code: "custom",
          message:
            `contains "${hit[0]}" — ${why}. A client reads this pooled with ` +
            `every other connected server's tools, so an imperative claim here ` +
            `quietly outranks them. Say what the data is, then bound it with ` +
            `"sources" and "notCovered".`,
        });
        return;
      }
    });
}

/**
 * A read-only MCP tool. `description` is required (unlike a service's) because
 * it is the *only* signal a model has when deciding whether to call the tool —
 * an undescribed tool is worse than no tool. `sources` is required for the
 * mirror-image reason: a tool that never says where its data came from cannot
 * be told apart from the source system's own connector, so it gets called for
 * raw-record questions it can't answer.
 */
const mcpToolDefinitionSchema = z.strictObject({
  name: z
    .string()
    .min(1)
    .regex(
      /^[a-z0-9]+(-[a-z0-9]+)*$/,
      "mcp tool names must be lowercase-hyphenated (e.g. quarter-summary)",
    ),
  description: modelFacingText(),
  hint: modelFacingText().optional(),
  // Each entry additionally cross-checked by the generator against the app's
  // declared `connectors` (plus the literal "mixos") — a schema can't see them.
  sources: z
    .array(z.string().min(1))
    .min(
      1,
      'every MCP tool must declare where its data comes from: connector slugs the app declares, or "mixos" for data that exists only in MixOS',
    ),
  notCovered: modelFacingText().optional(),
});

/**
 * Cap on tools per app. MCP clients degrade badly as the tool list grows, and
 * the list is the union across every app the user consented to — so the budget
 * has to be enforced per app, not globally. Prefer few, coarse tools.
 */
const MAX_MCP_TOOLS_PER_APP = 5;

/**
 * Cap on catalogue keywords per extension. Facets are only useful while they
 * discriminate; an extension that tags itself with everything is
 * indistinguishable from one that tags itself with nothing, and it dilutes
 * every facet it joins for the extensions that belong there.
 */
const MAX_APP_KEYWORDS = 10;

/**
 * The catalogue keyword list, shared by apps, connectors and themes.
 *
 * Defined once because all three feed the same browse and search surfaces on
 * mixos.org. Three separate copies of this would drift, and the first symptom
 * would be a connector allowed twelve keywords while an app is allowed ten —
 * which nobody would notice until the facet list was already skewed.
 */
const catalogueKeywordsSchema = z
  .array(keywordSchema)
  .max(
    MAX_APP_KEYWORDS,
    `at most ${MAX_APP_KEYWORDS} keywords — a list that claims every facet describes nothing`,
  )
  .refine((k) => new Set(k).size === k.length, {
    message: "duplicate keyword",
  });

/**
 * The auths a page or route may accept.
 *
 * The gateway resolves the *strongest* one the caller actually presents and
 * hands the handler a discriminated context, so a set is not a fallback chain —
 * it is a statement that the handler covers every branch it declares. A surface
 * accepting `public` or `password` is derived into the /p/ mount.
 */
const routeAuth = z.enum(["session", "signed-in", "password", "key", "public"]);

const acceptedAuths = z
  .array(routeAuth)
  .min(
    1,
    'a route must accept at least one auth — omit the entry entirely for the default ["session"]',
  )
  .refine((a) => new Set(a).size === a.length, {
    message: "duplicate auth in the accepted set",
  });

export const RawAppManifestSchema = z
  .strictObject({
    name: z.string().min(1),
    /**
     * ISO 8601 date-time, stamped by scripts/stamp-updated.ts from
     * .githooks/pre-commit. This is the one generator-consumed field a manifest
     * DOES own — written by the pre-commit stamp, never by hand.
     *
     * A string rather than epoch millis so the value is legible in a diff: a
     * reviewer can see what a publish changed. The generator parses it to millis
     * for the runtime registry.
     */
    lastUpdated: z.iso.datetime().optional(),

    description: z.string().optional(),
    /**
     * One line for a listing card. `description` is the full explanation; this
     * is the version that fits next to the icon in a grid.
     */
    tagline: taglineSchema.optional(),
    icon: z.string().optional(),
    authors: z.array(authorSchema).optional(),
    /**
     * Catalogue search and browse terms. Lowercase, deduplicated, and capped —
     * a manifest listing twenty keywords is claiming every facet rather than
     * describing itself, which makes the facets useless for everyone.
     */
    keywords: catalogueKeywordsSchema.optional(),
    /**
     * Listing gallery. Files live under `apps/<slug>/screenshots/`; the
     * generator verifies, measures and publishes each one.
     */
    screenshots: screenshotsSchema.optional(),
    /** SPDX identifier or expression, or `UNLICENSED`. */
    license: licenseSchema.optional(),
    /** Homepage, docs, or repository directory for the app. */
    appUrl: listingUrlSchema.optional(),
    /** Where a user reports a problem with the app. */
    appSupportUrl: listingUrlSchema.optional(),
    connectors: z.array(z.string().min(1)).optional(),
    /**
     * Connectors a PART of this app uses, which the app works without.
     *
     * The difference from `connectors` is what happens when one is not
     * configured: a required connector refuses the app's registration, because
     * the app cannot function; an optional one never blocks anything, and the
     * sub-component that needs it is the only thing that degrades. Use it for
     * the widget nobody would uninstall the app over.
     *
     * Optional connectors are still built into `context.connectors` when they
     * ARE configured, and are still declarable as a sync source or MCP tool
     * dependency — app code must simply cope with the entry being absent.
     */
    optionalConnectors: z.array(z.string().min(1)).optional(),
    database: z.boolean().optional(),
    notifications: z.boolean().optional(),
    global: z.boolean().optional(),
    // Declared exceptions to platform guarantees. Rule names are a closed set;
    // duplicate rules are rejected by the generator alongside the other
    // duplicate-name checks.
    escapes: z.array(escapeSchema).optional(),
    // App-scoped settings an admin fills in, read as `context.env.<KEY>`.
    env: z.array(appEnvFieldSchema).optional(),
    // Hosts `context.http` may reach; raw fetch is lint-banned in app code.
    // Reaching anything else is a connector's job (admin-configured, fixed).
    egress: z.array(egressHostSchema).optional(),
    widgets: z.array(widgetSchema).optional(),
    // Each name additionally verified on disk by the generator
    // (apps/<slug>/jobs/<name>.ts).
    schedules: z.array(scheduleSchema).optional(),
    // Cross-app hook wiring. `emits[].consumers` is the emitter's allowlist and
    // `listensTo` is the consumer's declaration; the generator enforces both.
    emits: z.array(hookEmitSchema).optional(),
    listensTo: z.array(hookListenSchema).optional(),
    // The brand hooks this app filters. Cross-checked against `hooks.ts` by the
    // generator in both directions; each logo is verified and measured there.
    branding: appBrandingSchema.optional(),
    // Declarative incremental syncs. Each name is additionally verified on disk
    // by the generator (apps/<slug>/sync/<name>.ts, a `defineSync` default
    // export), and `source` is cross-checked against the declared connectors.
    sync: z.array(syncDefinitionSchema).optional(),
    // The auth set is validated here; the generator additionally verifies each
    // key resolves to a real file on disk (which a schema can't check).
    pageVisibility: z.record(z.string(), acceptedAuths).optional(),
    apiVisibility: z.record(z.string(), acceptedAuths).optional(),
    roles: z.array(roleSchema).optional(),
    defaultRole: z.string().min(1).optional(),
    telemetry: z.array(appTelemetryEventSchema).optional(),
    // App Services. Each `provides[].name` is verified on disk by the generator
    // (apps/<slug>/services/<name>.ts); `consumes` is cross-checked against
    // providers' `provides` + `consumers` allowlists (two-sided consent).
    provides: z.array(serviceDefinitionSchema).optional(),
    consumes: z.array(serviceDependencySchema).optional(),
    // MCP tools. Each `mcp[].name` is verified on disk by the generator
    // (apps/<slug>/mcp/<name>.ts, exporting `inputSchema` + a default handler).
    mcp: z
      .array(mcpToolDefinitionSchema)
      .max(
        MAX_MCP_TOOLS_PER_APP,
        `an app may expose at most ${MAX_MCP_TOOLS_PER_APP} MCP tools — prefer fewer, coarser tools`,
      )
      .optional(),
  })
  .refine(
    (m) =>
      m.defaultRole == null || !!m.roles?.some((r) => r.key === m.defaultRole),
    {
      message:
        "defaultRole must match one of the declared roles[].key (and roles must be declared)",
      path: ["defaultRole"],
    },
  )
  .superRefine((m, ctx) => {
    // A page is loaded by a browser following a link; there is nowhere to put a
    // bearer token. Accepting `key` there would read as an exposed surface and
    // enforce nothing.
    for (const [key, auths] of Object.entries(m.pageVisibility ?? {})) {
      if (auths.includes("key")) {
        ctx.addIssue({
          code: "custom",
          message:
            '"key" is an API-only auth — a page has no API-key transport. Declare it on the route the page calls instead.',
          path: ["pageVisibility", key],
        });
      }
    }
  });

/**
 * Connector error categories, mirrored from src/lib/connectors/errors.ts so a
 * manifest's `http.retryOn` can only name a category that actually exists.
 * Keep in step with the union there.
 */
const connectorErrorCategory = z.enum([
  "unconfigured",
  "auth_failed",
  "forbidden",
  "rate_limited",
  "not_found",
  "invalid_request",
  "conflict",
  "payload_too_large",
  "timeout",
  "upstream_error",
  "network_error",
  "unexpected_response",
]);

/**
 * How the platform authenticates. Cross-field rules are enforced below rather
 * than left as runtime surprises: an apiKey strategy that forgets `name` would
 * otherwise silently send its key nowhere.
 */
const connectorAuthSchema = z
  .strictObject({
    strategy: z.enum([
      "none",
      "apiKey",
      "basic",
      "oauth2_client_credentials",
      "oauth2_authorization_code",
    ]),
    in: z.enum(["header", "query", "bearer"]).optional(),
    name: z.string().min(1).optional(),
    prefix: z.string().optional(),
    credentialKeys: z.array(z.string().min(1)).optional(),
    tokenUrl: z.url().optional(),
    tokenAuth: z.enum(["basic", "post"]).optional(),
    authorizeUrl: z.url().optional(),
    /**
     * Every scope this API documents, each flagged with whether this connector
     * asks for it. Written by the dev-time scopes refresh
     * (`scripts/check-scopes.ts <connector> --write`), which reads `scopesUrl`;
     * the registry never fetches it.
     *
     * One array rather than two because the catalogue and the request are the
     * same list seen from two angles, and keeping them apart is how they drift.
     * `requested` is REQUIRED and never inferred: the refresh writes far more
     * entries than a connector asks for, so a missing flag defaulting to true
     * would silently request the provider's entire catalogue.
     */
    scopes: z
      .array(
        z.strictObject({
          scope: z.string().min(1),
          /** The provider's own wording, as shown on their consent screen. */
          description: z.string().min(1).optional(),
          access: z.enum(["read", "write", "read-write"]).optional(),
          /** Does this connector ask for it at authorization time? */
          requested: z.boolean(),
        }),
      )
      .optional(),
    /**
     * The provider's own scope/permission reference page.
     *
     * The dev-time scopes refresh reads it to render permissions in the
     * provider's words — "View your records and settings" instead of
     * `.../auth/records.readonly`, which tells a non-technical admin nothing.
     * Point it at the page that TABULATES scopes against descriptions, not at
     * the API home page: the parser reads table rows out of it.
     */
    scopesUrl: z
      .url()
      .refine((u) => u.startsWith("https://"), "must be an https:// URL")
      .optional(),
  })
  .superRefine((a, ctx) => {
    if (
      a.strategy === "apiKey" &&
      (a.in === "header" || a.in === "query") &&
      !a.name
    ) {
      ctx.addIssue({
        code: "custom",
        message: `auth.in "${a.in}" requires auth.name (the header or query-parameter to send the key in)`,
        path: ["name"],
      });
    }
    if (a.strategy === "basic" && (a.credentialKeys?.length ?? 0) !== 2) {
      ctx.addIssue({
        code: "custom",
        message:
          "basic auth requires exactly two credentialKeys: [usernameKey, passwordKey]",
        path: ["credentialKeys"],
      });
    }
    if (
      a.strategy === "oauth2_client_credentials" &&
      (a.credentialKeys?.length ?? 0) !== 2
    ) {
      ctx.addIssue({
        code: "custom",
        message:
          "the client-credentials flow requires exactly two credentialKeys: [clientIdKey, clientSecretKey]",
        path: ["credentialKeys"],
      });
    }
    const needsToken =
      a.strategy === "oauth2_client_credentials" ||
      a.strategy === "oauth2_authorization_code";
    if (needsToken && !a.tokenUrl) {
      ctx.addIssue({
        code: "custom",
        message: `auth.strategy "${a.strategy}" requires auth.tokenUrl`,
        path: ["tokenUrl"],
      });
    }
    if (a.strategy === "oauth2_authorization_code" && !a.authorizeUrl) {
      ctx.addIssue({
        code: "custom",
        message: "the authorization-code flow requires auth.authorizeUrl",
        path: ["authorizeUrl"],
      });
    }
  });

const connectorPaginationSchema = z
  .strictObject({
    style: z.enum(["cursor", "offset", "page", "link-header"]),
    itemsPath: z.string().min(1).optional(),
    cursorPath: z.string().min(1).optional(),
    cursorParam: z.string().min(1).optional(),
    limitParam: z.string().min(1).optional(),
    offsetParam: z.string().min(1).optional(),
    pageParam: z.string().min(1).optional(),
    pageSize: z.number().int().positive().optional(),
    // Hard stop so a cursor that never terminates cannot spin forever.
    maxPages: z.number().int().positive().max(1000).optional(),
  })
  .superRefine((pg, ctx) => {
    const required: Record<string, (keyof typeof pg)[]> = {
      cursor: ["cursorPath", "cursorParam"],
      offset: ["offsetParam", "limitParam"],
      page: ["pageParam"],
      "link-header": [],
    };
    for (const field of required[pg.style]) {
      if (pg[field] == null) {
        ctx.addIssue({
          code: "custom",
          message: `pagination.style "${pg.style}" requires pagination.${String(field)}`,
          path: [String(field)],
        });
      }
    }
  });

const connectorHttpSchema = z.strictObject({
  baseUrl: z.url().optional(),
  timeoutMs: z.number().int().positive().max(120_000).optional(),
  deadlineMs: z.number().int().positive().max(120_000).optional(),
  // Total tries, not retries — "maxRetries: 2 means 3 calls" is exactly the
  // off-by-one a non-engineer should never have to reason about.
  maxAttempts: z.number().int().min(1).max(10).optional(),
  retryOn: z.array(connectorErrorCategory).optional(),
  defaultHeaders: z.record(z.string(), z.string()).optional(),
  rateLimitOn403: z.boolean().optional(),
  maxResponseBytes: z.number().int().positive().optional(),
  pagination: connectorPaginationSchema.optional(),
});

const connectorWebhookSchema = z.strictObject({
  algorithm: z.enum(["hmac-sha256", "hmac-sha1"]),
  signatureHeader: z.string().min(1),
  timestampHeader: z.string().min(1).optional(),
  toleranceSeconds: z.number().int().positive().max(3600).optional(),
  secretKey: z.string().min(1),
});

const credentialFieldSchema = z.strictObject({
  key: z.string().min(1),
  label: z.string().min(1),
  type: z.enum(["text", "password"]),
});

/**
 * A link an admin follows to provision the credential — a provider console, an
 * API-key page, a scope reference.
 *
 * `https:` only, enforced here rather than sanitized at render time. The admin
 * page turns these into real anchors, so a `javascript:` or `data:` URL in a
 * manifest would be a stored XSS with an admin session attached. Failing the
 * build is the cheaper place to catch it, and a connector legitimately needing
 * a plain-http setup link does not exist.
 */
const connectorDocLinkSchema = z.strictObject({
  label: z.string().min(1),
  url: z
    .url()
    .refine((u) => u.startsWith("https://"), "must be an https:// URL"),
});

const connectorSetupStepSchema = z
  .strictObject({
    /**
     * The instruction, and only the instruction — one imperative sentence. The UI
     * numbers these, so don't number them here.
     */
    text: z.string().min(1),
    /**
     * Why the step is that way, behind a "?" the reader opens if they care.
     *
     * This is where the paragraph goes that a careful author wants to include and
     * a reader following instructions does not want in their way — Gmail's step
     * "set User type to Internal" is four words of instruction carrying thirty
     * words of justification about CASA assessments and 7-day refresh tokens.
     * Inline, that buries the instruction; deleted, the next person changes the
     * setting back. A tooltip is the shape that fits: available, not in the way.
     *
     * Rationale only. Anything the reader must DO belongs in `text`, because a
     * tooltip is not somewhere an instruction can live.
     */
    why: z
      .string()
      .min(1)
      .max(
        300,
        "a tooltip, not an essay — put anything longer in the connector's docs",
      )
      .optional(),
    /** Where this step is carried out, when it happens somewhere else. */
    link: connectorDocLinkSchema.optional(),
    /**
     * Literal values the step tells the admin to choose — "Internal", "Web
     * application". Each is emboldened where it appears in `text`, so the thing
     * to type or pick is findable without reading the sentence twice.
     *
     * Values, not emphasis: this is for a string the admin must match exactly in
     * someone else's form, and every entry must actually appear in `text`, which
     * the build checks.
     */
    values: z.array(z.string().min(1)).optional(),
    /**
     * Render this deployment's redirect URI, with a copy button, directly beneath
     * this step.
     *
     * Declared rather than inferred: the redirect URI is the one value in the
     * whole guide the manifest cannot contain — it is built from the running
     * deployment's origin — and it is useless anywhere except beside the step
     * that asks you to paste it into someone else's form.
     */
    showRedirectUri: z.boolean().optional(),
  })
  .superRefine((step, ctx) => {
    for (const value of step.values ?? []) {
      // Same whole-phrase rule the UI uses to find them; a value that is not in
      // the sentence would simply never render, which is a silent no-op.
      const pattern = new RegExp(
        `(^|[^\\w])${value.replace(/[.*+?^${}()|[\]\\]/g, "\\$&")}($|[^\\w])`,
      );
      if (!pattern.test(step.text)) {
        ctx.addIssue({
          code: "custom",
          message:
            `values entry ${JSON.stringify(value)} does not appear in this step's text, ` +
            "so nothing would be emboldened. Match it exactly, or drop it.",
          path: ["values"],
        });
      }
    }
  });

/**
 * Provisioning instructions, structured so the admin page can render them as a
 * numbered list with working links.
 *
 * This exists because `description` could not carry a link. It is also the only
 * way the platform can interleave a fact the manifest cannot know — chiefly the
 * redirect URI, which is derived from this deployment's origin at runtime —
 * into the middle of a provider's own steps, which is exactly where an admin
 * needs it.
 */
/**
 * Notes attached to the platform's own setup steps.
 *
 * The registry generates "save credentials", "authorize" and "verify" itself —
 * it knows when each is done, because it can check. What it cannot know is the
 * one provider-specific warning that belongs at each: for Gmail, that whoever
 * approves the consent screen is the mailbox everyone will then read. Putting
 * that at the top of the dialog shows it on arrival, minutes before it matters
 * and long before it means anything; here it appears attached to the button it
 * is about.
 */
const connectorSetupNotesSchema = z.strictObject({
  credentials: z.string().min(1).optional(),
  authorize: z.string().min(1).optional(),
  verify: z.string().min(1).optional(),
});

const connectorSetupSchema = z.strictObject({
  /**
   * Label for the provider-side step — "Create a Google Cloud OAuth app".
   * Defaults to "Get your credentials", which is accurate but says less.
   */
  title: z.string().min(1).max(60).optional(),
  /**
   * The provider-side work only — what an admin does in someone else's console
   * before they have anything to paste in. Do NOT list "save the credentials",
   * "press Connect" or "test the connection": the registry renders those as its
   * own steps and, unlike these, knows whether they are done.
   */
  steps: z.array(connectorSetupStepSchema).min(1),
  notes: connectorSetupNotesSchema.optional(),
  /** Reference material — scope tables, API docs. Not steps to carry out. */
  docs: z.array(connectorDocLinkSchema).optional(),
});

/**
 * Path to the connector's icon, relative to its own `assets/` directory.
 *
 * Written as the real relative path — `assets/icon.svg`, not `icon.svg` — so
 * the manifest says where the file actually is rather than leaving `assets/`
 * implied. Constrained to that directory: the generator copies `assets/` into
 * `public/connector-assets/<name>/` and builds a URL from this value, so an
 * absolute path, a `..` segment or a URL would either escape that directory or
 * silently produce a broken `<img>`. The generator additionally proves the file
 * exists, and that a raster icon is a square of at least 512x512 or an SVG
 * carries a viewBox — see validateConnectorIcon().
 */
const connectorIconSchema = z
  .string()
  .min(1)
  .refine(
    (v) =>
      v.startsWith("assets/") &&
      !v.includes("..") &&
      !/^[a-z][a-z0-9+.-]*:/i.test(v) &&
      v.length > "assets/".length,
    'must be a path inside the connector\'s own assets/ directory, written out in full — e.g. "assets/icon.svg"',
  );

export const RawConnectorManifestSchema = z
  .strictObject({
    name: z.string().min(1),
    displayName: z.string().min(1),
    icon: connectorIconSchema.optional(),
    /**
     * Each person signs into their own account, rather than everyone sharing one
     * the admin connected.
     *
     * The default — and the right answer for most connectors — is tenant-scoped:
     * one credential set, one grant, and every user of every app sees the same
     * response. Set this only when one shared account is genuinely wrong, as it
     * is for a person's own mail or calendar. It costs the property that made the
     * tenant model easy to reason about, so it is opt-in and narrow.
     *
     * Three-legged OAuth only. See docs/connectors/architecture.md.
     */
    userScoped: z.boolean().optional(),
    /** ISO 8601 date-time, stamped by scripts/stamp-updated.ts. Never hand-edited. */
    lastUpdated: z.iso.datetime().optional(),
    /**
     * What the SERVICE is — "Highly popular email service by Google" — not what
     * this connector does with it, and not how to set it up.
     *
     * Capped because this field is where a 1,400-character block of numbered
     * setup steps once lived, for want of anywhere better; `setup` is that
     * somewhere now, and a limit is what stops the prose migrating back. 140 is
     * two real sentences — and the registry tile shows the first 15 words of it,
     * so the cap also bounds how far a tile can be from the whole truth.
     */
    description: z
      .string()
      .max(
        140,
        'keep it to ~2 sentences about the service itself. Provisioning steps go in "setup"',
      )
      .optional(),
    /**
     * One line for a listing card.
     *
     * Distinct from `description`, which answers "what is this service?" in up
     * to 140 characters. This is the version that fits beside the icon in a
     * catalogue grid, and for most connectors only one of the two is worth
     * writing — `description` stands in where this is absent.
     */
    tagline: taglineSchema.optional(),
    /** Catalogue search and browse terms. */
    keywords: catalogueKeywordsSchema.optional(),
    /**
     * SPDX identifier or expression, or `UNLICENSED`.
     *
     * The connector's own licence, not the upstream service's terms. A
     * connector is code someone redistributes; whether the API it talks to is
     * free to use is a different question and not one a manifest can answer.
     */
    license: licenseSchema.optional(),
    /** Homepage, docs, or repository directory for the connector. */
    connectorUrl: listingUrlSchema.optional(),
    /** Where a user reports a problem with the connector. */
    connectorSupportUrl: listingUrlSchema.optional(),
    setup: connectorSetupSchema.optional(),
    credentialFields: z.array(credentialFieldSchema).optional(),
    authors: z.array(authorSchema).optional(),
    telemetry: z.array(connectorTelemetryEventSchema).optional(),
    auth: connectorAuthSchema.optional(),
    http: connectorHttpSchema.optional(),
    webhook: connectorWebhookSchema.optional(),
  })
  .superRefine((m, ctx) => {
    // Per-user credentials only mean something for a flow where each person can
    // present their own identity. An API key is one string an admin pastes; a
    // "user-scoped" one would be the tenant key wearing a label.
    if (m.userScoped && m.auth?.strategy !== "oauth2_authorization_code") {
      ctx.addIssue({
        code: "custom",
        message:
          `"userScoped" requires auth.strategy "oauth2_authorization_code"; ` +
          `this connector uses "${m.auth?.strategy ?? "none"}". There is no ` +
          `per-user equivalent of an API key an admin pastes once.`,
        path: ["userScoped"],
      });
    }

    // The redirect URI belongs to the three-legged flow and nothing else, and an
    // OAuth connector that never shows it strands the admin: it cannot be
    // guessed, and the provider rejects the authorization without it. So it is
    // required exactly once, and rejected everywhere else.
    const redirectSteps = (m.setup?.steps ?? []).filter(
      (s) => s.showRedirectUri,
    );
    const isThreeLegged = m.auth?.strategy === "oauth2_authorization_code";
    if (redirectSteps.length > 0 && !isThreeLegged) {
      ctx.addIssue({
        code: "custom",
        message:
          "showRedirectUri is only meaningful for auth.strategy " +
          `"oauth2_authorization_code"; this connector uses "${m.auth?.strategy ?? "none"}".`,
        path: ["setup", "steps"],
      });
    }
    if (isThreeLegged && m.setup && redirectSteps.length !== 1) {
      ctx.addIssue({
        code: "custom",
        message:
          `exactly one setup step must set "showRedirectUri": true (found ${redirectSteps.length}). ` +
          "A three-legged connector cannot be configured without registering the redirect URI upstream.",
        path: ["setup", "steps"],
      });
    }

    // Every credential key the policy reads must be a field the admin is
    // actually asked for. A mismatch here is invariant 10 failing silently: the
    // connector reads a key nobody ever filled in.
    const declared = new Set((m.credentialFields ?? []).map((f) => f.key));
    const referenced = [
      ...(m.auth?.credentialKeys ?? []),
      ...(m.webhook ? [m.webhook.secretKey] : []),
    ];
    for (const key of referenced) {
      if (!declared.has(key)) {
        ctx.addIssue({
          code: "custom",
          message:
            `references credential "${key}", which is not in credentialFields. ` +
            `Declared: ${declared.size ? [...declared].join(", ") : "(none)"}.`,
          path: ["credentialFields"],
        });
      }
    }
  });

// ── themes ───────────────────────────────────────────────────────────────────

const themeFontFaceSchema = z.strictObject({
  family: z.string().min(1),
  /** Path relative to the theme's assets/ directory. Existence checked by the generator. */
  file: z.string().min(1),
  weight: z.union([z.number().int().min(1).max(1000), z.string().min(1)]),
  style: z.enum(["normal", "italic"]).default("normal"),
  display: z.enum(["auto", "block", "swap", "fallback", "optional"]).optional(),
});

const themeAssetsSchema = z.strictObject({
  logo: z.string().min(1).optional(),
  favicon: z.string().min(1).optional(),
  appIcon192: z.string().min(1).optional(),
  appIcon512: z.string().min(1).optional(),
  preview: z.string().min(1).optional(),
});

/**
 * The brand slots a theme claims. Each one declared is final — no app filter
 * runs for it — so a theme that only wants a default mark uses `assets.logo`,
 * which apps may replace, rather than this.
 *
 * Logo paths are relative to `assets/`, like every other theme asset. Whether
 * they exist and can be measured is checked by the generator.
 */
const themeBrandingSchema = z.strictObject({
  name: z
    .string()
    .refine(
      (v) => sanitizeBrandName(v) === v,
      `a single line of 1–${BRAND_NAME_MAX_LENGTH} characters, without leading or trailing spaces`,
    )
    .optional(),
  menuBarLogo: z.string().min(1).optional(),
  loginLogo: z.string().min(1).optional(),
});

/**
 * Escaping the contrast gate is possible, declared, and visible — never silent,
 * and never a flag that merely turns the check off. The theme must name the
 * exact pair, so the escape stays scoped to the one decision that was actually
 * reviewed, and `reason` must be a sentence someone can act on. The generator
 * additionally rejects an escape for a pair that passes: a stale escape reads
 * as "reviewed and accepted" while protecting nothing.
 */
const themeEscapeSchema = z.strictObject({
  rule: z.literal("contrast-aa"),
  pair: z.string().min(1),
  reason: z
    .string()
    .min(15, "give a reason a reviewer can act on, not a placeholder"),
});

export const RawThemeManifestSchema = z.strictObject({
  name: z.string().min(1),
  description: z.string().min(1),
  /**
   * One line for a listing card. `description` is the full explanation; this is
   * the version that fits under the theme's name in a catalogue grid.
   */
  tagline: taglineSchema.optional(),
  /** Catalogue search and browse terms. */
  keywords: catalogueKeywordsSchema.optional(),
  /**
   * SPDX identifier or expression, or `UNLICENSED`.
   *
   * Worth stating explicitly for a theme even though it is "only" CSS: a theme
   * carries fonts and brand assets, and whether those may be redistributed is
   * exactly the question a licence answers.
   */
  license: licenseSchema.optional(),
  /** Homepage, docs, or repository directory for the theme. */
  themeUrl: listingUrlSchema.optional(),
  /** Where a user reports a problem with the theme. */
  themeSupportUrl: listingUrlSchema.optional(),
  authors: z.array(authorSchema).optional(),
  /** ISO 8601 date-time, stamped by scripts/stamp-updated.ts. Never hand-edited. */
  lastUpdated: z.iso.datetime().optional(),
  fonts: z.array(themeFontFaceSchema).optional(),
  assets: themeAssetsSchema.optional(),
  /** Brand slots this theme claims outright. See `themeBrandingSchema`. */
  branding: themeBrandingSchema.optional(),
  /**
   * Listing gallery, under `themes/<slug>/screenshots/`.
   *
   * Distinct from `assets.preview`, which is the admin picker's thumbnail and
   * stays where it is. The picker shows one image beside a live swatch row;
   * a listing shows a gallery to someone who has not installed the theme and
   * cannot see those swatches at all.
   */
  screenshots: screenshotsSchema.optional(),
  /**
   * Allowlisted .mix-* surfaces this theme styles. Cross-checked against
   * theme.css by the generator in both directions, so it can neither
   * under-report a theme's reach nor carry a stale entry.
   */
  surfaces: z.array(z.string().min(1)).optional(),
  escapes: z.array(themeEscapeSchema).optional(),
});

/**
 * Render a ZodError as a compact, human-readable, multi-line string suitable
 * for a build-abort message. Each issue is `  - <path>: <message>`.
 */
export function formatZodError(error: z.ZodError): string {
  return error.issues
    .map((issue) => {
      const where = issue.path.length ? issue.path.join(".") : "(root)";
      return `  - ${where}: ${issue.message}`;
    })
    .join("\n");
}
