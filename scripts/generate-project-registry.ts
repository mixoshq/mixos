/* This Source Code Form is subject to the terms of the Mozilla Public
 * License, v. 2.0. If a copy of the MPL was not distributed with this
 * file, You can obtain one at https://mozilla.org/MPL/2.0/. */

import fs from "fs";
import path from "path";
import { pathToFileURL } from "url";
import type {
  AppManifest,
  AppAuthor,
  AppBranding,
  AppEnvField,
  AppEscape,
  McpToolDefinition,
  RouteAuth,
  RouteContract,
  RouteMethodContract,
  ScheduleDefinition,
  ServiceDefinition,
  ServiceDependency,
  SyncDefinition,
  TelemetryEventDefinition,
  UpdatedAtColumn,
} from "../src/lib/apps/types";
import { MOS_SOURCE } from "../src/lib/apps/types";
import type {
  ConnectorAuthPolicy,
  ConnectorHttpPolicy,
  ConnectorSetupGuide,
  ConnectorTelemetryDefinition,
  ConnectorWebhookPolicy,
} from "../src/lib/connectors/types";
import {
  RawAppManifestSchema,
  RawConnectorManifestSchema,
  RawThemeManifestSchema,
  formatZodError,
} from "./manifest-schemas";
import type {
  ThemeAssets,
  ThemeFontFace,
  ThemeManifest,
} from "../src/lib/themes/types";
import { compileTheme, ThemeError } from "./theme-css";
import { applyWidgetConfigs } from "./widget-configs";
import { FatalManifestError } from "./manifest-errors";
import { readImageSize } from "./image-size";
import { resolveThemeLogo, validateAppBranding } from "./brand-checks";
import { appMigrationFiles, listAppMigrations } from "./app-migration-files";
import { checkAppMigrationSql, describeAppTables, formatSqlProblems } from "./app-sql-policy";
import {
  appIdentifierProblems,
  appSchemaName,
  appSlugProblem,
} from "../src/lib/apps/app-identifiers";
import {
  checkHookNamespaces,
  formatHookFindings,
  scanHooks,
  validateHookWiring,
} from "./hook-checks";
import { formatFindings, scanAppContainment } from "./app-containment";
import {
  validateConnectorMethods,
  validateConnectorTelemetry,
  validateRegistryContract,
} from "./connector-checks";
import type { Screenshot, ScreenshotKind } from "../src/lib/screenshots";
import {
  SCREENSHOT_EXTENSIONS,
  SCREENSHOT_MAX_BYTES,
  SCREENSHOT_MAX_COUNT,
  SCREENSHOT_MIN_WIDTH,
  screenshotUrl,
} from "../src/lib/screenshots";
import { BRAND_HOOKS } from "../src/lib/branding/types";
import * as ts from "typescript";

/**
 * Thrown when an app is refused for what its code does, not for a malformed
 * manifest — an undeclared escape, or a hook call the hook rules refuse (see
 * scripts/hook-checks.ts). Takes the per-app `Skipping ...`
 * path like any other per-app failure, but prints its own message rather than
 * "invalid manifest", which would send the author to the wrong file.
 */
class AppRejectedError extends Error {
  constructor(message: string) {
    super(message);
    this.name = "AppRejectedError";
  }
}

/**
 * Manifests store `lastUpdated` as an ISO 8601 string (legible in a diff);
 * the runtime registry carries epoch millis so the UI can do date arithmetic
 * without re-parsing on every render. The schema has already rejected anything
 * that isn't a valid ISO date-time, so a parse failure here means the value
 * bypassed validation — fall back to null rather than emit NaN.
 */
function parseLastUpdated(value: unknown): number | null {
  if (typeof value !== "string") return null;
  const ms = Date.parse(value);
  return Number.isFinite(ms) ? ms : null;
}

function normalizeAuthors(raw: unknown): AppAuthor[] {
  if (!Array.isArray(raw)) return [];
  const out: AppAuthor[] = [];
  for (const item of raw) {
    if (item && typeof item === "object") {
      const r = item as Record<string, unknown>;
      const name = typeof r.name === "string" ? r.name : "";
      const email = typeof r.email === "string" ? r.email : "";
      if (name || email) out.push({ name, email });
    }
  }
  return out;
}

const APPS_DIR = path.resolve(__dirname, "../apps");
const CONNECTORS_DIR = path.resolve(__dirname, "../connectors");
const OUTPUT_DIR = path.resolve(__dirname, "../src/generated");
const APP_REGISTRY_FILE = path.resolve(OUTPUT_DIR, "app-registry.ts");
const APP_CLIENTS_FILE = path.resolve(OUTPUT_DIR, "app-clients.ts");
const APP_PAGE_LOADERS_FILE = path.resolve(OUTPUT_DIR, "app-page-loaders.ts");
const APP_HOOK_LOADERS_FILE = path.resolve(OUTPUT_DIR, "app-hook-loaders.ts");
const CONNECTOR_REGISTRY_FILE = path.resolve(
  OUTPUT_DIR,
  "connector-registry.ts",
);
const THEMES_DIR = path.resolve(__dirname, "../themes");
const MIGRATIONS_DIR = path.resolve(__dirname, "../supabase/migrations");
const BUILD_INFO_FILE = path.resolve(OUTPUT_DIR, "build-info.ts");
const THEME_REGISTRY_FILE = path.resolve(OUTPUT_DIR, "theme-registry.ts");
const THEMES_CSS_FILE = path.resolve(OUTPUT_DIR, "themes.css");
const THEME_TOKENS_FILE = path.resolve(OUTPUT_DIR, "theme-tokens.json");
const PUBLIC_THEMES_DIR = path.resolve(__dirname, "../public/themes");
// NOT public/connectors: `/connectors/*` is already a signed-in page route
// (/connectors/guide), so assets served from there redirect to /login for
// anyone without a session — including next/image's optimizer, which fetches
// the source URL server-side with no cookies and would fail on every icon.
const PUBLIC_CONNECTORS_DIR = path.resolve(
  __dirname,
  "../public/connector-assets",
);
// Listing galleries for apps and themes, copied out of <ext>/screenshots/.
// One prefix for both kinds, segmented by kind underneath, because the rules
// are identical and a second prefix would be a second proxy exemption to keep
// in step. Exempted from the auth matcher in src/proxy.ts for the same reason
// theme assets and connector icons are: a listing is read by someone deciding
// whether to install, which is necessarily before they have a session.
const PUBLIC_SCREENSHOTS_DIR = path.resolve(__dirname, "../public/screenshots");
// Marks an app ships for the brand hooks, copied out of apps/<slug>/branding/.
// Proxy-exempt for the reason theme assets are: the sign-in page renders them
// before anyone has a session. Only declared files are copied.
const PUBLIC_BRANDING_DIR = path.resolve(__dirname, "../public/branding");

function scanPages(dir: string, slug: string, prefix: string, out: string[]) {
  for (const entry of fs.readdirSync(dir, { withFileTypes: true })) {
    if (entry.isDirectory()) {
      scanPages(
        path.join(dir, entry.name),
        slug,
        prefix + entry.name + "/",
        out,
      );
    } else if (entry.name === "Main.tsx" || entry.name === "Main.ts") {
      const key = `${slug}/pages/${prefix}Main`;
      out.push(
        `  "${key}": () => import("@apps/${slug}/pages/${prefix}${entry.name}"),`,
      );
    }
  }
}

/**
 * How many pages an app serves.
 *
 * Same rule `scanPages` uses to build the loader map, and the same terminal
 * files `validateVisibilityMap` resolves a `pageVisibility` key against: a page
 * IS a directory holding `Main.tsx`/`Main.ts`, at any depth. Counting entries in
 * `pages/` instead would count the folders on the way down, and counting the
 * `pageVisibility` keys would count only the pages whose auth was overridden —
 * usually none of them.
 */
function countPages(dir: string): number {
  let n = 0;
  for (const entry of fs.readdirSync(dir, { withFileTypes: true })) {
    if (entry.isDirectory()) {
      n += countPages(path.join(dir, entry.name));
    } else if (entry.name === "Main.tsx" || entry.name === "Main.ts") {
      n++;
    }
  }
  return n;
}

/**
 * Load an app manifest.
 *
 * `app.json` is the only manifest form. It is static text, which means the
 * install path can schema-check the bytes BEFORE anything executes — see
 * preflight() in src/lib/repository/install.ts. An earlier design also accepted
 * an `app.ts` whose default export was the whole manifest; that inverted the
 * order, because the module had to be imported before there was anything to
 * validate. For apps arriving from the Registry that is the wrong way round.
 *
 * The one thing JSON cannot express is a config field built from a helper, so
 * that — and only that — moved to an optional `widgets.ts`. See
 * applyWidgetConfigs() in ./widget-configs.ts.
 */
async function loadAppManifest(
  appDir: string,
): Promise<Record<string, unknown> | null> {
  const jsonPath = path.join(appDir, "app.json");
  if (!fs.existsSync(jsonPath)) return null;

  const manifest = JSON.parse(
    fs.readFileSync(jsonPath, "utf-8"),
  ) as Record<string, unknown>;

  await applyWidgetConfigs(appDir, manifest);
  return manifest;
}

/**
 * Validate a `pageVisibility` or `apiVisibility` map from app.json.
 *
 * The Zod schema has already checked the *values* — that each is a non-empty,
 * duplicate-free array of known auths, and that no page claims `key`. What a
 * schema cannot check is the filesystem, so that is all this does: each key
 * must be POSIX-shaped and must resolve to a real terminal file on disk.
 *
 * Any failure throws `FatalManifestError`, which aborts the generator. Being
 * lenient here is not an option — a typo'd path silently leaves a surface at
 * the default (fine) while the developer believes they published it (not fine),
 * and the inverse typo publishes something nobody reviewed.
 *
 * `subdir` is "pages" or "api"; `terminalFiles` are the candidate leaf files
 * (`Main.tsx`/`Main.ts` for pages, `route.ts`/`route.tsx` for APIs).
 */
