/* This Source Code Form is subject to the terms of the Mozilla Public
 * License, v. 2.0. If a copy of the MPL was not distributed with this
 * file, You can obtain one at https://mozilla.org/MPL/2.0/. */

import type { Screenshot } from "../screenshots";
import type { BrandHook, BrandLogoAsset } from "../branding/types";

/**
 * How a caller may authenticate to a page or API route.
 *
 * - `session` (the default): a signed-in user who has been granted this app.
 *   Served under `/apps/<slug>/...` and `/api/apps/<slug>/...`.
 * - `signed-in`: any signed-in user, grant or not. For cross-app discovery
 *   surfaces that should not require installing the app first.
 * - `password`: a visitor holding this app's unlock cookie — the app-wide
 *   password set by the installing admin, valid 24h and scoped to the slug.
 * - `key`: a scoped API key. Machine-to-machine; there is no user. API routes
 *   only — a page has no API-key transport.
 * - `public`: anyone on the internet. No identity at all.
 *
 * A route declares a *set*, and the gateway resolves the strongest auth the
 * caller actually presents. A set is not a fallback chain: declaring
 * `["session", "public"]` is a statement that the handler covers both branches,
 * and the compiler enforces it by widening `context.user` to nullable.
 *
 * Anything not declared in the manifest defaults to `["session"]`.
 */
export type RouteAuth = "session" | "signed-in" | "password" | "key" | "public";

/** Every auth a route may declare. */
export const ALL_ROUTE_AUTHS: readonly RouteAuth[] = [
  "session",
  "signed-in",
  "password",
  "key",
  "public",
];

/**
 * Auths that carry no user identity. A route accepting any of these is derived
 * into the public mount (`/p/<slug>/...`, `/api/p/<slug>/...`) by the registry
 * generator, which is also what the proxy's public-prefix allowlist is built
 * from — so "what is reachable without signing in" stays answerable from one
 * generated file rather than from reading every manifest.
 */
export const ANONYMOUS_AUTHS: readonly RouteAuth[] = [
  "password",
  "key",
  "public",
];

export function isAnonymousAuth(auth: RouteAuth): boolean {
  return ANONYMOUS_AUTHS.includes(auth);
}

/** True when any declared auth reaches the app without a session. */
export function servesPublicSurface(auths: readonly RouteAuth[]): boolean {
  return auths.some(isAnonymousAuth);
}

/**
 * What the public mount must do before serving a page or route.
 *
 * Strongest-wins in the visitor's favour: a surface that accepts `public` needs
 * no gate at all, even if it also accepts `password`, because the password
 * would be protecting something already given away. `none` means the surface is
 * not reachable without a session and the mount must 404 — never 401, so a
 * prober cannot tell "exists but forbidden" from "no such route".
 */
export function publicGateFor(
  auths: readonly RouteAuth[] | undefined,
): "open" | "password" | "key" | "none" {
  if (!auths || auths.length === 0) return "none";
  if (auths.includes("public")) return "open";
  if (auths.includes("password")) return "password";
  // `key` is authenticated by a header, not a cookie, so the public mount serves
  // it without a gate of its own — `resolveAuthTier` does the checking.
  if (auths.includes("key")) return "key";
  return "none";
}

