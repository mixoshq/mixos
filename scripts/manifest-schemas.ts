import { z } from "zod";
import { assertValidCron } from "../src/lib/apps/cron";

/**
 * Zod schemas for the *on-disk* manifest shapes — `apps/<slug>/app.json`
 * (or the default export of `app.ts`) and `connectors/<name>/connector.json`.
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

const authorSchema = z
  .strictObject({
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
      .refine((n) => n % 5 === 0, { message: "everyMinutes must be a multiple of 5" })
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
 * `SUPABASE_SERVICE_ROLE_KEY`; an app reading `context.env` sees only what it
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

const appTelemetryEventSchema = z.strictObject({
  name: z.string().min(1),
  description: z.string().optional(),
});

const connectorTelemetryEventSchema = z.strictObject({
  method: z.string().min(1),
  description: z.string().optional(),
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
    pattern: /\b(?:always|by default)\s+(?:use|call|prefer|reach for|start with)\b/i,
    why: "an unconditional routing instruction leaves no room for a better source",
  },
  {
    pattern: /\bprefer(?:\s+[\w-]+){0,3}\s+over\b/i,
    why: "ranking this tool against others is a claim a description cannot support",
  },
  {
    pattern: /\b(?:authoritative|canonical|definitive|single|sole|only)\s+source\b/i,
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
    icon: z.string().optional(),
    authors: z.array(authorSchema).optional(),
    connectors: z.array(z.string().min(1)).optional(),
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
  .refine((m) => m.defaultRole == null || !!m.roles?.some((r) => r.key === m.defaultRole), {
    message:
      'defaultRole must match one of the declared roles[].key (and roles must be declared)',
    path: ["defaultRole"],
  })
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
    scopes: z.array(z.string().min(1)).optional(),
  })
  .superRefine((a, ctx) => {
    if (a.strategy === "apiKey" && (a.in === "header" || a.in === "query") && !a.name) {
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

export const RawConnectorManifestSchema = z.strictObject({
  name: z.string().min(1),
  displayName: z.string().min(1),
  /** ISO 8601 date-time, stamped by scripts/stamp-updated.ts. Never hand-edited. */
  lastUpdated: z.iso.datetime().optional(),
  description: z.string().optional(),
  credentialFields: z.array(credentialFieldSchema).optional(),
  authors: z.array(authorSchema).optional(),
  telemetry: z.array(connectorTelemetryEventSchema).optional(),
  auth: connectorAuthSchema.optional(),
  http: connectorHttpSchema.optional(),
  webhook: connectorWebhookSchema.optional(),
}).superRefine((m, ctx) => {
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