function validateVisibilityMap(
  raw: unknown,
  slug: string,
  appDir: string,
  field: "pageVisibility" | "apiVisibility",
  subdir: "pages" | "api",
  terminalFiles: readonly string[],
): Record<string, RouteAuth[]> | undefined {
  if (raw === undefined || raw === null) return undefined;
  if (typeof raw !== "object" || Array.isArray(raw)) {
    throw new FatalManifestError(
      `apps/${slug}/app.json: ${field} must be an object mapping path → an array of accepted auths`,
    );
  }
  const out: Record<string, RouteAuth[]> = {};
  for (const [key, value] of Object.entries(
    raw as Record<string, RouteAuth[]>,
  )) {
    // Reject obvious key mistakes early so paths stay POSIX-shaped.
    if (key.startsWith("/") || key.endsWith("/") || key.includes("\\")) {
      throw new FatalManifestError(
        `apps/${slug}/app.json: ${field}["${key}"] — keys must be POSIX paths without leading or trailing slashes (use "" for the root)`,
      );
    }
    // The API root's declaration key is "" but its file is api/index/route.ts —
    // `path.join(appDir, "api", "", f)` would look for api/route.ts, which no
    // dispatcher serves, so declaring the root route's auth was impossible.
    const onDiskKey = subdir === "api" && key === "" ? "index" : key;
    const candidates = terminalFiles.map((f) =>
      path.join(appDir, subdir, onDiskKey, f),
    );
    if (!candidates.some((p) => fs.existsSync(p))) {
      const expected = `${subdir}/${onDiskKey ? onDiskKey + "/" : ""}${terminalFiles[0]}`;
      throw new FatalManifestError(
        `apps/${slug}/app.json: ${field}["${key}"] does not match any file on disk. Expected ${expected}.`,
      );
    }
    out[key] = value;
  }
  return out;
}

/**
 * Verify each declared schedule maps to a handler file
 * `apps/<slug>/jobs/<name>.ts`. A missing handler is a build-aborting error —
 * the same fail-loud stance as visibility maps.
 */
function validateSchedules(
  raw: ScheduleDefinition[] | undefined,
  slug: string,
  appDir: string,
): ScheduleDefinition[] {
  if (!raw || raw.length === 0) return [];
  const seen = new Set<string>();
  for (const s of raw) {
    if (seen.has(s.name)) {
      throw new FatalManifestError(
        `apps/${slug}/app.json: duplicate schedule name "${s.name}".`,
      );
    }
    seen.add(s.name);
    const candidates = [
      path.join(appDir, "jobs", `${s.name}.ts`),
      path.join(appDir, "jobs", `${s.name}.tsx`),
    ];
    if (!candidates.some((p) => fs.existsSync(p))) {
      throw new FatalManifestError(
        `apps/${slug}/app.json: schedules[].name "${s.name}" has no handler on disk. Expected jobs/${s.name}.ts.`,
      );
    }
  }
  // Carry through whichever cadence the (schema-validated) manifest declared.
  return raw.map((s) => ({
    name: s.name,
    ...(s.everyMinutes != null ? { everyMinutes: s.everyMinutes } : {}),
    ...(s.cron != null ? { cron: s.cron } : {}),
    ...(s.timezone != null ? { timezone: s.timezone } : {}),
  }));
}

/**
 * The brand `defineRoute()` stamps on its result.
 *
 * Duck-typed against the global symbol registry rather than imported from
 * `src/lib/apps/route.ts`, so the generator never pulls `next/server` into a
 * build script. `Symbol.for` is registry-backed, so the comparison holds across
 * module instances.
 */
const ROUTE_BRAND = Symbol.for("mos.route.definition");

const HTTP_METHODS = ["GET", "POST", "PUT", "PATCH", "DELETE"] as const;
type HttpMethod = (typeof HTTP_METHODS)[number];

/** The shape `defineRoute()` returns, as far as the generator needs to read it. */
interface RawRouteDefinition {
  brand: symbol;
  auth: RouteAuth[];
  roles: string[];
  budget: { connectorCalls: number; ms: number };
  raw: boolean;
  input?: unknown;
  output?: unknown;
  summary?: string;
}

function isRawRouteDefinition(v: unknown): v is RawRouteDefinition {
  return (
    typeof v === "object" &&
    v !== null &&
    (v as { brand?: unknown }).brand === ROUTE_BRAND
  );
}

/** `items/[id]/notes` → `["id"]`. Catch-alls (`[...rest]`) yield `rest`. */
function paramsForPath(routePath: string): string[] {
  if (!routePath) return [];
  return routePath
    .split("/")
    .filter((seg) => seg.startsWith("[") && seg.endsWith("]"))
    .map((seg) =>
      seg
        .slice(1, -1)
        .replace(/^\.\.\./, "")
        .replace(/^\[|\]$/g, ""),
    );
}

/**
 * Walk `apps/<slug>/api/`, import every `route.ts`, and hoist each declared
 * route contract into the registry.
 *
 * WHY THIS IMPORTS APP CODE. Every other on-disk check in this file reads
 * source as *text* — `validateMcpTools` even says so, to avoid "the blast
 * radius of executing app code at build time". A route contract cannot be read
 * that way: `auth`, `roles` and `budget` could be recovered from an AST, but
 * the Zod schemas cannot, and a contract the build can only half-read is one
 * the build can only half-enforce. So it imports, as `widgets.ts` does for
 * config fields a manifest cannot express in JSON.
 *
 * The blast radius is real and worth naming: a module-level side effect in a
 * route or anything it imports will run during `npm run build`. That is an
 * argument for keeping module scope free of side effects — which is already
 * true of every module in this codebase, whose clients are all constructed
 * lazily — not an argument for a contract nobody can check.
 */
async function scanApiRoutes(
  appDir: string,
  slug: string,
): Promise<RouteContract[]> {
  const apiDir = path.join(appDir, "api");
  if (!fs.existsSync(apiDir)) return [];

  const contracts: RouteContract[] = [];

  async function walk(dir: string, segments: string[]): Promise<void> {
    const entries = fs.readdirSync(dir, { withFileTypes: true });

    // `route.ts` only. `resolveRoutePath` (src/lib/apps/api-router.ts) ends with
    // an existence check on `route.ts` alone, so a `.tsx` route would be hoisted
    // into the registry, be declarable as public, and 404 forever. Rejecting it
    // at build time beats shipping a route that reads as live and is not.
    const routeFile = [path.join(dir, "route.ts")].find((f) =>
      fs.existsSync(f),
    );
    const strayTsx = path.join(dir, "route.tsx");
    if (!routeFile && fs.existsSync(strayTsx)) {
      throw new FatalManifestError(
        `apps/${slug}/api/${[...segments].join("/") || "index"}/route.tsx: API routes must be .ts, not .tsx. ` +
          `The dispatcher only resolves route.ts, so a .tsx route would never be reachable.`,
      );
    }

    if (routeFile) {
      // Both dispatchers hardcode `routePath = "index"` for a URL with no path
      // segments, so a file at apps/<slug>/api/route.ts is never imported by
      // anything. Left accepted, it hoists a contract at key "" that collides
      // with the real root route and can decide that route's public gate by
      // array order — so it is rejected rather than silently ignored.
      if (segments.length === 0) {
        throw new FatalManifestError(
          `apps/${slug}/api/route.ts is never dispatched — the root route lives at api/index/route.ts. ` +
            `Move it there (its declaration key stays "").`,
        );
      }

      // The root route is `api/index/route.ts`, and its declaration key is the
      // empty string, matching `apiVisibility`.
      const routePath =
        segments.join("/") === "index" ? "" : segments.join("/");

      // Optional catch-alls are rejected rather than half-supported. Stripping
      // the brackets off `[[...rest]]` yields the param name `...rest`, which a
      // handler cannot read, and at the API root the shape collides with
      // `api/index/route.ts`. A required `[...rest]` works and is the intent
      // nearly every time.
      const optionalCatchAll = segments.find((seg) => seg.startsWith("[[..."));
      if (optionalCatchAll) {
        throw new FatalManifestError(
          `apps/${slug}/api/${routePath}/route.ts: optional catch-all segments (${optionalCatchAll}) are not supported. ` +
            `Use a required catch-all ([...name]) instead.`,
        );
      }

      let mod: Record<string, unknown>;
      try {
        // `?t=` defeats the ESM module cache, so a re-run in the same process
        // (watch mode) sees edits. Same idiom as loadAppManifest.
        mod = (await import(
          `${pathToFileURL(routeFile).href}?t=${Date.now()}`
        )) as Record<string, unknown>;
      } catch (err) {
        throw new FatalManifestError(
          `apps/${slug}/api/${routePath || "index"}/route.ts could not be imported: ${
            err instanceof Error ? err.message : String(err)
          }`,
        );
      }

      const methods: RouteMethodContract[] = [];
      for (const method of HTTP_METHODS) {
        const exported = mod[method];
        if (exported === undefined) continue;

        if (!isRawRouteDefinition(exported)) {
          throw new FatalManifestError(
            `apps/${slug}/api/${routePath || "index"}/route.ts: ${method} must be the result of defineRoute({...}). ` +
              `A bare handler declares no input, output, auth or roles, so the gateway cannot validate it, ` +
              `the build cannot check it, and the generated client cannot type it.`,
          );
        }

        if (!exported.raw && !exported.output) {
          throw new FatalManifestError(
            `apps/${slug}/api/${routePath || "index"}/route.ts: ${method} declares no \`output\` schema. ` +
              `Declare one, or set \`raw: true\` if the route owns its own Response.`,
          );
        }

        methods.push({
          method: method as HttpMethod,
          auth: exported.auth,
          roles: exported.roles,
          budget: exported.budget,
          raw: exported.raw,
          hasInput: exported.input != null,
          hasOutput: exported.output != null,
          ...(exported.summary ? { summary: exported.summary } : {}),
        });
      }

      if (methods.length === 0) {
        throw new FatalManifestError(
          `apps/${slug}/api/${routePath || "index"}/route.ts exports no HTTP method. ` +
            `Export at least one of ${HTTP_METHODS.join(", ")} as a defineRoute({...}) result, or delete the file.`,
        );
      }

      contracts.push({
        path: routePath,
        params: paramsForPath(routePath),
        methods,
      });
    }

    for (const entry of entries) {
      if (!entry.isDirectory()) continue;
      await walk(path.join(dir, entry.name), [...segments, entry.name]);
    }
  }

  await walk(apiDir, []);

  // Two contracts sharing a path would make `routes.find(...)` — which the
  // public mount uses to decide a route's auth gate — resolve by array order.
  const byPath = new Set<string>();
  for (const c of contracts) {
    if (byPath.has(c.path)) {
      throw new FatalManifestError(
        `apps/${slug}: two route files resolve to the same path "${c.path || "(root)"}". ` +
          `One of them is unreachable, and which one decides the route's auth would be an accident of ordering.`,
      );
    }
    byPath.add(c.path);
  }

  contracts.sort((a, b) => a.path.localeCompare(b.path));
  return contracts;
}