export interface AppManifest {
  /** Derived from the app's folder name — not set in app.json */
  slug: string;
  name: string;
  description: string;
  /**
   * One line that says what the app is for, for a listing that has room for a
   * sentence and not a paragraph — the catalogue grid, a tile subtitle.
   *
   * Distinct from `description`, which is the full explanation. An app that
   * sets only one of the two is the normal case; the UI falls back to
   * `description` when this is null. Maps to a catalogue listing's `tagline`.
   */
  tagline: string | null;
  icon: string;
  /**
   * Names of connectors this app uses. Every connector is tenant-scoped: one
   * admin-configured credential set in `connector_configs`, shared by all
   * users. An admin must configure each one before the app can be registered.
   */
  connectors: string[];
  /**
   * Connectors a part of this app uses but which it works without. Never gates
   * registration; present in `context.connectors` only when configured, so app
   * code must handle the entry being missing.
   */
  optionalConnectors: string[];
  database: boolean;
  /** When true, the app can send Web Push via `context.notifications`. */
  notifications: boolean;
  hasPages: boolean;
  /**
   * How many pages the app serves — every directory under `pages/` holding a
   * `Main.tsx`, at any depth. Derived by the registry generator; never set in
   * app.json.
   *
   * Can be 0 while `hasPages` is true: a `pages/` directory with a shared
   * component in it and no `Main.tsx` is non-empty but serves nothing.
   */
  pageCount: number;
  /** When true, the app is implicitly granted to every user and cannot be revoked. */
  global: boolean;
  /**
   * App-specific roles. Role keys are meaningful only within this app — the
   * platform stores a user's assigned role on their grant and exposes it via
   * `context.user.hasRole([...])`, but the policy (what each role can do) lives
   * entirely in the app. Defaults to `[]` (no roles).
   */
  roles: AppRole[];
  /**
   * Role key auto-assigned to a user the moment they're granted this app. Must
   * match one of `roles[].key`. A user with no explicitly-set role resolves to
   * this default. `null` when the app declares no default.
   */
  defaultRole: string | null;
  hookCounts: { actions: number; filters: number };
  /**
   * Hook names captured from string-literal hook calls in the app's source.
   * `emits` are hooks the app fires (`doAction`/`applyFilters`); `listens` are
   * hooks it registers for (`addAction`/`addFilter`). Custom names are
   * slug-qualified (e.g. `sales:new-deal`); core names pass through unprefixed.
   */
  hooks: {
    emits: { actions: string[]; filters: string[] };
    listens: { actions: string[]; filters: string[] };
  };
  authors: AppAuthor[];
  /**
   * Search and browse terms for the catalogue. Lowercase, because a facet list
   * dedupes on the exact string and `Gmail` next to `gmail` is two facets for
   * one idea. Defaults to `[]`.
   */
  keywords: string[];
  /**
   * Listing gallery, from `apps/<slug>/screenshots/`. Defaults to `[]`.
   *
   * Partly authored, partly derived: `app.json` declares `file`, `alt` and
   * `caption`; the generator verifies the file, measures it, and fills in
   * `url`, `width` and `height`. Never written by hand in full.
   */
  screenshots: Screenshot[];
  /**
   * SPDX identifier or expression for the app's licence (e.g. `MPL-2.0`), or
   * `UNLICENSED` for one that is not redistributable. `null` when undeclared —
   * which a catalogue must read as "unknown", never as "permissive".
   */
  license: string | null;
  /**
   * Where the app lives for someone who wants to read about it — a homepage,
   * a docs site, a repository directory. Maps to a catalogue listing's
   * `homepageUrl`. `null` when the app declares none.
   */
  appUrl: string | null;
  /**
   * Where a user takes a problem with this app — an issue tracker, a support
   * page. Maps to a catalogue listing's `issuesUrl`. Kept separate from
   * `appUrl` because "read about it" and "something is broken" are different
   * destinations, and collapsing them sends bug reports to a marketing page.
   */
  appSupportUrl: string | null;
  /**
   * Epoch millis of the last commit that touched this item, stamped into the
   * manifest by scripts/stamp-updated.ts. Null when nothing has been committed
   * yet — the UI renders that as "Not yet committed", not as a missing value.
   *
   * The manifest stores this as an ISO 8601 string (legible in a diff); the
   * generator parses it to millis here so the UI can do date arithmetic without
   * re-parsing on every render.
   *
   * Derived from the commit, not from a separate publish step: any commit
   * touching the directory rewrites it. That means a formatting pass or a
   * dependency bump inside the item does move the date — the tradeoff accepted
   * in exchange for a date that can never be forgotten. Written only by
   * scripts/stamp-updated.ts.
   */
  lastUpdated: number | null;
  /**
   * Declared exceptions to platform guarantees. Visible on the admin app page.
   * Defaults to `[]` — an app with no escapes is the normal case.
   */
  escapes: AppEscape[];
  /**
   * App-scoped settings an admin fills in, reached as `context.env.<KEY>`.
   * Defaults to `[]` (no `context.env` client).
   */
  env: AppEnvField[];
  /**
   * Hostnames `context.http` may reach. Raw `fetch` is lint-banned in app code,
   * so this is the complete set of destinations an app can originate a request
   * to that isn't a connector. Defaults to `[]`.
   */
  egress: string[];
  /**
   * Declarative incremental syncs. Each `name` maps to a handler at
   * `apps/<slug>/sync/<name>.ts`. Defaults to `[]`.
   */
  sync: SyncDefinition[];
  /**
   * Every API route this app declares, hoisted from `defineRoute` at build
   * time. Auto-generated — never set this in a manifest.
   */
  routes: RouteContract[];
  widgets: WidgetDefinition[];
  /**
   * Scheduled jobs this app runs on the platform cron scheduler. Each entry's
   * `name` maps to a handler at `apps/<slug>/jobs/<name>.ts` (default export
   * `async (ctx: SystemAppContext) => void`). The scheduler ticks every 5
   * minutes; a job runs on either a fixed interval (`everyMinutes`) or a
   * wall-clock CRON expression (`cron`). Defaults to `[]`.
   */
  schedules: ScheduleDefinition[];
  /**
   * Key-usage events this app records via `context.telemetry.track(name, ...)`.
   * Each entry declares an event the app is allowed to emit; tracking a name
   * that isn't declared here is a no-op. Defaults to `[]` (no telemetry — the
   * app gets no `context.telemetry` client). See `docs/apps/telemetry.md`.
   */
  telemetry: TelemetryEventDefinition[];
  /**
   * Data services this app exposes to *other* apps (App Services). Each entry's
   * `name` maps to a handler at `apps/<slug>/services/<name>.ts` (default export
   * `async (ctx: ServiceContext, params) => result`). A consumer reaches these
   * only via the platform broker (`context.services.request(...)`), never by
   * importing another app or reading its tables. Defaults to `[]`. See
   * `docs/apps/app-services.md`.
   */
  provides: ServiceDefinition[];
  /**
   * Data services this app requests from *other* apps. Each entry must match a
   * `provides` service on the target app whose `consumers` allowlist includes
   * this app — the generator enforces this two-sided consent at build time.
   * Declaring a dependency is what attaches the `context.services` client.
   * Defaults to `[]`.
   */
  consumes: ServiceDependency[];
  /**
   * Hooks this app fires and who may listen. Two-sided consent, default-deny —
   * the generator rejects a listener the emitter did not allow. Defaults to `[]`.
   */
  emits: HookEmit[];
  /** Hooks from other apps this app listens for. Defaults to `[]`. */
  listensTo: HookListen[];
  /**
   * The brand hooks this app filters, and why. `null` when it filters none.
   *
   * Declared because changing the name and mark on the sign-in page is a
   * capability an admin should see before activating the app. The generator
   * holds the declaration to the code in both directions: every hook listed
   * here is registered in `hooks.ts`, and every brand-hook registration is in
   * `hooks.ts` and listed here. See `docs/apps/hooks.md#brand-hooks`.
   */
  branding: AppBranding | null;
  /**
   * Read-only tools this app contributes to the MixOS MCP server. Each entry's
   * `name` maps to a handler at `apps/<slug>/mcp/<name>.ts` (default export
   * `async (ctx: McpToolContext, input) => result`, plus a named `inputSchema`
   * Zod export used to derive the tool's JSON Schema). Exposed to clients as
   * `<slug>__<name>`.
   *
   * A tool is reachable only when the connecting user authorized this app on the
   * MCP consent screen *and* still has a grant for it — consent is a ceiling,
   * the live grant is the floor. Defaults to `[]` (no tools, and the app never
   * appears on the consent screen). See `docs/apps/mcp.md`.
   */
  mcp: McpToolDefinition[];
  /**
   * Per-page visibility declarations. Keys are POSIX paths relative to
   * `apps/<slug>/pages/`, *without* leading or trailing slash; the empty
   * string `""` refers to the root page (`pages/Main.tsx`). Example:
   * `{ "": ["public"], "report/[id]": ["password", "session"] }`. Unlisted
   * pages default to `["session"]`. The registry generator verifies every key
   * resolves to a real `Main.tsx` on disk and refuses to build otherwise.
   */
  pageVisibility?: Record<string, RouteAuth[]>;
  /**
   * Per-API-route visibility declarations. Keys are POSIX paths relative
   * to `apps/<slug>/api/`, with the same conventions as `pageVisibility`
   * (`""` is the index route at `api/index/route.ts` — practically uncommon).
   * Unlisted routes default to `["session"]`.
   *
   * PREFER DECLARING THE AUTH ON THE ROUTE ITSELF. `defineRoute({ auth: [...] })`
   * sits next to the handler it governs, and the compiler uses it to type
   * `context.user`. This map exists for the page-parity case and as the
   * manifest-level view an admin reads; where both are present the generator
   * requires them to agree.
   */
  apiVisibility?: Record<string, RouteAuth[]>;
}