/**
 * Cross-check hoisted route contracts against the rest of the manifest.
 *
 * Two things a route can declare that only make sense relative to its app:
 * a role the app never defined (which would gate the route on something no user
 * can ever hold — a silent 403 forever), and an auth set that contradicts what
 * `apiVisibility` says about the same path.
 */
function validateRouteContracts(
  contracts: RouteContract[],
  slug: string,
  declaredRoles: { key: string }[],
  apiVisibility: Record<string, RouteAuth[]> | undefined,
): void {
  const roleKeys = new Set(declaredRoles.map((r) => r.key));

  for (const contract of contracts) {
    for (const m of contract.methods) {
      for (const role of m.roles) {
        if (!roleKeys.has(role)) {
          throw new FatalManifestError(
            `apps/${slug}/api/${contract.path || "index"}/route.ts: ${m.method} requires role "${role}", ` +
              `which the app does not declare in \`roles\`. No user can ever hold it, so the route would 403 forever.`,
          );
        }
      }

      // Roles require `session`, and the build is where that has to be caught.
      //
      // Only the `session` tier carries app roles. An anonymous caller has no
      // identity at all, and a `signed-in` caller is by definition someone who
      // was never granted the app — the gateway strips their roles precisely so
      // that the app's `defaultRole` is not handed to every signed-in user in
      // the deployment. So a request resolving to any tier but `session` can
      // only ever 403 against a role gate.
      //
      // The anonymous case is worse than merely useless: the role gate lives in
      // `runRoute`, which is mount-blind, so its 403 escapes on the public mount
      // where every other refusal deliberately collapses to 404 — handing an
      // anonymous prober a route-existence oracle for a route that never works.
      // Neither half is fixable at runtime without making one of the two rules
      // lie, so the combination is rejected here.
      if (m.roles.length > 0) {
        const unsatisfiable = m.auth.filter((a) => a !== "session");
        if (unsatisfiable.length > 0) {
          throw new FatalManifestError(
            `apps/${slug}/api/${contract.path || "index"}/route.ts: ${m.method} declares roles ` +
              `[${m.roles.join(", ")}] alongside [${unsatisfiable.join(", ")}], which carry no app roles. ` +
              `An anonymous caller holds no identity, and a "signed-in" caller was never granted the app — ` +
              `so a request resolving to either tier could only ever 403. ` +
              `Role-gated routes are auth: ["session"].`,
          );
        }
      }

      const declared = apiVisibility?.[contract.path];
      if (declared) {
        const a = [...m.auth].sort().join(",");
        const b = [...declared].sort().join(",");
        if (a !== b) {
          throw new FatalManifestError(
            `apps/${slug}: apiVisibility["${contract.path}"] says [${b}] but ${m.method} in that route declares [${a}]. ` +
              `Two declarations of the same fact will drift — keep the one on the route and delete the manifest entry, ` +
              `or make them agree.`,
          );
        }
      }
    }
  }

  // A manifest entry naming a path no route serves is a typo that silently
  // publishes nothing (or, worse, reads as published in review).
  const known = new Set(contracts.map((c) => c.path));
  for (const key of Object.keys(apiVisibility ?? {})) {
    if (!known.has(key)) {
      throw new FatalManifestError(
        `apps/${slug}/app.json: apiVisibility["${key}"] does not match any route on disk. ` +
          `Expected api/${key ? key + "/" : "index/"}route.ts exporting a defineRoute({...}).`,
      );
    }
  }
}

// ── brand hooks ──────────────────────────────────────────────────────────────

/** Copy an app's declared marks to public/branding/apps/<slug>/. */
function copyBrandLogos(
  branding: AppBranding | null,
  slug: string,
  appDir: string,
): void {
  if (!branding || branding.logos.length === 0) return;
  const dest = path.join(PUBLIC_BRANDING_DIR, "apps", slug);
  fs.mkdirSync(dest, { recursive: true });
  for (const logo of branding.logos) {
    fs.copyFileSync(
      path.join(appDir, logo.file),
      path.join(dest, path.basename(logo.file)),
    );
  }
}

/**
 * Carry through the app's declared escapes, failing on a duplicate rule. Shape
 * and the closed rule set are already schema-validated; a duplicate would leave
 * two different reasons on the record for one exception.
 */
function validateEscapes(
  raw: AppEscape[] | undefined,
  slug: string,
): AppEscape[] {
  if (!raw || raw.length === 0) return [];
  const seen = new Set<string>();
  for (const e of raw) {
    if (seen.has(e.rule)) {
      throw new FatalManifestError(
        `apps/${slug}/app.json: duplicate escape rule "${e.rule}".`,
      );
    }
    seen.add(e.rule);
  }
  return raw.map((e) => ({ rule: e.rule, reason: e.reason }));
}

/** Carry through declared app settings, failing on a duplicate key. */
function validateEnv(
  raw:
    | {
        key: string;
        label: string;
        type: "text" | "password";
        required?: boolean;
      }[]
    | undefined,
  slug: string,
): AppEnvField[] {
  if (!raw || raw.length === 0) return [];
  const seen = new Set<string>();
  for (const f of raw) {
    if (seen.has(f.key)) {
      throw new FatalManifestError(
        `apps/${slug}/app.json: duplicate env key "${f.key}".`,
      );
    }
    seen.add(f.key);
  }
  return raw.map((f) => ({
    key: f.key,
    label: f.label,
    type: f.type,
    ...(f.required != null ? { required: f.required } : {}),
  }));
}

/**
 * Validate declared syncs: unique names, a handler on disk exporting a default,
 * and a `source` the app can actually reach. Mirrors validateSchedules and the
 * `sources` loop in validateMcpTools.
 */
function validateSyncs(
  raw: SyncDefinition[] | undefined,
  slug: string,
  appDir: string,
  connectors: string[],
): SyncDefinition[] {
  if (!raw || raw.length === 0) return [];
  const seen = new Set<string>();
  const allowedSources = new Set([...connectors, MOS_SOURCE]);

  for (const sync of raw) {
    if (seen.has(sync.name)) {
      throw new FatalManifestError(
        `apps/${slug}/app.json: duplicate sync name "${sync.name}".`,
      );
    }
    seen.add(sync.name);

    if (!allowedSources.has(sync.source)) {
      throw new FatalManifestError(
        `apps/${slug}/app.json: sync "${sync.name}" names source "${sync.source}", ` +
          `which is neither a connector this app declares nor "${MOS_SOURCE}".`,
      );
    }

    const candidates = ["ts", "tsx"].map((ext) =>
      path.join(appDir, "sync", `${sync.name}.${ext}`),
    );
    const handlerPath = candidates.find((c) => fs.existsSync(c));
    if (!handlerPath) {
      throw new FatalManifestError(
        `apps/${slug}/app.json: sync "${sync.name}" has no handler. Expected sync/${sync.name}.ts.`,
      );
    }
    const source = fs.readFileSync(handlerPath, "utf-8");
    if (!/export\s+default\b/.test(source)) {
      throw new FatalManifestError(
        `apps/${slug}/sync/${sync.name}.ts must have a default export (the result of defineSync({...})).`,
      );
    }
  }

  return raw;
}

/**
 * Carry through the app's declared telemetry events, failing the build on a
 * duplicate event name (a duplicate is almost always a copy-paste bug and would
 * make the admin breakdown ambiguous). Shape is already schema-validated.
 */
function validateAppTelemetry(
  raw: { name: string; description?: string }[] | undefined,
  slug: string,
): TelemetryEventDefinition[] {
  if (!raw || raw.length === 0) return [];
  const seen = new Set<string>();
  for (const e of raw) {
    if (seen.has(e.name)) {
      throw new FatalManifestError(
        `apps/${slug}/app.json: duplicate telemetry event name "${e.name}".`,
      );
    }
    seen.add(e.name);
  }
  return raw.map((e) => ({
    name: e.name,
    ...(e.description != null ? { description: e.description } : {}),
  }));
}

/**
 * Verify each declared service maps to a handler file
 * `apps/<slug>/services/<name>.ts` and that names are unique. A missing handler
 * aborts the build (same fail-loud stance as schedules).
 */
function validateProvides(
  raw: ServiceDefinition[] | undefined,
  slug: string,
  appDir: string,
): ServiceDefinition[] {
  if (!raw || raw.length === 0) return [];
  const seen = new Set<string>();
  for (const s of raw) {
    if (seen.has(s.name)) {
      throw new FatalManifestError(
        `apps/${slug}/app.json: duplicate service name "${s.name}" in provides.`,
      );
    }
    seen.add(s.name);
    const candidates = [
      path.join(appDir, "services", `${s.name}.ts`),
      path.join(appDir, "services", `${s.name}.tsx`),
    ];
    if (!candidates.some((p) => fs.existsSync(p))) {
      throw new FatalManifestError(
        `apps/${slug}/app.json: provides[].name "${s.name}" has no handler on disk. Expected services/${s.name}.ts.`,
      );
    }
  }
  return raw.map((s) => ({
    name: s.name,
    ...(s.description != null ? { description: s.description } : {}),
    audience: s.audience ?? "user",
    consumers: s.consumers,
  }));
}

/**
 * Verify each declared MCP tool maps to a handler at `apps/<slug>/mcp/<name>.ts`
 * that exports both an `inputSchema` and a default handler, that names are
 * unique, and that neither the slug nor the tool name contains `__`.
 *
 * The `__` rule matters: tools are exposed to clients as `<slug>__<name>` and
 * the dispatcher splits on the first `__` to recover the pair. A `__` on either
 * side would make that split ambiguous and could route a call to the wrong app.
 *
 * The export check is a source scan rather than an import, deliberately: MCP
 * handlers pull in connectors and server modules, and the generator must stay
 * runnable during a build with no DB or credentials present. Same
 * trade-off as `scanHooks` in ./hook-checks.ts. It catches the common
 * mistake — a handler file that forgot `inputSchema` — without the blast radius
 * of executing app code at build time.
 *
 * Also checks that every `sources` entry is a connector the app actually
 * declares (or `"ros"`, for data with no upstream system). That claim is shown
 * to the model as the tool's provenance, and it is the thing that lets a client
 * tell our cached join apart from the source system's own connector — so a
 * wrong or aspirational entry is worse than a missing one.
 */
function validateMcpTools(
  raw: McpToolDefinition[] | undefined,
  slug: string,
  appDir: string,
  connectors: string[],
): McpToolDefinition[] {
  if (!raw || raw.length === 0) return [];

  if (slug.includes("__")) {
    throw new FatalManifestError(
      `apps/${slug}/app.json: an app whose slug contains "__" cannot expose MCP tools — tools are namespaced as "<slug>__<tool>" and the separator would be ambiguous.`,
    );
  }

  const seen = new Set<string>();
  for (const t of raw) {
    if (seen.has(t.name)) {
      throw new FatalManifestError(
        `apps/${slug}/app.json: duplicate MCP tool name "${t.name}".`,
      );
    }
    seen.add(t.name);

    // Belt-and-braces: the schema's lowercase-hyphenated regex already excludes
    // "__", but the rule is load-bearing enough to state independently.
    if (t.name.includes("__")) {
      throw new FatalManifestError(
        `apps/${slug}/app.json: MCP tool name "${t.name}" must not contain "__".`,
      );
    }

    for (const src of t.sources) {
      if (src === MOS_SOURCE || connectors.includes(src)) continue;
      const declared = connectors.length
        ? `Declared connectors: ${connectors.join(", ")}.`
        : "This app declares no connectors.";
      throw new FatalManifestError(
        `apps/${slug}/app.json: mcp tool "${t.name}" lists source "${src}", ` +
          `which is not a connector this app declares. ${declared} ` +
          `Use "${MOS_SOURCE}" for data that exists only in MixOS.`,
      );
    }

    const candidates = [
      path.join(appDir, "mcp", `${t.name}.ts`),
      path.join(appDir, "mcp", `${t.name}.tsx`),
    ];
    const handlerPath = candidates.find((p) => fs.existsSync(p));
    if (!handlerPath) {
      throw new FatalManifestError(
        `apps/${slug}/app.json: mcp[].name "${t.name}" has no handler on disk. Expected mcp/${t.name}.ts.`,
      );
    }

    const src = fs.readFileSync(handlerPath, "utf-8");
    if (!/export\s+const\s+inputSchema\b/.test(src)) {
      throw new FatalManifestError(
        `apps/${slug}/mcp/${t.name}.ts: missing \`export const inputSchema\`. Every MCP tool must publish a Zod input schema — it becomes the tool's JSON Schema.`,
      );
    }
    if (!/export\s+default\b/.test(src)) {
      throw new FatalManifestError(
        `apps/${slug}/mcp/${t.name}.ts: missing a default export. The handler is \`export default async function (ctx: McpToolContext, input) => result\`.`,
      );
    }
  }

  return raw.map((t) => ({
    name: t.name,
    description: t.description,
    ...(t.hint != null ? { hint: t.hint } : {}),
    sources: t.sources,
    ...(t.notCovered != null ? { notCovered: t.notCovered } : {}),
  }));
}

/** Carry through declared consumes dependencies (wiring checked separately). */
function normalizeConsumes(
  raw: ServiceDependency[] | undefined,
): ServiceDependency[] {
  if (!raw || raw.length === 0) return [];
  return raw.map((d) => ({ app: d.app, service: d.service }));
}

/**
 * Cross-manifest check for App Services: every `consumes` dependency must
 * reference a provider that actually `provides` that service *and* whose
 * `consumers` allowlist includes the consumer (or is `"*"`). Enforces two-sided
 * consent before runtime — a one-sided or mistyped wiring aborts the build.
 */
function validateServiceWiring(manifests: AppManifest[]): void {
  const bySlug = new Map(manifests.map((m) => [m.slug, m]));
  for (const consumer of manifests) {
    for (const dep of consumer.consumes) {
      const provider = bySlug.get(dep.app);
      if (!provider) {
        throw new FatalManifestError(
          `apps/${consumer.slug}/app.json: consumes "${dep.app}:${dep.service}" — no app named "${dep.app}".`,
        );
      }
      const service = provider.provides.find((s) => s.name === dep.service);
      if (!service) {
        throw new FatalManifestError(
          `apps/${consumer.slug}/app.json: consumes "${dep.app}:${dep.service}" — "${dep.app}" does not provide a service "${dep.service}".`,
        );
      }
      const allowed =
        service.consumers === "*" || service.consumers.includes(consumer.slug);
      if (!allowed) {
        throw new FatalManifestError(
          `apps/${consumer.slug}/app.json: "${dep.app}" provides "${dep.service}" but its consumers allowlist does not include "${consumer.slug}".`,
        );
      }
    }
  }
}

// ── screenshots ──────────────────────────────────────────────────────────────

/**
 * Verify, measure and resolve an extension's declared screenshots.
 *
 * Shared verbatim between apps and themes. The rules have to be identical
 * across the two or an author learns the convention twice and gets it wrong
 * once; the limits themselves live in `src/lib/screenshots.ts` so the docs and
 * the schema quote the same numbers this function enforces.
 *
 * Every failure aborts the build. A screenshot is listing imagery, so the
 * failure mode of letting a bad one through is not a crash but a published
 * listing with a hole in it — which the author never sees, because they are
 * looking at their local copy where the file is right there.
 *
 * Errors name the file and the measured value rather than restating the rule,
 * for the same reason `validateConnectorIcon` does: "is 412x260, below the
 * 640px minimum" is actionable, "invalid screenshot" is not.
 */
function validateScreenshots(
  declared: { file: string; alt?: string; caption?: string }[] | undefined,
  kind: ScreenshotKind,
  slug: string,
  dir: string,
): Screenshot[] {
  const entries = declared ?? [];
  if (entries.length === 0) return [];

  const manifest = kind === "apps" ? "app.json" : "theme.json";
  const where = `${kind}/${slug}`;

  // The schema caps this too; re-checked here because the generator is what
  // actually copies the files, and a limit enforced in only one of two places
  // is a limit that moves when someone edits the other.
  if (entries.length > SCREENSHOT_MAX_COUNT) {
    throw new FatalManifestError(
      `${where}/${manifest}: declares ${entries.length} screenshots, above the ` +
        `maximum of ${SCREENSHOT_MAX_COUNT}.`,
    );
  }

  const seen = new Set<string>();
  const out: Screenshot[] = [];

  for (const entry of entries) {
    // A duplicate is always a copy-paste slip: the same image twice in a
    // gallery reads as a rendering bug to whoever is looking at the listing.
    if (seen.has(entry.file)) {
      throw new FatalManifestError(
        `${where}/${manifest}: screenshots lists "${entry.file}" twice.`,
      );
    }
    seen.add(entry.file);

    const file = path.join(dir, entry.file);
    if (!fs.existsSync(file)) {
      throw new FatalManifestError(
        `${where}/${manifest}: screenshots names "${entry.file}", which does not ` +
          `exist. Expected it at ${where}/${entry.file}.`,
      );
    }

    const ext = path.extname(entry.file).toLowerCase();
    if (!(SCREENSHOT_EXTENSIONS as readonly string[]).includes(ext)) {
      throw new FatalManifestError(
        `${where}/${entry.file} is a ${ext || "extensionless"} file. ` +
          `Screenshots must be ${SCREENSHOT_EXTENSIONS.join(", ")} — notably not ` +
          `.svg, which is a script-bearing document rather than an image, and ` +
          `these are served from an unauthenticated path.`,
      );
    }

    const buf = fs.readFileSync(file);
    if (buf.byteLength > SCREENSHOT_MAX_BYTES) {
      const mb = (n: number) => `${(n / 1024 / 1024).toFixed(1)} MB`;
      throw new FatalManifestError(
        `${where}/${entry.file} is ${mb(buf.byteLength)}, above the ` +
          `${mb(SCREENSHOT_MAX_BYTES)} limit. Re-export it, or ship it as .webp.`,
      );
    }

    const size = readImageSize(buf);
    if (!size) {
      throw new FatalManifestError(
        `${where}/${entry.file} could not be read as a ${ext.slice(1)} image. ` +
          `Either it is not one, or it is truncated — re-export it.`,
      );
    }
    if (size.width < SCREENSHOT_MIN_WIDTH) {
      throw new FatalManifestError(
        `${where}/${entry.file} is ${size.width}x${size.height}, below the ` +
          `${SCREENSHOT_MIN_WIDTH}px minimum width. Below that it is a ` +
          `thumbnail, and it ships visibly soft on a high-DPI display.`,
      );
    }

    out.push({
      file: entry.file,
      url: screenshotUrl(kind, slug, entry.file),
      alt: entry.alt ?? null,
      caption: entry.caption ?? null,
      width: size.width,
      height: size.height,
    });
  }

  return out;
}

/**
 * Copy an extension's screenshots to public/screenshots/<kind>/<slug>/.
 *
 * Only the declared files, unlike a theme's `assets/` which is copied
 * wholesale: an undeclared image in the directory is a draft or a reject, and
 * publishing it to an unauthenticated URL because it happened to be sitting
 * beside the real ones is not a behaviour anyone would ask for.
 */
function copyScreenshots(
  screenshots: Screenshot[],
  kind: ScreenshotKind,
  slug: string,
  dir: string,
): void {
  if (screenshots.length === 0) return;
  const dest = path.join(PUBLIC_SCREENSHOTS_DIR, kind, slug);
  fs.mkdirSync(dest, { recursive: true });
  for (const shot of screenshots) {
    fs.copyFileSync(
      path.join(dir, shot.file),
      path.join(dest, path.basename(shot.file)),
    );
  }
}

// ── themes ───────────────────────────────────────────────────────────────────

/** Recursively copy a theme's assets into public/themes/<slug>/. */
function copyDir(from: string, to: string): void {
  if (!fs.existsSync(from)) return;
  fs.mkdirSync(to, { recursive: true });
  for (const entry of fs.readdirSync(from, { withFileTypes: true })) {
    const src = path.join(from, entry.name);
    const dst = path.join(to, entry.name);
    if (entry.isDirectory()) copyDir(src, dst);
    else fs.copyFileSync(src, dst);
  }
}