/**
 * The rules an app may escape. One, now: see ESCAPE_RULES in
 * scripts/manifest-schemas.ts for the four that were removed and why.
 */
export type EscapeRule = "raw-response";

/**
 * A declared exception to a platform guarantee.
 *
 * Escapes are the only way out, and they are on the record: named from a closed
 * set, carrying a reason a reviewer can act on, and shown on the app's admin
 * dialog. They are also load-bearing — the generator refuses the construct when
 * its escape is missing — and the set is closed deliberately: an unknown rule
 * name is a build failure rather than a no-op, because a typo'd escape reads as
 * "declared" to a reviewer while enforcing nothing.
 */
export interface AppEscape {
  rule: EscapeRule;
  reason: string;
}

/**
 * An app-scoped setting an admin fills in, reached in a handler as
 * `context.env.<KEY>`.
 *
 * This exists so that `process.env` can be banned outright in app code. An app
 * that reads the raw environment can read `CONNECTOR_ENCRYPTION_KEY` and
 * `DATABASE_URL`; an app that reads `context.env` can only see
 * what it declared here. `password`-typed values are encrypted at rest on the
 * same AES-256-GCM path connector credentials use.
 */
export interface AppEnvField {
  key: string;
  label: string;
  type: "text" | "password";
  required?: boolean;
}