/**
 * Every path in `assets` must resolve to a real file. A manifest naming a
 * missing logo does not degrade gracefully — it ships a broken <img> into the
 * menu bar of every page in the install.
 */
function validateThemeAssets(
  assets: ThemeAssets,
  slug: string,
  dir: string,
): ThemeAssets {
  for (const [key, rel] of Object.entries(assets)) {
    if (typeof rel !== "string") continue;
    if (!fs.existsSync(path.join(dir, "assets", rel))) {
      throw new ThemeError(
        `themes/${slug}/theme.json: assets.${key} is "${rel}", which does not exist. ` +
          `Expected it at themes/${slug}/assets/${rel}.`,
      );
    }
  }
  return assets;
}

/**
 * A declared font must exist. Whether theme.css loads it — and whether every
 * font theme.css loads is declared — is checked by compileTheme, which has the
 * parsed @font-face rules: a manifest font nobody @font-faces is a file shipped
 * to every user for nothing; an @font-face with no manifest entry hides a
 * dependency from review.
 */
function validateThemeFonts(
  fonts: ThemeFontFace[],
  slug: string,
  dir: string,
): ThemeFontFace[] {
  for (const font of fonts) {
    if (!fs.existsSync(path.join(dir, "assets", font.file))) {
      throw new ThemeError(
        `themes/${slug}/theme.json: fonts[] names "${font.file}", which does not exist. ` +
          `Expected it at themes/${slug}/assets/${font.file}.`,
      );
    }
  }
  return fonts;
}

async function scanThemes(): Promise<{
  themes: ThemeManifest[];
  css: string;
  tokens: Record<string, Record<string, string>>;
}> {
  if (!fs.existsSync(THEMES_DIR)) {
    return { themes: [], css: "", tokens: {} };
  }

  const themes: ThemeManifest[] = [];
  const cssParts: string[] = [];
  const tokens: Record<string, Record<string, string>> = {};

  const entries = fs
    .readdirSync(THEMES_DIR, { withFileTypes: true })
    .filter((e) => e.isDirectory() && !e.name.startsWith("_"))
    .sort((a, b) => a.name.localeCompare(b.name));

  for (const entry of entries) {
    const slug = entry.name;
    const dir = path.join(THEMES_DIR, slug);

    if (!/^[a-z0-9][a-z0-9-]*$/.test(slug)) {
      throw new ThemeError(
        `themes/${slug}: a theme folder name is its slug and appears in a CSS attribute ` +
          `selector — use lowercase letters, digits and hyphens.`,
      );
    }

    const manifestPath = path.join(dir, "theme.json");
    if (!fs.existsSync(manifestPath)) {
      // As with apps: plans/ may precede the thing it plans.
      if (fs.existsSync(path.join(dir, "plans"))) {
        console.log(`  themes/${slug}/ — planned, not yet built (plans/ only)`);
      } else {
        console.warn(`  Skipping themes/${slug}/ — no theme.json`);
      }
      continue;
    }

    const parsed = RawThemeManifestSchema.safeParse(
      JSON.parse(fs.readFileSync(manifestPath, "utf-8")),
    );
    if (!parsed.success) {
      throw new ThemeError(
        `themes/${slug}/theme.json failed validation:\n${formatZodError(parsed.error)}`,
      );
    }
    const r = parsed.data;

    const compiled = compileTheme({
      slug,
      dir,
      escapes: r.escapes ?? [],
      declaredSurfaces: r.surfaces ?? [],
      declaredFonts: (r.fonts ?? []).map((f) => f.file),
    });

    const fonts = validateThemeFonts(r.fonts ?? [], slug, dir);
    const assets = validateThemeAssets(r.assets ?? {}, slug, dir);
    const screenshots = validateScreenshots(r.screenshots, "themes", slug, dir);
    const logo = assets.logo
      ? resolveThemeLogo(slug, dir, assets.logo, "assets.logo")
      : null;
    const branding = {
      name: r.branding?.name ?? null,
      menuBarLogo: r.branding?.menuBarLogo
        ? resolveThemeLogo(slug, dir, r.branding.menuBarLogo, "branding.menuBarLogo")
        : null,
      loginLogo: r.branding?.loginLogo
        ? resolveThemeLogo(slug, dir, r.branding.loginLogo, "branding.loginLogo")
        : null,
    };

    copyDir(path.join(dir, "assets"), path.join(PUBLIC_THEMES_DIR, slug));
    copyScreenshots(screenshots, "themes", slug, dir);

    cssParts.push(
      `/* ── ${slug} ─────────────────────────────── */\n${compiled.css}`,
    );
    tokens[slug] = compiled.tokens;

    themes.push({
      slug,
      name: r.name,
      description: r.description,
      authors: normalizeAuthors(r.authors),
      fonts,
      assets,
      screenshots,
      surfaces: compiled.surfaces,
      escapes: r.escapes ?? [],
      assetBase: `/themes/${slug}`,
      logo,
      branding,
      swatches: compiled.swatches,
      typefaces: compiled.typefaces,
      lastUpdated: parseLastUpdated(r.lastUpdated),
    });

    const escaped = (r.escapes ?? []).length;
    console.log(
      `  ${slug} — ${compiled.report.length} contrast pairs verified` +
        (escaped > 0 ? `, ${escaped} escaped` : ""),
    );
    if (process.env.THEME_REPORT) console.log(compiled.report.join("\n"));
  }

  return { themes, css: cssParts.join("\n\n"), tokens };
}

/**
 * An app's database declarations, checked against its migrations/.
 *
 * Only an app with `"database": true` has a schema, so only it may ship
 * migrations or list `updatedAt` columns. (A `sync`, whose state the platform
 * keeps in that schema, needs it too; the manifest schema refuses that one.)
 * Every statement in its migrations must be one an app may run
 * (scripts/app-sql-policy.ts): the release step checks again before it applies
 * anything, and this is the same check, on the next build instead of at deploy
 * time. Each `updatedAt` column must be one the migrations create, as a
 * timestamp.
 *
 * Returns the `updatedAt` columns with their defaults filled in.
 */
async function validateAppDatabase(
  raw: {
    database?: boolean;
    updatedAt?: { table: string; column?: string }[];
  },
  slug: string,
): Promise<UpdatedAtColumn[]> {
  const files = appMigrationFiles(APPS_DIR, slug);
  const updatedAt = (raw.updatedAt ?? []).map((c) => ({
    table: c.table,
    column: c.column ?? "updated_at",
  }));

  if (!raw.database) {
    if (files.length > 0) {
      throw new FatalManifestError(
        `apps/${slug}/migrations/ holds ${files.length} SQL file(s), but app.json does not set ` +
          `"database": true. Migrations apply to the schema a database gives the app: set ` +
          `"database": true, or remove migrations/.`,
      );
    }
    if (updatedAt.length > 0) {
      throw new FatalManifestError(
        `apps/${slug}/app.json lists "updatedAt" columns but does not set "database": true.`,
      );
    }
    return [];
  }

  const schema = appSchemaName(slug);
  const texts: string[] = [];
  const problems: string[] = [];
  for (const file of files) {
    const text = fs.readFileSync(path.join(APPS_DIR, slug, "migrations", file), "utf-8");
    texts.push(text);
    const found = await checkAppMigrationSql(text, schema);
    if (found.length > 0) {
      problems.push(formatSqlProblems(`apps/${slug}/migrations/${file}`, found));
    }
  }
  if (problems.length > 0) {
    throw new FatalManifestError(
      `${problems.join("\n")}\nAn app migration may create, change and fill the app's own ` +
        `tables, and nothing else. See docs/apps/database.md.`,
    );
  }

  if (updatedAt.length > 0) {
    const tables = await describeAppTables(texts, schema);
    for (const c of updatedAt) {
      const type = tables.get(c.table)?.get(c.column);
      if (type === undefined) {
        throw new FatalManifestError(
          `apps/${slug}/app.json lists ${c.table}.${c.column} under "updatedAt", but no ` +
            `migration in apps/${slug}/migrations/ creates that column.`,
        );
      }
      if (type !== "timestamptz" && type !== "timestamp") {
        throw new FatalManifestError(
          `apps/${slug}/app.json lists ${c.table}.${c.column} under "updatedAt", but its ` +
            `migrations make it ${type}. It must be timestamptz or timestamp.`,
        );
      }
    }
  }
  return updatedAt;
}