/** The cadence half of a schedule — exactly one of `everyMinutes` or `cron`. */
export interface ScheduleCadence {
  everyMinutes?: number;
  cron?: string;
  timezone?: string;
}

/**
 * How far back a sync reaches, and how its window adapts.
 *
 * The platform halves the window when it fails to drain inside the budget and
 * relaxes it back toward `defaultDays` when it succeeds, persisting the current
 * size across ticks. An app supplies the bounds; it never implements the tuning.
 */
export interface SyncWindow {
  /** How far back a cold sync reaches on its first run. */
  coldStartDays: number;
  /** The steady-state window size. */
  defaultDays: number;
  /** The floor the window may shrink to under load. */
  minDays: number;
}

/**
 * A declarative incremental sync (`apps/<slug>/sync/<name>.ts`).
 *
 * The app writes only `fetchPage` and `upsert`. The platform owns the watermark
 * table, the wall-clock budget checked at every page boundary, the window
 * tuning, the drained-versus-truncated rule that decides whether the watermark
 * advances, the empty-result guard, and cache invalidation.
 *
 * The provider's pagination cursor lives inside one run's loop and is never
 * persisted — which is the whole point. Storing a cursor across ticks is the
 * single most expensive mistake this platform has seen (278 consecutive job
 * failures over 19 days, watermark never advancing), and declaring the sync
 * rather than hand-rolling it makes that mistake unrepresentable.
 */
export interface SyncDefinition {
  name: string;
  schedule: ScheduleCadence;
  /** A connector slug the app declares, or `"mixos"` for MixOS-only data. */
  source: string;
  window: SyncWindow;
  /** Wall-clock ceiling for one tick, under the platform job timeout. */
  budgetMs: number;
}

/** One HTTP method's hoisted contract, read off `defineRoute` at build time. */
export interface RouteMethodContract {
  method: "GET" | "POST" | "PUT" | "PATCH" | "DELETE";
  auth: RouteAuth[];
  roles: string[];
  budget: { connectorCalls: number; ms: number };
  /** The route owns its own Response: no output schema, no payload cap. */
  raw: boolean;
  hasInput: boolean;
  hasOutput: boolean;
  summary?: string;
}

/**
 * A route's contract as hoisted into the registry.
 *
 * The declaration lives next to the handler (`defineRoute`), so it cannot drift
 * from the code it governs; the generator lifts the statically-readable half
 * here so the build, the gateway, the proxy's public allowlist and the admin
 * page can all read it without importing app code.
 */
export interface RouteContract {
  /** POSIX path relative to `apps/<slug>/api/`; `""` is the root route. */
  path: string;
  /** Dynamic segment names in path order, e.g. `["id"]` for `items/[id]`. */
  params: string[];
  methods: RouteMethodContract[];
}

export interface AppAuthor {
  name: string;
  email: string;
}

/** An app-specific role. Isolated to the declaring app. */
export interface AppRole {
  /** Stable identifier stored on the grant and passed to `hasRole()`. */
  key: string;
  /** Human-readable name shown in admin UI. */
  label: string;
}

/**
 * A scheduled job declared by an app. A job sets **exactly one** cadence:
 * `everyMinutes` (fixed interval) or `cron` (wall-clock). Enforced by manifest
 * validation.
 */
export interface ScheduleDefinition {
  /** Handler name — maps to `apps/<slug>/jobs/<name>.ts`. */
  name: string;
  /** Interval cadence in minutes. Minimum 5, and a multiple of 5 (the tick size). */
  everyMinutes?: number;
  /**
   * Standard 5-field CRON expression (minute hour day-of-month month
   * day-of-week), evaluated at 5-minute tick resolution. Mutually exclusive
   * with `everyMinutes`.
   */
  cron?: string;
  /**
   * IANA timezone for `cron` (e.g. `"America/New_York"`). Defaults to UTC.
   * Only valid alongside `cron`.
   */
  timezone?: string;
}

/**
 * A key-usage event an app declares it may record. The `name` is passed to
 * `context.telemetry.track(name, ...)`; the optional `description` is
 * self-documentation shown in the admin Analytics view.
 */
export interface TelemetryEventDefinition {
  name: string;
  description?: string;
}

/**
 * A data service one app exposes to others (App Services). The handler lives at
 * `apps/<slug>/services/<name>.ts`. See `docs/apps/app-services.md`.
 */
export interface ServiceDefinition {
  /** Service name — maps to `apps/<slug>/services/<name>.ts`. */
  name: string;
  description?: string;
  /**
   * `"user"` (default): the request runs on behalf of the current user; the
   * platform verifies the user has *this* (provider) app before invoking, so a
   * consumer can never surface data the user couldn't already reach here.
   * `"app"`: service-account — callable regardless of the user's access to this
   * app (and from user-less job contexts). Use only for data safe to share
   * app-wide.
   */
  audience?: "user" | "app";
  /**
   * Which consumer apps may call this service. An explicit allowlist of app
   * slugs, or `"*"` for any app that declares the dependency. There is no
   * implicit access — default deny.
   */
  consumers: string[] | "*";
}

/**
 * A read-only tool an app contributes to the MixOS MCP server. The handler lives
 * at `apps/<slug>/mcp/<name>.ts`. See `docs/apps/mcp.md`.
 */
/**
 * The `sources` entry for data that exists only in MixOS — curated in an
 * app's own database by its jobs or its users, with no upstream system holding
 * a copy. Distinct from a connector slug, and load-bearing: it tells a client
 * that no other connected server can answer the question, which is the one
 * situation where a MixOS tool genuinely has no competition.
 */
export const MIXOS_SOURCE = "mixos";