async function scanApps(): Promise<AppManifest[]> {
  if (!fs.existsSync(APPS_DIR)) {
    fs.mkdirSync(APPS_DIR, { recursive: true });
  }

  const entries = fs.readdirSync(APPS_DIR, { withFileTypes: true });
  const manifests: AppManifest[] = [];

  for (const entry of entries) {
    if (!entry.isDirectory()) continue;
    if (entry.name.startsWith("_")) continue; // template directories

    const appDir = path.join(APPS_DIR, entry.name);

    // Containment runs FIRST, before anything imports the app's code: loading
    // the manifest imports widgets.ts and scanning routes imports every
    // route.ts, and an import runs the module's top level. A finding skips the
    // app rather than aborting the run — on the install path a `Skipping
    // <slug>/` line is a `rejected-by-registry`, rolled back, which is the
    // right verdict on the extension (see regenerateRegistry() in
    // src/lib/repository/install.ts). See scripts/app-containment.ts.
    const findings = scanAppContainment(appDir);
    if (findings.length > 0) {
      console.warn(
        `  Skipping ${entry.name}/ — its code reaches what an app may not:${formatFindings(findings)}`,
      );
      continue;
    }

    let raw: Record<string, unknown> | null;
    try {
      raw = await loadAppManifest(appDir);
    } catch (err) {
      // A widgets.ts that disagrees with app.json is a manifest error like any
      // other, and aborts the run rather than dropping the app.
      if (err instanceof FatalManifestError) throw err;
      console.warn(
        `  Skipping ${entry.name}/ — failed to load manifest: ${err}`,
      );
      continue;
    }
    if (!raw) {
      // A folder holding only plans/ is a legitimate state: a build plan is
      // written where the app will live, before the app exists. Reporting that
      // as a warning trains people to ignore warnings. See docs/plans/README.md.
      if (fs.existsSync(path.join(appDir, "plans"))) {
        console.log(
          `  apps/${entry.name}/ — planned, not yet built (plans/ only)`,
        );
      } else {
        console.warn(`  Skipping ${entry.name}/ — no app.json found`);
      }
      continue;
    }

    try {
      // The folder name is the slug, and it names the app's schema and role
      // (src/lib/apps/app-identifiers.ts), its URLs and its hooks. A slug that
      // could not name a schema unambiguously never gets as far as having one.
      const slugProblem = appSlugProblem(entry.name);
      if (slugProblem) {
        throw new FatalManifestError(`apps/${entry.name}: ${slugProblem}`);
      }

      const pagesDir = path.join(APPS_DIR, entry.name, "pages");
      const hasPages =
        fs.existsSync(pagesDir) && fs.readdirSync(pagesDir).length > 0;
      // Zero is possible while `hasPages` is true — a `pages/` directory
      // holding only a component with no `Main.tsx` beside it serves nothing.
      const pageCount = hasPages ? countPages(pagesDir) : 0;

      // Schema-validate the on-disk manifest: types, required fields, unknown
      // keys, and the defaultRole↔roles cross-check. A violation aborts the
      // whole build (FatalManifestError) — a malformed manifest is a developer
      // error that must fail loudly, not silently drop the app.
      const parsed = RawAppManifestSchema.safeParse(raw);
      if (!parsed.success) {
        throw new FatalManifestError(
          `apps/${entry.name}/app.json failed validation:\n${formatZodError(parsed.error)}`,
        );
      }
      const r = parsed.data;

      // Schema validates the visibility *values*; this additionally verifies
      // each key resolves to a real file on disk.
      const pageVisibility = validateVisibilityMap(
        r.pageVisibility,
        entry.name,
        appDir,
        "pageVisibility",
        "pages",
        ["Main.tsx", "Main.ts"],
      );
      const apiVisibility = validateVisibilityMap(
        r.apiVisibility,
        entry.name,
        appDir,
        "apiVisibility",
        "api",
        ["route.ts"],
      );

      // Schema validates the schedule shape; this verifies each job name
      // resolves to a real handler file on disk.
      const schedules = validateSchedules(r.schedules, entry.name, appDir);

      // Import every api/**/route.ts and hoist its declared contract. This is
      // also where a bare `export async function GET` fails the build.
      const routes = await scanApiRoutes(appDir, entry.name);
      validateRouteContracts(routes, entry.name, r.roles ?? [], apiVisibility);

      // The one remaining escape is load-bearing: a route that owns its own
      // Response registers only when the manifest says so, with a reason, where
      // a reviewer and the admin dialog can see it.
      const rawRoutes = routes.flatMap((route) =>
        route.methods
          .filter((m) => m.raw)
          .map((m) => `${m.method} /${route.path}`),
      );
      const declaresRaw = (r.escapes ?? []).some((e) => e.rule === "raw-response");
      if (rawRoutes.length > 0 && !declaresRaw) {
        throw new AppRejectedError(
          `${rawRoutes.join(", ")} ${rawRoutes.length === 1 ? "returns its" : "return their"} own Response ` +
            `(\`raw: true\`), which needs { "rule": "raw-response", "reason": "…" } under \`escapes\` in app.json.`,
        );
      }
      if (rawRoutes.length === 0 && declaresRaw) {
        // Not a refusal — the declaration costs nothing — but a stale one tells
        // a reviewer something about the app that is no longer true.
        console.warn(
          `    apps/${entry.name}/app.json declares the raw-response escape, but no route sets \`raw: true\`. Remove it.`,
        );
      }

      // What the code fires and listens to, held to the app's own namespace and
      // its `listensTo`. A finding skips this app, as a containment finding
      // does. validateHookWiring, after the loop, holds each `listensTo` to the
      // emitter's `consumers`, and a mismatch there still aborts the run.
      const hookScan = scanHooks(path.join(APPS_DIR, entry.name), entry.name);
      const hookFindings = checkHookNamespaces(
        entry.name,
        hookScan.calls,
        r.listensTo ?? [],
      );
      if (hookFindings.length > 0) {
        throw new AppRejectedError(
          `its hook calls break the cross-app hook rules:${formatHookFindings(hookFindings)}`,
        );
      }

      const updatedAt = await validateAppDatabase(r, entry.name);

      const manifest: AppManifest = {
        slug: entry.name,
        name: r.name,
        description: r.description ?? "",
        tagline: r.tagline ?? null,
        icon: r.icon ?? "box",
        connectors: r.connectors ?? [],
        optionalConnectors: r.optionalConnectors ?? [],
        database: r.database ?? false,
        updatedAt,
        notifications: r.notifications ?? false,
        hasPages,
        pageCount,
        global: r.global ?? false,
        roles: r.roles ?? [],
        defaultRole: r.defaultRole ?? null,
        hookCounts: hookScan.counts,
        hooks: { emits: hookScan.emits, listens: hookScan.listens },
        authors: normalizeAuthors(r.authors),
        keywords: r.keywords ?? [],
        screenshots: validateScreenshots(
          r.screenshots,
          "apps",
          entry.name,
          appDir,
        ),
        license: r.license ?? null,
        appUrl: r.appUrl ?? null,
        appSupportUrl: r.appSupportUrl ?? null,
        lastUpdated: parseLastUpdated(raw.lastUpdated),
        widgets: (r.widgets ?? []).map((w) => {
          const component = w.component;
          const filename = path.basename(component, path.extname(component));
          return {
            ...w,
            id: filename,
            component,
            defaultSize: w.defaultSize ?? { w: 4, h: 3 },
          };
        }),
        schedules,
        sync: validateSyncs(r.sync, entry.name, appDir, [
          ...(r.connectors ?? []),
          ...(r.optionalConnectors ?? []),
        ]),
        emits: r.emits ?? [],
        listensTo: r.listensTo ?? [],
        branding: validateAppBranding(r.branding, entry.name, appDir),
        escapes: validateEscapes(r.escapes, entry.name),
        env: validateEnv(r.env, entry.name),
        egress: r.egress ?? [],
        routes,
        telemetry: validateAppTelemetry(r.telemetry, entry.name),
        provides: validateProvides(r.provides, entry.name, appDir),
        consumes: normalizeConsumes(r.consumes),
        mcp: validateMcpTools(r.mcp, entry.name, appDir, [
          ...(r.connectors ?? []),
          ...(r.optionalConnectors ?? []),
        ]),
        ...(pageVisibility ? { pageVisibility } : {}),
        ...(apiVisibility ? { apiVisibility } : {}),
      };

      copyScreenshots(manifest.screenshots, "apps", entry.name, appDir);
      copyBrandLogos(manifest.branding, entry.name, appDir);

      manifests.push(manifest);
      console.log(`  App: ${manifest.name} (/${manifest.slug})`);

      // A missing README is VALID and must never fail a build — an app without
      // one still lists, on its manifest `description`. It is worth one line
      // anyway, because the cost lands somewhere the author cannot see it: the
      // public listing renders a paragraph where a page of prose belongs, and
      // nothing on this instance looks any different. Said once per app, at the
      // moment the app is registered, which is when the gap is cheap to close.
      if (!fs.existsSync(path.join(appDir, "README.md"))) {
        console.warn(
          `    No README.md — mixos.org will publish this app's listing from its one-line "description". See docs/apps/architecture.md.`,
        );
      }
    } catch (err) {
      // FatalManifestError aborts the entire generator run — see class doc.
      if (err instanceof FatalManifestError) throw err;
      console.warn(
        err instanceof AppRejectedError
          ? `  Skipping ${entry.name}/ — ${err.message}`
          : `  Skipping ${entry.name}/ — invalid manifest: ${err}`,
      );
    }
  }

  // App Services two-sided consent: every consumes ↔ provides pair must agree.
  validateServiceWiring(manifests);
  validateHookWiring(manifests);

  // No two apps may share a schema or a role. With valid slugs the encoding
  // cannot produce a clash; this is what would catch a change that let one.
  const clashes = appIdentifierProblems(manifests.filter((m) => m.database).map((m) => m.slug));
  if (clashes.length > 0) throw new FatalManifestError(clashes.join("\n"));

  return manifests;
}

interface ConnectorManifestOut {
  name: string;
  displayName: string;
  /** Public URL of the copied icon, or absent when the connector ships none. */
  icon?: string;
  userScoped?: boolean;
  description: string;
  setup?: ConnectorSetupGuide;
  credentialFields: { key: string; label: string; type: string }[];
  authors: AppAuthor[];
  lastUpdated: number | null;
  telemetry: ConnectorTelemetryDefinition[];
  auth?: ConnectorAuthPolicy;
  http?: ConnectorHttpPolicy;
  webhook?: ConnectorWebhookPolicy;
}

/** Smallest edge a connector icon may have, and it must be square. */
const CONNECTOR_ICON_MIN = 512;


/**
 * Prove a declared icon exists and is the shape the registry grid assumes.
 *
 * A wrong-sized icon does not degrade gracefully: the grid scales every tile
 * identically, so a 40x40 mark ships visibly blurred and a non-square one ships
 * stretched. Both are cheaper to catch here, where the message can name the
 * measured size, than in review.
 *
 * SVG is exempt from the pixel check — it has no intrinsic pixel size — but is
 * required to declare a viewBox, without which it cannot scale into the tile at
 * all.
 */
function validateConnectorIcon(icon: string, name: string, dir: string): void {
  // `icon` already carries its "assets/" prefix, so resolve it against the
  // connector root rather than re-adding the directory.
  const file = path.join(dir, icon);
  if (!fs.existsSync(file)) {
    throw new Error(
      `connector.json: icon is "${icon}", which does not exist. ` +
        `Expected it at connectors/${name}/${icon}.`,
    );
  }

  const ext = path.extname(icon).toLowerCase();
  if (![".png", ".webp", ".svg"].includes(ext)) {
    throw new Error(
      `connector.json: icon "${icon}" is a ${ext || "extensionless"} file. ` +
        `Connector icons must be .png, .webp or .svg.`,
    );
  }

  if (ext === ".svg") {
    const svg = fs.readFileSync(file, "utf-8");
    if (!/\bviewBox\s*=/.test(svg)) {
      throw new Error(
        `connectors/${name}/${icon} has no viewBox, so it cannot scale ` +
          `into the registry tile. Add one to the <svg> element.`,
      );
    }
    return;
  }

  const size = readImageSize(fs.readFileSync(file));
  if (!size) {
    throw new Error(
      `connectors/${name}/assets/${icon} could not be read as a ${ext.slice(1)} ` +
        `image. Re-export it, or ship an .svg instead.`,
    );
  }
  if (size.width !== size.height) {
    throw new Error(
      `connectors/${name}/assets/${icon} is ${size.width}x${size.height}. ` +
        `A connector icon must be square — the registry grid renders every tile ` +
        `at the same aspect, so this one would ship stretched.`,
    );
  }
  if (size.width < CONNECTOR_ICON_MIN) {
    throw new Error(
      `connectors/${name}/assets/${icon} is ${size.width}x${size.height}, below ` +
        `the ${CONNECTOR_ICON_MIN}x${CONNECTOR_ICON_MIN} minimum. Smaller than ` +
        `that visibly blurs on a high-DPI display.`,
    );
  }
}