/**
 * A read-only MCP tool as declared in `app.json`.
 *
 * Everything here is written for a model, and a model reads it pooled into one
 * flat list beside tools from every other server the user has connected —
 * monday.com's, Slack's, whatever else. That shared list is the reason the
 * `sources` / `notCovered` fields exist and the reason the build rejects
 * jurisdiction language: a tool that claims a whole subject area ("start here
 * for any question about X") outranks a neighbouring tool that only described
 * its mechanics, and it wins even when the neighbour held the better answer.
 *
 * Describe the data you have, name where it came from, and say what it does not
 * cover. That is enough for a model to route correctly, and — unlike a claim on
 * a topic — it can lose gracefully to a better-suited tool.
 */
export interface McpToolDefinition {
  /**
   * Tool name — maps to `apps/<slug>/mcp/<name>.ts`. Lowercase-hyphenated.
   * Exposed to MCP clients as `<slug>__<name>`, so neither the slug nor the
   * name may contain `__` (the generator enforces this).
   */
  name: string;
  /**
   * What this tool returns, written **for a model**. Together with the derived
   * input schema this is the only thing a client sees when deciding whether to
   * call the tool — a vague description means it never gets called, or gets
   * called wrongly. Required.
   */
  description: string;
  /**
   * Optional extra guidance on *when* to reach for this tool. Phrase it as the
   * shape of question this data answers ("Use for a named customer's adoption
   * trend"), not as a claim over a subject area. Appended to the description.
   */
  hint?: string;
  /**
   * Where this tool's data actually comes from: connector slugs the app
   * declares in `connectors`, or the literal `"mixos"` for data that lives only
   * in MixOS (curated in the app's own database, with no upstream system
   * holding a copy). Non-empty; the generator rejects a slug the app has not
   * declared, so a tool cannot claim provenance it doesn't have.
   *
   * Rendered into the description as a `Built from:` line. It is what lets a
   * model tell "the joined, cached view of monday.com" apart from "monday.com", and
   * so hand a raw-record question to the source system's own connector.
   */
  sources: string[];
  /**
   * What a reader might reasonably expect from this tool and will not get —
   * adjacent data, excluded records, a limit of the underlying source. One
   * short fragment; rendered as a `Not covered:` line.
   *
   * This is the field that makes the tool's claim losable, so it is worth more
   * care than its length suggests. Prefer a concrete exclusion ("accounts with
   * no Gong calls") over a hedge ("may be incomplete").
   */
  notCovered?: string;
}

/**
 * A hook this app fires, and the apps allowed to listen.
 *
 * The push counterpart of `provides`. Before this, cross-app hook listening was
 * the only channel between two apps with no consent on either side.
 */
/**
 * An app's declaration that it filters the brand. See `AppManifest.branding`.
 */
export interface AppBranding {
  hooks: BrandHook[];
  /** A sentence an admin can act on, shown in the app's details dialog. */
  reason: string;
  /**
   * Marks the app ships under `apps/<slug>/branding/`, published to
   * `/branding/apps/<slug>/`. A logo filter selects one by returning its
   * `file`. Measured by the generator.
   */
  logos: BrandLogoAsset[];
}

export interface HookEmit {
  name: string;
  description?: string;
  consumers: string[] | "*";
}

/** A hook this app listens for, declared by the listener. */
export interface HookListen {
  app: string;
  hook: string;
}

/** A dependency on another app's service, declared by the consumer. */
export interface ServiceDependency {
  /** Provider app slug. */
  app: string;
  /** Provider service name (must exist in the provider's `provides`). */
  service: string;
}

export interface WidgetDefinition {
  /** Derived from the widget's filename (e.g., my-widget.tsx → "my-widget") */
  id: string;
  name: string;
  description: string;
  defaultSize?: { w: number; h: number };
  minSize?: { w: number; h: number };
  component: string;
  config?: WidgetConfigField[];
}

export interface WidgetConfigField {
  key: string;
  label: string;
  type: "text" | "number" | "boolean" | "select" | "multiselect";
  required?: boolean;
  default?: unknown;
  options?: { label: string; value: string }[];
  /** For `multiselect` only: enable drag-to-reorder. Array order becomes display order. */
  ordered?: boolean;
}