async function scanConnectors(): Promise<ConnectorManifestOut[]> {
  if (!fs.existsSync(CONNECTORS_DIR)) {
    fs.mkdirSync(CONNECTORS_DIR, { recursive: true });
    return [];
  }

  const entries = fs.readdirSync(CONNECTORS_DIR, { withFileTypes: true });
  const connectors: ConnectorManifestOut[] = [];

  for (const entry of entries) {
    if (!entry.isDirectory()) continue;
    if (entry.name.startsWith("_")) continue; // template directories

    const connectorDir = path.join(CONNECTORS_DIR, entry.name);
    const manifestPath = path.join(connectorDir, "connector.json");
    if (!fs.existsSync(manifestPath)) continue;

    try {
      const rawJson = JSON.parse(fs.readFileSync(manifestPath, "utf-8"));

      // Schema-validate the manifest shape (types, required fields, unknown
      // keys, credential-field types). Hard-fails the build on any violation.
      const parsed = RawConnectorManifestSchema.safeParse(rawJson);
      if (!parsed.success) {
        throw new Error(
          `connector.json failed validation:\n${formatZodError(parsed.error)}`,
        );
      }
      const raw = parsed.data;

      // Folder name is the source of truth for the connector name (invariant).
      if (raw.name !== entry.name) {
        throw new Error(
          `connector.json "name" ("${raw.name}") must match the folder name ("${entry.name}").`,
        );
      }

      // Icon: proven to exist and to be a square >= 512x512 before anything
      // references it, then copied out with the rest of the connector's assets.
      // The registry contract first: a missing icon and a missing setup guide
      // are one report, not a build each.
      validateRegistryContract(entry.name, raw);
      if (raw.icon) validateConnectorIcon(raw.icon, entry.name, connectorDir);
      // Completeness of the capability list, which the Access tab presents as
      // exhaustive. Runs before the manifest is emitted so a gap cannot ship.
      validateConnectorMethods(
        entry.name,
        connectorDir,
        validateConnectorTelemetry(raw.telemetry, entry.name),
      );
      copyDir(
        path.join(connectorDir, "assets"),
        path.join(PUBLIC_CONNECTORS_DIR, entry.name),
      );

      const manifest: ConnectorManifestOut = {
        name: raw.name,
        displayName: raw.displayName,
        // Stored as the URL the browser will request, not the authoring path,
        // so no call site has to know where assets get copied to.
        ...(raw.icon
          ? {
              // `assets/` is where the file lives in the repo; the copy lands
              // directly under the connector's public directory, so strip it.
              icon: `/connector-assets/${entry.name}/${raw.icon.replace(/^assets\//, "")}`,
            }
          : {}),
        ...(raw.userScoped ? { userScoped: true } : {}),
        description: raw.description ?? "",
        ...(raw.setup ? { setup: raw.setup as ConnectorSetupGuide } : {}),
        credentialFields: raw.credentialFields ?? [],
        authors: normalizeAuthors(raw.authors),
        lastUpdated: parseLastUpdated(raw.lastUpdated),
        telemetry: validateConnectorTelemetry(raw.telemetry, entry.name),
        // Declarative transport/auth policy. Omitted keys stay omitted so the
        // runtime defaults in HttpConnector apply rather than being baked in
        // here — the registry records what was declared, not what was assumed.
        ...(raw.auth ? { auth: raw.auth as ConnectorAuthPolicy } : {}),
        ...(raw.http ? { http: raw.http as ConnectorHttpPolicy } : {}),
        ...(raw.webhook
          ? { webhook: raw.webhook as ConnectorWebhookPolicy }
          : {}),
      };

      connectors.push(manifest);
      console.log(`  Connector: ${manifest.displayName} (${manifest.name})`);
    } catch (err) {
      // Hard-fail on validation errors so a manifest/implementation mismatch
      // can't ship to production. Other parse/scan issues are also surfaced.
      throw new Error(
        `Failed to scan connectors/${entry.name}/: ${err instanceof Error ? err.message : String(err)}`,
      );
    }
  }

  return connectors;
}

/**
 * A scheduled job runs with no user, so it can never resolve a user-scoped
 * connector's grant — the connector would simply be absent at 3am and present
 * in a page request, which is the kind of difference nobody finds by reading.
 *
 * Rejected at build time rather than logged at runtime: a job that quietly does
 * nothing is the most expensive way to learn this.
 */
function validateUserScopedUsage(
  apps: AppManifest[],
  connectors: ConnectorManifestOut[],
): void {
  const userScoped = new Set(
    connectors.filter((c) => c.userScoped).map((c) => c.name),
  );
  if (userScoped.size === 0) return;

  for (const app of apps) {
    const declared = [...app.connectors, ...(app.optionalConnectors ?? [])];
    const offending = declared.filter((name) => userScoped.has(name));
    if (offending.length === 0) continue;

    const jobs = [
      ...(app.schedules ?? []).map((s) => `schedule "${s.name}"`),
      ...(app.sync ?? []).map((s) => `sync "${s.name}"`),
    ];
    if (jobs.length === 0) continue;

    throw new Error(
      `apps/${app.slug}/app.json declares the user-scoped connector(s) ` +
        `${offending.join(", ")} and also ${jobs.join(", ")}.\n` +
        `  A scheduled job runs with no user, so there is no grant to resolve ` +
        `and the connector would be absent every time the job ran.\n` +
        `  Use a tenant-scoped connector for background work, or move the ` +
        `connector-dependent part into a request the user makes.`,
    );
  }
}

/* -------------------------------------------------------------------------- */
/*  Build stamp                                                               */
/* -------------------------------------------------------------------------- */

/**
 * The highest-numbered migration in supabase/migrations/.
 *
 * This is the schema the code being built expects, and it is derived from the
 * filesystem rather than hand-maintained for the obvious reason: a constant
 * somebody has to remember to bump alongside a file they just added is a
 * constant that will disagree with the directory within a month.
 *
 * Files are `NNNN_name.sql`. Anything that does not start with digits is not a
 * migration the Supabase CLI will apply in order, so it is ignored here too.
 */
function expectedSchemaVersion(): number {
  if (!fs.existsSync(MIGRATIONS_DIR)) return 0;
  const numbers = fs
    .readdirSync(MIGRATIONS_DIR)
    .filter((f) => f.endsWith(".sql"))
    .map((f) => Number(/^(\d+)/.exec(f)?.[1] ?? NaN))
    .filter((n) => Number.isInteger(n));
  return numbers.length ? Math.max(...numbers) : 0;
}

/**
 * Every app migration the release step will run: the files of each app this
 * build accepted with `"database": true`, listed as the runner lists them
 * (scripts/app-migration-files.ts), so the two agree on what "every app
 * migration" is.
 */
function expectedAppMigrations(apps: readonly AppManifest[]): { slug: string; file: string }[] {
  return listAppMigrations(APPS_DIR, apps).flatMap(({ slug, files }) =>
    files.map((file) => ({ slug, file })),
  );
}

/**
 * The build-time facts the running server cannot work out for itself.
 *
 * Everything else about build identity is a RUNTIME variable, and deliberately:
 * `MIXOS_RELEASE` already carries the tag and is stamped into the runner stage
 * by the tag build (see the Dockerfile, and `isReleaseBuild` in
 * src/lib/repository/client.ts). Baking a second copy of the version in here
 * would create two sources of truth for one fact, and the one in the generated
 * file would be the stale one — it is written by the builder stage, which never
 * sees the runner stage's ARG.
 *
 * The schema version is different. It is derived from `supabase/migrations/`,
 * and that directory is not copied into the runner image at all, so the number
 * has to travel with the build or not exist.
 *
 * So is the list of app migrations the readiness probe waits for. `apps/` is in
 * the Docker image, but a serverless function sees a repository file only if
 * output tracing put it there; a list compiled into the server needs neither.
 *
 * NOTE: no timestamp and no commit here. Every value in this file is stable for
 * a given checkout, so re-running the generator rewrites an identical file and
 * the dev server has nothing to recompile. A timestamp — or a git SHA, which
 * moves on every commit — would invalidate that on every `predev`.
 */
function writeBuildInfo(apps: readonly AppManifest[], report = true): void {
  const schema = expectedSchemaVersion();
  const appMigrations = expectedAppMigrations(apps);

  const output = `// AUTO-GENERATED by scripts/generate-project-registry.ts — do not edit
//
// Derived from supabase/migrations/ and apps/*/migrations/ at build time, so the
// running server knows what it was built against without reading either. See
// src/lib/platform/schema-version.ts and src/lib/platform/app-migrations.ts for
// what this gates, and src/lib/platform/version.ts for the runtime half of
// build identity.

/** Highest migration number in supabase/migrations/ at build time. */
export const EXPECTED_SCHEMA_VERSION = ${schema};

/** Every app migration the release step runs, at build time. */
export const EXPECTED_APP_MIGRATIONS: readonly { slug: string; file: string }[] = ${JSON.stringify(appMigrations, null, 2)};
`;

  fs.writeFileSync(BUILD_INFO_FILE, output, "utf-8");
  if (report) {
    console.log(
      `Build stamp: expected schema version ${schema}, ${appMigrations.length} app migration(s)`,
    );
  }
}

async function main() {
  if (!fs.existsSync(OUTPUT_DIR)) {
    fs.mkdirSync(OUTPUT_DIR, { recursive: true });
  }

  // The stamp lists only the migrations of apps the scan accepts, so it is
  // written after the scan. A fresh checkout still gets one first, in case a
  // module the scan imports reads it.
  if (!fs.existsSync(BUILD_INFO_FILE)) writeBuildInfo([], false);

  console.log("Scanning apps...");
  const apps = await scanApps();
  writeBuildInfo(apps);
  const slugs = apps.map((m) => `"${m.slug}"`).join(", ");

  // Build static import maps for pages and widgets
  const pageImports: string[] = [];
  const widgetImports: string[] = [];

  for (const app of apps) {
    // Scan pages
    const pagesDir = path.join(APPS_DIR, app.slug, "pages");
    if (fs.existsSync(pagesDir)) {
      scanPages(pagesDir, app.slug, "", pageImports);
    }

    // Widgets from manifest
    for (const widget of app.widgets) {
      const widgetFile = path.join(APPS_DIR, app.slug, widget.component);
      if (fs.existsSync(widgetFile)) {
        const key = `${app.slug}/${widget.component}`;
        widgetImports.push(
          `  "${key}": () => import("@apps/${app.slug}/${widget.component}"),`,
        );
      }
    }
  }

  const appOutput = `// AUTO-GENERATED by scripts/generate-project-registry.ts — do not edit
import type { AppManifest } from "@/lib/apps/types";
import type { ComponentType } from "react";
import type { ResolvedConfig } from "@/lib/hooks/types";

export const appRegistry: AppManifest[] = ${JSON.stringify(apps, null, 2)};

export const appSlugs = [${slugs}] as const;
export type AppSlug = (typeof appSlugs)[number];

// NOTE: \`pageLoaders\` deliberately lives in ./app-page-loaders, NOT here.
//
// Client components import this file for \`appRegistry\` and \`widgetLoaders\`.
// If the page loaders lived alongside them, every app PAGE would be pulled into
// the client graph too — and a page is a server component, free to reach the
// database or a connector through \`callAppRoute\`. That made a single
// server-rendered page fail the whole client build with a module-not-found
// several layers deep in the platform.
//
// Widget modules may also export an optional \`resolveConfig\` that the config
// modal calls to fill in dynamic options/defaults at open time.
// eslint-disable-next-line @typescript-eslint/no-explicit-any
export const widgetLoaders: Record<string, () => Promise<{ default: ComponentType<any>; resolveConfig?: (args: { appSlug: string }) => Promise<ResolvedConfig> | ResolvedConfig }>> = {
${widgetImports.join("\n")}
};
`;

  fs.writeFileSync(APP_REGISTRY_FILE, appOutput, "utf-8");
  console.log(`\nGenerated app registry with ${apps.length} app(s)`);

  // Server-only. See the note in the registry above.
  const pageLoadersOutput = `// AUTO-GENERATED by scripts/generate-project-registry.ts — do not edit
//
// SERVER ONLY. App pages are server components and may reach the database or a
// connector via callAppRoute, so this map must never enter the client graph.
// Its single consumer is src/lib/apps/loader.ts.
import type { ComponentType } from "react";

// eslint-disable-next-line @typescript-eslint/no-explicit-any
export const pageLoaders: Record<string, () => Promise<{ default: ComponentType<any> }>> = {
${pageImports.join("\n")}
};
`;
  fs.writeFileSync(APP_PAGE_LOADERS_FILE, pageLoadersOutput, "utf-8");

  // Server-only, like the page loaders: an entrypoint registers server-side
  // hooks and is never something a client bundle should pull in.
  const hookImports = apps
    .filter((app) => fs.existsSync(path.join(APPS_DIR, app.slug, "hooks.ts")))
    .map((app) => `  "${app.slug}": () => import("@apps/${app.slug}/hooks"),`);
  const hookLoadersOutput = `// AUTO-GENERATED by scripts/generate-project-registry.ts — do not edit
//
// SERVER ONLY. Each app's declared hook entrypoint, apps/<slug>/hooks.ts.
// Its single consumer is src/lib/hooks/loader.ts.
import type { HookRegistrar } from "@/lib/hooks/types";

export const hookLoaders: Record<string, () => Promise<{ default: (hooks: HookRegistrar) => void }>> = {
${hookImports.join("\n")}
};
`;
  fs.writeFileSync(APP_HOOK_LOADERS_FILE, hookLoadersOutput, "utf-8");

  // ── Typed client surface ──────────────────────────────────────────────────
  //
  // A TYPE-ONLY map from `<slug>` → `"<METHOD> /<pattern>"` → the route's own
  // `defineRoute` result. `typeof import(...)` is an inline type query, so
  // nothing here survives compilation and no app module is loaded at runtime.
  //
  // This is what turns `client.get<T>()` — an assertion the author could get
  // wrong silently — into `client.call("GET /items", …)` with the input and
  // output inferred from the schemas the route actually declared. It only works
  // because `RouteDefinition` is generic in those two shapes; a non-generic one
  // would erase them at the export boundary.
  // Templates are skipped by the registry (they are scaffolds, not apps) but
  // they ARE the canonical worked example, and an example that does not compile
  // as written teaches the wrong thing. So their routes get type entries here —
  // type-only, so nothing is registered and nothing loads at runtime.
  const templateRoutes: { slug: string; routes: RouteContract[] }[] = [];
  for (const entry of fs.readdirSync(APPS_DIR, { withFileTypes: true })) {
    if (!entry.isDirectory() || !entry.name.startsWith("_")) continue;
    const dir = path.join(APPS_DIR, entry.name);
    if (!fs.existsSync(path.join(dir, "app.json"))) continue;
    try {
      templateRoutes.push({
        slug: entry.name,
        routes: await scanApiRoutes(dir, entry.name),
      });
    } catch (err) {
      console.warn(
        `  Skipping types for template ${entry.name}/ — ${err instanceof Error ? err.message : String(err)}`,
      );
    }
  }

  const clientEntries = [
    ...apps.map((a) => ({ slug: a.slug, routes: a.routes ?? [] })),
    ...templateRoutes,
  ]
    .map((app) => {
      const routes = app.routes.flatMap((route) =>
        route.methods.map((m) => {
          const modulePath = route.path === "" ? "index" : route.path;
          return `    "${m.method} /${route.path}": typeof import("@apps/${app.slug}/api/${modulePath}/route").${m.method};`;
        }),
      );
      if (routes.length === 0) return `  "${app.slug}": Record<string, never>;`;
      return `  "${app.slug}": {\n${routes.join("\n")}\n  };`;
    })
    .join("\n");

  const clientsOutput = `// AUTO-GENERATED by scripts/generate-project-registry.ts — do not edit
//
// Type-only. Every entry is an inline \`typeof import(...)\` query, so this file
// compiles away entirely and never loads an app module at runtime.

/**
 * Every app's declared routes, keyed by slug and then by \`"<METHOD> /<pattern>"\`.
 * The pattern keeps its \`[param]\` segments — values travel in the call's input,
 * never in the key.
 */
export interface AppRouteTypes {
${clientEntries || "  // no apps"}
}

export type AppWithRoutes = keyof AppRouteTypes;
`;

  fs.writeFileSync(APP_CLIENTS_FILE, clientsOutput, "utf-8");
  console.log(
    `Generated typed client surface for ${apps.reduce((n, a) => n + (a.routes?.length ?? 0), 0)} route(s)`,
  );

  console.log("\nScanning connectors...");
  const connectors = await scanConnectors();

  const connectorOutput = `// AUTO-GENERATED by scripts/generate-project-registry.ts — do not edit
import type { ConnectorManifest } from "@/lib/connectors/types";

export const connectorRegistry: ConnectorManifest[] = ${JSON.stringify(connectors, null, 2)};

export const connectorNames = [${connectors.map((c) => `"${c.name}"`).join(", ")}] as const;
export type ConnectorName = (typeof connectorNames)[number];
`;

  fs.writeFileSync(CONNECTOR_REGISTRY_FILE, connectorOutput, "utf-8");
  console.log(
    `Generated connector registry with ${connectors.length} connector(s)`,
  );

  // Both registries are in hand here, which is what this check needs.
  validateUserScopedUsage(apps, connectors);

  console.log("\nScanning themes...");
  const { themes, css: themeCss, tokens: themeTokens } = await scanThemes();

  if (themes.length === 0) {
    throw new ThemeError(
      "No themes found under themes/. The platform renders entirely through theme tokens, " +
        "so an install with no theme has no colours, no type and no radii at all.",
    );
  }

  // The fallback when the database has no active-theme row yet — a fresh
  // install, or a row naming a theme that has since been uninstalled.
  // Alphabetically first, so the choice is deterministic rather than dependent
  // on directory iteration order.
  const fallbackTheme = themes[0].slug;

  fs.writeFileSync(
    THEMES_CSS_FILE,
    `/* AUTO-GENERATED by scripts/generate-project-registry.ts — do not edit
 *
 * Every installed theme, each scoped to [data-theme="<slug>"]. All of them are
 * bundled so that switching the active theme is a database write and an
 * attribute swap on <html>, not a rebuild and a redeploy.
 */
${themeCss}
`,
    "utf-8",
  );

  const themeOutput = `// AUTO-GENERATED by scripts/generate-project-registry.ts — do not edit
import type { ThemeManifest } from "@/lib/themes/types";

export const themeRegistry: ThemeManifest[] = ${JSON.stringify(themes, null, 2)};

export const themeSlugs = [${themes.map((t) => `"${t.slug}"`).join(", ")}] as const;
export type ThemeSlug = (typeof themeSlugs)[number];

/**
 * Used when the database has no active-theme row, or names a theme that is no
 * longer installed. Alphabetically first among installed themes.
 */
export const FALLBACK_THEME: ThemeSlug = "${fallbackTheme}";

export function getTheme(slug: string): ThemeManifest {
  return themeRegistry.find((t) => t.slug === slug) ?? themeRegistry[0];
}
`;
  fs.writeFileSync(THEME_REGISTRY_FILE, themeOutput, "utf-8");

  // Read by eslint-rules/no-low-contrast-token-pairs.mjs, which cannot import
  // TypeScript and must not re-parse CSS. It lints against every installed
  // theme: which one is *active* is a runtime database value the build cannot
  // know, so an element has to clear the floor under each of them.
  fs.writeFileSync(
    THEME_TOKENS_FILE,
    JSON.stringify({ fallback: fallbackTheme, tokens: themeTokens }, null, 2),
    "utf-8",
  );

  console.log(
    `Generated theme registry with ${themes.length} theme(s); fallback is "${fallbackTheme}"`,
  );
}

main().catch((err) => {
  console.error(err);
  process.exit(1);
});
