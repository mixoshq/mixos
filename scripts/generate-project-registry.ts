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
  ScheduleDefinition,
  ServiceDefinition,
  ServiceDependency,
  SyncDefinition,
  TelemetryEventDefinition,
  UpdatedAtColumn,
} from "../src/lib/apps/types";
import { MIXOS_SOURCE } from "../src/lib/apps/types";
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
  RemixEntrySchema,
  formatZodError,
} from "./manifest-schemas";
import { schemaProblem } from "../src/lib/extensions/schema-urls";
import { compareSlugs, registryIdProblem } from "../src/lib/extensions/slug-id";
import { readRenames, renameProblems, type ExtensionRename } from "./extension-renames";
import { normalizeRemixKeywords, type RemixIndexEntry } from "../src/lib/apps/remix";
import {
  connectorEntryNames,
  connectorRequirements,
  describeConnectorVersion,
  satisfiesConnectorVersion,
} from "../src/lib/connectors/requirements";
import type {
  ThemeAssets,
  ThemeFontFace,
  ThemeManifest,
} from "../src/lib/themes/types";
import { compileTheme, ThemeError } from "./theme-css";
import { PublicCopies, type CopyPlace } from "./public-copies";
import { applyWidgetConfigs } from "./widget-configs";
import { FatalManifestError } from "./manifest-errors";
import { readImageSize } from "./image-size";
import { resolveThemeLogo, validateAppBranding } from "./brand-checks";
import { appMigrationFiles, listAppMigrations } from "./app-migration-files";
import { listPlatformMigrations } from "./platform-migration-files";
import { checkAppMigrationSql, describeAppTables, formatSqlProblems } from "./app-sql-policy";
import {
  appIdentifierProblems,
  appSchemaName,
  appSlugProblem,
  reservedAppSlugProblem,
} from "../src/lib/apps/app-identifiers";
import { readReleaseNotes, releaseNotesOf } from "./release-notes";
import {
  CORE_SLUG,
  RELEASE_NOTES_FILE,
  RELEASE_NOTE_KINDS,
  type ReleaseNote,
} from "../src/lib/release-notes/types";
import {
  checkHookNamespaces,
  formatHookFindings,
  scanHooks,
  validateHookWiring,
} from "./hook-checks";
import {
  formatFindings,
  scanAppContainment,
  type ContainmentFinding,
} from "./app-containment";
import { isScannedFile } from "../src/lib/apps/import-policy.mjs";
import {
  declaresRawResponse,
  rawResponseRefusal,
  routeContract,
  undeclaredRoleProblems,
} from "./route-contracts";
import { readRoutesStatically } from "./route-reader";
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
import {
  buildCheckVerdict,
  serializeCheckVerdict,
} from "../src/lib/repository/check-verdict";
import { DEFAULT_REPOSITORY_URL } from "../src/lib/repository/client";
import {
  FolderReadError,
  INSTALL_RECORD_FILE,
  folderFilesHash,
  readInstallRecord,
  recordMismatch,
  type RegistryInstall,
} from "../src/lib/repository/install-record";
import { sourceHost } from "../src/lib/repository/provenance";
import { KIND_SEGMENT } from "../src/lib/repository/types";
import { checkFloor } from "../src/lib/platform/version-floor";
import {
  CheckoutLockHeldError,
  CheckoutLockLostError,
  acquireCheckoutLock,
  adoptCheckoutLock,
  describeCheckoutLockHolder,
  type CheckoutLock,
} from "../src/lib/platform/checkout-lock";
import * as ts from "typescript";
import { z } from "zod";

/**
 * Thrown when an app is refused for what its code does, not for a malformed
 * manifest — an undeclared escape, or a hook call the hook rules refuse (see
 * scripts/hook-checks.ts). Takes the per-app `Skipping ...`
 * path like any other per-app failure, but prints its own message rather than
 * "invalid manifest", which would send the author to the wrong file.
 *
 * `problems` is the same refusal one finding per line, each naming its file
 * from the folder that holds the app, for the verdict `--check` writes.
 */
class AppRejectedError extends Error {
  readonly problems: string[];
  constructor(message: string, problems?: string[]) {
    super(message);
    this.name = "AppRejectedError";
    this.problems = problems && problems.length > 0 ? problems : [message];
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
const PACKAGE_JSON_FILE = path.resolve(__dirname, "../package.json");
const BUILD_INFO_FILE = path.resolve(OUTPUT_DIR, "build-info.ts");
const THEME_REGISTRY_FILE = path.resolve(OUTPUT_DIR, "theme-registry.ts");
const THEMES_CSS_FILE = path.resolve(OUTPUT_DIR, "themes.css");
const THEME_TOKENS_FILE = path.resolve(OUTPUT_DIR, "theme-tokens.json");
const REGISTRY_INSTALLS_FILE = path.resolve(OUTPUT_DIR, "registry-installs.ts");
const REMIX_INDEX_FILE = path.resolve(OUTPUT_DIR, "remix-index.ts");
const RELEASE_NOTES_OUTPUT_FILE = path.resolve(OUTPUT_DIR, "release-notes.ts");
const EXTENSION_RENAMES_FILE = path.resolve(OUTPUT_DIR, "extension-renames.ts");
// MixOS's own release notes, release-notes.json at the root of the repository.
const CORE_DIR = path.resolve(__dirname, "..");
// What each extension publishes for pages read without a session is copied
// into public/, each into a folder of its own, at one of five places:
// themes/<slug>/ (a theme's assets/), connector-assets/<name>/ (a prefix of
// its own rather than connectors/, so exempting it can't take the sign-in
// guard off a page; and exempt it must be, because next/image's optimizer
// fetches the source URL server-side with no cookies and would fail on every
// icon),
// screenshots/<apps|themes>/<slug>/ (listing galleries: one prefix for both
// kinds, because the rules are identical and a second prefix would be a second
// proxy exemption to keep in step) and branding/apps/<slug>/ (an app's marks
// for the brand hooks, which the sign-in page renders). Each is exempt from the
// auth matcher in src/proxy.ts. Every copy is recorded, and a full run deletes
// the ones it no longer makes: scripts/public-copies.ts.
const PUBLIC_DIR = path.resolve(__dirname, "../public");
const PUBLIC_COPIES_FILE = path.resolve(OUTPUT_DIR, "public-copies.json");

/**
 * Whether a folder in apps/, connectors/ or themes/ is an extension to scan.
 *
 * Not `_template` and its kin, which are scaffolds. And not a folder whose name
 * starts with a dot, which is something kept beside the extensions rather than
 * one of them: a copy set aside, a backup, an editor's metadata. Scanned, a
 * copy of an app would be imported and registered as an app of its own.
 * Installs stage and wait in `.mixos/` (src/lib/repository/pending.ts), which
 * no scan reads.
 */
function isExtensionFolder(entry: fs.Dirent): boolean {
  return entry.isDirectory() && !entry.name.startsWith("_") && !entry.name.startsWith(".");
}

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
 * files `validatePageVisibility` resolves a `pageVisibility` key against: a page
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
 * The entry points the registry makes loadable that the containment scan did
 * not read, relative to the app. Empty for a clean app.
 *
 * The scan reads an app's source and refuses any import of a file it skipped,
 * but an entry point is loaded by the platform, not imported by the app: a
 * widget's `component`, a page, a job, a sync, a service, an MCP tool or
 * `hooks.ts`. Each is named by the manifest or found on disk, so each is held
 * to the same rule here. Routes are checked before the generator imports them,
 * in findRouteFiles().
 */
function unscannedEntryPoints(appDir: string, manifest: AppManifest): string[] {
  const real = fs.realpathSync(appDir);
  const entries: string[] = ["hooks.ts", "widgets.ts", ...manifest.widgets.map((w) => w.component)];
  for (const [dir, names] of [
    ["jobs", manifest.schedules.map((s) => s.name)],
    ["sync", manifest.sync.map((s) => s.name)],
    ["services", manifest.provides.map((s) => s.name)],
    ["mcp", manifest.mcp.map((t) => t.name)],
  ] as const) {
    for (const name of names) entries.push(`${dir}/${name}.ts`, `${dir}/${name}.tsx`);
  }
  const pages = (dir: string, prefix: string) => {
    for (const entry of fs.readdirSync(dir, { withFileTypes: true })) {
      if (entry.isDirectory()) pages(path.join(dir, entry.name), `${prefix}${entry.name}/`);
      else if (entry.name === "Main.tsx" || entry.name === "Main.ts") entries.push(`${prefix}${entry.name}`);
    }
  };
  if (fs.existsSync(path.join(appDir, "pages"))) pages(path.join(appDir, "pages"), "pages/");

  return entries.filter((rel) => {
    const full = path.resolve(appDir, rel);
    return fs.existsSync(full) && !isScannedFile(real, fs.realpathSync(full));
  });
}

/**
 * Read an app manifest, `app.json`, as text. Null when the app has none.
 *
 * `app.json` is the only manifest form. It is static text, which means the
 * install path can schema-check the bytes BEFORE anything executes — see
 * preflight() in src/lib/repository/install.ts, and `--check` below. A manifest
 * in code (an `app.ts` exporting it) would invert that order: the module would
 * have to be imported before there was anything to validate, which for apps
 * arriving from the Registry is the wrong way round.
 *
 * The one thing JSON cannot express is a config field built from a helper, so
 * that — and only that — lives in an optional `widgets.ts`, merged in once the
 * app's code is loaded (loadAppCode() below, and applyWidgetConfigs() in
 * ./widget-configs.ts).
 */
function readAppJson(appDir: string): Record<string, unknown> | null {
  const jsonPath = path.join(appDir, "app.json");
  if (!fs.existsSync(jsonPath)) return null;

  // Anything but an object is the schema's to refuse, as it always was.
  return JSON.parse(fs.readFileSync(jsonPath, "utf-8")) as Record<string, unknown>;
}

/**
 * Whether an app's folder is named after its `registryId`, read from its
 * app.json alone, so it can be asked before containment. A folder renamed by
 * hand would otherwise reach containment first, which reports the app's calls
 * to its own slug as calls to another app. Null without a manifest, or with a
 * `registryId` that isn't a string: the schema says so in readAppText().
 */
function appFolderNameProblem(appDir: string, folder: string): string | null {
  let raw: Record<string, unknown> | null;
  try {
    raw = readAppJson(appDir);
  } catch {
    return null;
  }
  const declared = raw?.registryId;
  return typeof declared === "string" ? registryIdProblem("app", `apps/${folder}/app.json`, declared, folder) : null;
}

/**
 * Validate the `pageVisibility` map from app.json.
 *
 * The Zod schema has already checked the *values* — that each is a non-empty,
 * duplicate-free array of known auths, and that no page claims `key`. What a
 * schema cannot check is the filesystem, so that is all this does: each key
 * must be POSIX-shaped and must resolve to a real `Main.tsx` (or `Main.ts`)
 * under `pages/`.
 *
 * Any failure throws `FatalManifestError`, which aborts the generator. Being
 * lenient here is not an option — a typo'd path silently leaves a page at the
 * default (fine) while the developer believes they published it (not fine),
 * and the inverse typo publishes something nobody reviewed.
 *
 * An API route declares its auth beside its handler, in `defineRoute`, so
 * there is no map for routes.
 */
function validatePageVisibility(
  raw: unknown,
  slug: string,
  appDir: string,
): Record<string, RouteAuth[]> | undefined {
  const field = "pageVisibility";
  const terminalFiles = ["Main.tsx", "Main.ts"];
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
    const candidates = terminalFiles.map((f) => path.join(appDir, "pages", key, f));
    if (!candidates.some((p) => fs.existsSync(p))) {
      const expected = `pages/${key ? key + "/" : ""}${terminalFiles[0]}`;
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

/** One `route.ts` under an app's `api/`, found without importing it. */
interface RouteFile {
  /** Absolute path of the `route.ts`. */
  file: string;
  /** POSIX, relative to `api/`; `""` for `api/index/route.ts`. */
  routePath: string;
}

/**
 * Walk `apps/<slug>/api/` and list every `route.ts`, refusing what the walk
 * alone can tell is wrong: a `.tsx` route, a root `api/route.ts`, an optional
 * catch-all, a route the containment scan does not read, two files for one
 * path. Reads the tree only, so `--check` runs it too.
 */
function findRouteFiles(appDir: string, slug: string): RouteFile[] {
  const apiDir = path.join(appDir, "api");
  if (!fs.existsSync(apiDir)) return [];

  const found: RouteFile[] = [];

  function walk(dir: string, segments: string[]): void {
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

      // The root route is `api/index/route.ts`, and its path is the empty
      // string, as the root page's `pageVisibility` key is.
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

      // A route in a directory the containment scan skips (a dot-directory,
      // say) is code nobody judged, and importing it would run it.
      if (!isScannedFile(fs.realpathSync(appDir), fs.realpathSync(routeFile))) {
        const rel = `api/${segments.join("/")}/route.ts`;
        throw new AppRejectedError(
          `${rel} is in a directory the containment scan does not read, so it cannot be a route.`,
          [`apps/${slug}/${rel} is in a directory the containment scan does not read, so it cannot be a route.`],
        );
      }

      found.push({ file: routeFile, routePath });
    }

    for (const entry of entries) {
      if (!entry.isDirectory()) continue;
      walk(path.join(dir, entry.name), [...segments, entry.name]);
    }
  }

  walk(apiDir, []);

  // Two contracts sharing a path would make `routes.find(...)` — which the
  // public mount uses to decide a route's auth gate — resolve by array order.
  const byPath = new Set<string>();
  for (const { routePath } of found) {
    if (byPath.has(routePath)) {
      throw new FatalManifestError(
        `apps/${slug}: two route files resolve to the same path "${routePath || "(root)"}". ` +
          `One of them is unreachable, and which one decides the route's auth would be an accident of ordering.`,
      );
    }
    byPath.add(routePath);
  }

  return found;
}

/**
 * Import each route file and hoist its declared contract into the registry.
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
 * lazily — not an argument for a contract nobody can check. It is also why an
 * install's `--check` never gets here. It reads what it can of each route from
 * the AST instead (scripts/route-reader.ts), holds that to three of the rules
 * here, in the same words, and lists the rest as deferred, to be checked when
 * the app is registered.
 */
async function importRouteContracts(
  slug: string,
  files: readonly RouteFile[],
): Promise<RouteContract[]> {
  const contracts: RouteContract[] = [];
  for (const { file, routePath } of files) {
    let mod: Record<string, unknown>;
    try {
      // `?t=` defeats the ESM module cache, so a re-run in the same process
      // (watch mode) sees edits. Same idiom as applyWidgetConfigs.
      mod = (await import(`${pathToFileURL(file).href}?t=${Date.now()}`)) as Record<string, unknown>;
    } catch (err) {
      throw new FatalManifestError(
        `apps/${slug}/api/${routePath || "index"}/route.ts could not be imported: ${
          err instanceof Error ? err.message : String(err)
        }`,
      );
    }
    contracts.push(routeContract(slug, routePath, mod));
  }
  contracts.sort((a, b) => a.path.localeCompare(b.path));
  return contracts;
}

/** Walk `apps/<slug>/api/`, import every `route.ts`, and return the contracts. */
async function scanApiRoutes(appDir: string, slug: string): Promise<RouteContract[]> {
  return importRouteContracts(slug, findRouteFiles(appDir, slug));
}

/**
 * Cross-check hoisted route contracts against the rest of the manifest.
 *
 * A route can declare a role the app never defined, which would gate the route
 * on something no user can ever hold — a silent 403 forever — and roles beside
 * an auth that carries none.
 */
function validateRouteContracts(
  contracts: RouteContract[],
  slug: string,
  declaredRoles: { key: string }[],
): void {
  for (const contract of contracts) {
    for (const m of contract.methods) {
      // The first role the app does not declare. An install's check reads the
      // same rule off the route's source (scripts/route-reader.ts).
      const [undeclared] = undeclaredRoleProblems(slug, contract.path, m.method, m.roles, declaredRoles);
      if (undeclared) throw new FatalManifestError(undeclared);

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
  const dest = publicFolder("branding/apps", slug);
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
  const allowedSources = new Set([...connectors, MIXOS_SOURCE]);

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
          `which is neither a connector this app declares nor "${MIXOS_SOURCE}".`,
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
 * declares (or `"mixos"`, for data with no upstream system). That claim is shown
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
      if (src === MIXOS_SOURCE || connectors.includes(src)) continue;
      const declared = connectors.length
        ? `Declared connectors: ${connectors.join(", ")}.`
        : "This app declares no connectors.";
      throw new FatalManifestError(
        `apps/${slug}/app.json: mcp tool "${t.name}" lists source "${src}", ` +
          `which is not a connector this app declares. ${declared} ` +
          `Use "${MIXOS_SOURCE}" for data that exists only in MixOS.`,
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
  const dest = publicFolder(kind === "apps" ? "screenshots/apps" : "screenshots/themes", slug);
  fs.mkdirSync(dest, { recursive: true });
  for (const shot of screenshots) {
    fs.copyFileSync(
      path.join(dir, shot.file),
      path.join(dest, path.basename(shot.file)),
    );
  }
}

// ── public/ ──────────────────────────────────────────────────────────────────

/** This run's copies into public/: made by main(), and by the first copy outside it. */
let publicCopies: PublicCopies | null = null;

/** The folder in public/ to copy an extension's files into, recorded first (scripts/public-copies.ts). */
function publicFolder(place: CopyPlace, name: string): string {
  publicCopies ??= new PublicCopies(PUBLIC_DIR, PUBLIC_COPIES_FILE);
  return publicCopies.folder(place, name);
}

/** Copy an extension's assets/ folder, when it has one, to its folder at `place`. */
function copyAssets(from: string, place: "themes" | "connector-assets", name: string): void {
  if (!fs.existsSync(from)) return;
  copyDir(from, publicFolder(place, name));
}

// ── themes ───────────────────────────────────────────────────────────────────

/** Recursively copy a folder, a theme's or a connector's assets/, into public/. */
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

/** One theme as its files describe it: its registry entry and its compiled CSS. */
interface ThemeText {
  theme: ThemeManifest;
  compiled: ReturnType<typeof compileTheme>;
}

/**
 * Every check on one theme, and its registry entry. Null when the folder has
 * no `theme.json`. A theme is text and assets with no code, and this writes
 * nothing, so an install's `--check` runs it on the staged copy as it is.
 */
function readTheme(dir: string, slug: string): ThemeText | null {
  if (!/^[a-z0-9][a-z0-9-]*$/.test(slug)) {
    throw new ThemeError(
      `themes/${slug}: a theme folder name is its slug and appears in a CSS attribute ` +
        `selector — use lowercase letters, digits and hyphens.`,
    );
  }

  const manifestPath = path.join(dir, "theme.json");
  if (!fs.existsSync(manifestPath)) return null;

  const themeJson = JSON.parse(fs.readFileSync(manifestPath, "utf-8"));
  const themeShape = schemaProblem("theme", themeJson?.$schema, `themes/${slug}/theme.json`);
  if (themeShape) throw new ThemeError(themeShape);
  const parsed = RawThemeManifestSchema.safeParse(themeJson);
  if (!parsed.success) {
    throw new ThemeError(
      `themes/${slug}/theme.json failed validation:\n${formatZodError(parsed.error)}`,
    );
  }
  const r = parsed.data;

  // Named after its registryId, so no two themes share a slug, and so not a
  // `data-theme` value either.
  const themeId = registryIdProblem("theme", `themes/${slug}/theme.json`, r.registryId, slug);
  if (themeId) throw new ThemeError(themeId);

  const compiled = compileTheme({
    slug,
    dir,
    escapes: r.escapes ?? [],
    declaredSurfaces: r.surfaces ?? [],
    declaredFonts: (r.fonts ?? []).map((f) => f.file),
  });

  // Read again by main() for what it accepts; checked here for --check too.
  readReleaseNotes(dir, `themes/${slug}/${RELEASE_NOTES_FILE}`);

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

  return {
    theme: {
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
    },
    compiled,
  };
}

async function scanThemes(
  themesDir: string = THEMES_DIR,
  { emit = true }: { emit?: boolean } = {},
): Promise<{
  themes: ThemeManifest[];
  css: string;
  tokens: Record<string, Record<string, string>>;
}> {
  if (!fs.existsSync(themesDir)) {
    return { themes: [], css: "", tokens: {} };
  }

  const themes: ThemeManifest[] = [];
  const cssParts: string[] = [];
  const tokens: Record<string, Record<string, string>> = {};

  const entries = fs
    .readdirSync(themesDir, { withFileTypes: true })
    // Not templates, and nothing dot-prefixed (see isExtensionFolder).
    .filter(isExtensionFolder)
    // By name, then id, so the first theme doesn't depend on the id it drew.
    .sort((a, b) => compareSlugs(a.name, b.name));

  for (const entry of entries) {
    const slug = entry.name;
    const dir = path.join(themesDir, slug);

    const read = readTheme(dir, slug);
    if (!read) {
      // As with apps: plans/ may precede the thing it plans.
      if (fs.existsSync(path.join(dir, "plans"))) {
        console.log(`  themes/${slug}/ — planned, not yet built (plans/ only)`);
      } else {
        console.warn(`  Skipping themes/${slug}/ — no theme.json`);
      }
      continue;
    }
    const { theme, compiled } = read;

    if (emit) {
      copyAssets(path.join(dir, "assets"), "themes", slug);
      copyScreenshots(theme.screenshots, "themes", slug, dir);
    }

    cssParts.push(
      `/* ── ${slug} ─────────────────────────────── */\n${compiled.css}`,
    );
    tokens[slug] = compiled.tokens;
    themes.push(theme);

    const escaped = theme.escapes.length;
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
 *
 * The migrations are read from `appDir`, the folder being scanned, which for an
 * install's `--check` is the staged copy rather than apps/<slug>/.
 */
async function validateAppDatabase(
  raw: {
    database?: boolean;
    updatedAt?: { table: string; column?: string }[];
  },
  slug: string,
  appDir: string,
): Promise<UpdatedAtColumn[]> {
  const files = appMigrationFiles(path.dirname(appDir), path.basename(appDir));
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
    const text = fs.readFileSync(path.join(appDir, "migrations", file), "utf-8");
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

// ── apps: what the text says, then what the code says ────────────────────────

type RawApp = z.infer<typeof RawAppManifestSchema>;

/**
 * What an app's files say, read without running any of its code: everything
 * the build checks on an app except the two things only its code can tell it.
 */
interface AppText {
  slug: string;
  dir: string;
  /** `app.json` as parsed, before `widgets.ts` adds anything to it. */
  raw: Record<string, unknown>;
  /**
   * The registry entry, less what only the code can say: `routes` is empty,
   * and each widget carries only the config `app.json` declares.
   */
  manifest: AppManifest;
  /** Every `route.ts`, found and not imported. */
  routeFiles: RouteFile[];
  /** Whether a `widgets.ts` will add config fields once the code is loaded. */
  hasWidgetsTs: boolean;
}

/** The registry's widget entries for a parsed manifest's `widgets`. */
function buildWidgets(widgets: RawApp["widgets"]): AppManifest["widgets"] {
  return (widgets ?? []).map((w) => {
    const component = w.component;
    const filename = path.basename(component, path.extname(component));
    return {
      ...w,
      id: filename,
      component,
      defaultSize: w.defaultSize ?? { w: 4, h: 3 },
    };
  });
}

/** One containment finding as a line of a verdict, naming its file. */
function findingProblem(slug: string, f: ContainmentFinding): string {
  return `apps/${slug}/${f.file}${f.line > 0 ? `:${f.line}` : ""} — ${f.what ? `${f.what} ${f.why}` : f.why}`;
}

/**
 * Every check on one app that reads its files and runs none of its code, in
 * the order the build runs them, ending in its registry entry less what only
 * the code can say. A build runs this and then loadAppCode(); an install's
 * `--check` runs this on the staged copy, then reads its routes' source in
 * place of loadAppCode() (checkStagedApp()).
 *
 * `slug` is the folder's name, and messages name files where they will live,
 * as apps/<slug>/…, whichever folder is being read. The containment scan and
 * reading `app.json` come first, in scanApps() and checkStagedApp(), because
 * each reports its findings its own way.
 *
 * Throws what the build always has: FatalManifestError for a manifest that is
 * wrong, AppRejectedError for code that does what an app may not.
 */
async function readAppText(
  appDir: string,
  slug: string,
  raw: Record<string, unknown>,
): Promise<AppText> {
  // The folder name is the slug, and it names the app's schema and role
  // (src/lib/apps/app-identifiers.ts), its URLs and its hooks. A slug that
  // could not name a schema unambiguously never gets as far as having one.
  const slugProblem = appSlugProblem(slug);
  if (slugProblem) {
    throw new FatalManifestError(`apps/${slug}: ${slugProblem}`);
  }
  // A platform page's path wins over an app's, so an app under a reserved slug
  // could never be opened.
  const reserved = reservedAppSlugProblem(slug);
  if (reserved) {
    throw new FatalManifestError(`apps/${slug}: ${reserved}`);
  }

  const pagesDir = path.join(appDir, "pages");
  const hasPages =
    fs.existsSync(pagesDir) && fs.readdirSync(pagesDir).length > 0;
  // Zero is possible while `hasPages` is true — a `pages/` directory
  // holding only a component with no `Main.tsx` beside it serves nothing.
  const pageCount = hasPages ? countPages(pagesDir) : 0;

  // Schema-validate the on-disk manifest: types, required fields, unknown
  // keys, and the defaultRole↔roles cross-check. A violation aborts the
  // whole build (FatalManifestError) — a malformed manifest is a developer
  // error that must fail loudly, not silently drop the app. Config fields a
  // `widgets.ts` adds are held to the same schema in loadAppCode(). Its
  // `$schema` first, so a manifest of another shape is told that, not every
  // field that doesn't fit.
  const appShape = schemaProblem("app", (raw as { $schema?: unknown } | null)?.$schema, `apps/${slug}/app.json`);
  if (appShape) throw new FatalManifestError(appShape);
  const parsed = RawAppManifestSchema.safeParse(raw);
  if (!parsed.success) {
    throw new FatalManifestError(
      `apps/${slug}/app.json failed validation:\n${formatZodError(parsed.error)}`,
    );
  }
  const r = parsed.data;

  // Named after its registryId, so no two apps on an instance share a slug,
  // and so a schema, a role or a URL.
  const appId = registryIdProblem("app", `apps/${slug}/app.json`, r.registryId, slug);
  if (appId) throw new FatalManifestError(appId);

  // A remix comes from another installed app (docs/apps/remix.md). An entry
  // naming this app as its own source records something that didn't happen.
  for (const [i, entry] of (r.remixedFrom ?? []).entries()) {
    if (entry.source.app === slug) {
      throw new FatalManifestError(
        `apps/${slug}/app.json: remixedFrom.${i}.source.app is "${slug}", this app itself — a remix is taken from another app.`,
      );
    }
  }

  // Its release notes. main() reads them again for every app it accepts;
  // checked here as well, so an install's --check refuses a bad file.
  readReleaseNotes(appDir, `apps/${slug}/${RELEASE_NOTES_FILE}`);

  // Schema validates the visibility *values*; this additionally verifies
  // each key resolves to a real file on disk.
  const pageVisibility = validatePageVisibility(r.pageVisibility, slug, appDir);

  // Schema validates the schedule shape; this verifies each job name
  // resolves to a real handler file on disk.
  const schedules = validateSchedules(r.schedules, slug, appDir);

  // Every api/**/route.ts, found and not yet imported: loadAppCode() imports
  // each one and reads its contract.
  const routeFiles = findRouteFiles(appDir, slug);

  // What the code fires and listens to, held to the app's own namespace and
  // its `listensTo`. A finding skips this app, as a containment finding
  // does. validateHookWiring, in validateAppsTogether(), holds each
  // `listensTo` to the emitter's `consumers`, and a mismatch there still
  // aborts the run.
  const hookScan = scanHooks(appDir, slug);
  const hookFindings = checkHookNamespaces(
    slug,
    hookScan.calls,
    r.listensTo ?? [],
  );
  if (hookFindings.length > 0) {
    throw new AppRejectedError(
      `its hook calls break the cross-app hook rules:${formatHookFindings(hookFindings)}`,
      hookFindings.map((f) => `apps/${slug}/${f.file}:${f.line} — ${f.why}`),
    );
  }

  const updatedAt = await validateAppDatabase(r, slug, appDir);

  const manifest: AppManifest = {
    slug,
    name: r.name,
    description: r.description ?? "",
    tagline: r.tagline ?? null,
    icon: r.icon ?? "box",
    connectors: connectorEntryNames(r.connectors),
    optionalConnectors: connectorEntryNames(r.optionalConnectors),
    connectorRequirements: connectorRequirements(r.connectors, r.optionalConnectors),
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
    screenshots: validateScreenshots(r.screenshots, "apps", slug, appDir),
    license: r.license ?? null,
    appUrl: r.appUrl ?? null,
    appSupportUrl: r.appSupportUrl ?? null,
    lastUpdated: parseLastUpdated(raw.lastUpdated),
    widgets: buildWidgets(r.widgets),
    schedules,
    sync: validateSyncs(r.sync, slug, appDir, [
      ...connectorEntryNames(r.connectors),
      ...connectorEntryNames(r.optionalConnectors),
    ]),
    emits: r.emits ?? [],
    listensTo: r.listensTo ?? [],
    branding: validateAppBranding(r.branding, slug, appDir),
    escapes: validateEscapes(r.escapes, slug),
    env: validateEnv(r.env, slug),
    egress: r.egress ?? [],
    // Read off the code, in loadAppCode().
    routes: [],
    telemetry: validateAppTelemetry(r.telemetry, slug),
    provides: validateProvides(r.provides, slug, appDir),
    consumes: normalizeConsumes(r.consumes),
    mcp: validateMcpTools(r.mcp, slug, appDir, [
      ...connectorEntryNames(r.connectors),
      ...connectorEntryNames(r.optionalConnectors),
    ]),
    ...(pageVisibility ? { pageVisibility } : {}),
  };

  const unscanned = unscannedEntryPoints(appDir, manifest);
  if (unscanned.length > 0) {
    throw new AppRejectedError(
      `the platform would load ${unscanned.join(", ")}, which the containment scan does not read: ` +
        `code in a dot-directory, in assets/, plans/, migrations/ or screenshots/, or outside the app. ` +
        `Move it beside the rest of the app's source.`,
      unscanned.map(
        (rel) =>
          `apps/${slug}/${rel}: the platform would load it, but the containment scan does not read it ` +
          `(code in a dot-directory, in assets/, plans/, migrations/ or screenshots/, or outside the app). ` +
          `Move it beside the rest of the app's source.`,
      ),
    );
  }

  return {
    slug,
    dir: appDir,
    raw,
    manifest,
    routeFiles,
    hasWidgetsTs: fs.existsSync(path.join(appDir, "widgets.ts")),
  };
}

/**
 * The checks only the app's code can answer, once readAppText() has passed:
 * the config fields `widgets.ts` builds, and every route's contract. This is
 * the first point at which a build runs any of an app's code, and an install's
 * `--check` never reaches it.
 */
async function loadAppCode(app: AppText): Promise<AppManifest> {
  const { slug, dir } = app;

  let widgets = app.manifest.widgets;
  if (app.hasWidgetsTs) {
    // A copy, so what readAppText() read stays as it read it.
    const merged = structuredClone(app.raw);
    await applyWidgetConfigs(dir, merged);
    // The config fields widgets.ts supplied are held to the schema too.
    const parsed = RawAppManifestSchema.safeParse(merged);
    if (!parsed.success) {
      throw new FatalManifestError(
        `apps/${slug}/app.json failed validation:\n${formatZodError(parsed.error)}`,
      );
    }
    widgets = buildWidgets(parsed.data.widgets);
  }

  // Import every api/**/route.ts and hoist its declared contract. This is
  // also where a bare `export async function GET` fails the build.
  const routes = await importRouteContracts(slug, app.routeFiles);
  validateRouteContracts(routes, slug, app.manifest.roles);

  // The one remaining escape is load-bearing: a route that owns its own
  // Response registers only when the manifest says so, with a reason, where
  // a reviewer and the admin dialog can see it.
  const rawRoutes = routes.flatMap((route) =>
    route.methods
      .filter((m) => m.raw)
      .map((m) => ({ routePath: route.path, method: m.method })),
  );
  const refusal = rawResponseRefusal(slug, rawRoutes, app.manifest.escapes);
  if (refusal) throw new AppRejectedError(refusal.message, refusal.problems);
  if (rawRoutes.length === 0 && declaresRawResponse(app.manifest.escapes)) {
    // Not a refusal — the declaration costs nothing — but a stale one tells
    // a reviewer something about the app that is no longer true.
    console.warn(
      `    apps/${slug}/app.json declares the raw-response escape, but no route sets \`raw: true\`. Remove it.`,
    );
  }

  return { ...app.manifest, widgets, routes };
}

/** Publish what an accepted app ships for unauthenticated pages: screenshots and brand marks. */
function emitAppFiles(manifest: AppManifest, appDir: string): void {
  copyScreenshots(manifest.screenshots, "apps", manifest.slug, appDir);
  copyBrandLogos(manifest.branding, manifest.slug, appDir);
}

/**
 * The checks that span apps, over every app registered together: App
 * Services' two-sided consent, the same for hooks, and no two apps sharing a
 * schema or a role. Each failure aborts the run.
 */
function validateAppsTogether(manifests: AppManifest[]): void {
  // App Services two-sided consent: every consumes ↔ provides pair must agree.
  validateServiceWiring(manifests);
  validateHookWiring(manifests);

  // No two apps may share a schema or a role. With valid slugs the encoding
  // cannot produce a clash; this is what would catch a change that let one.
  const clashes = appIdentifierProblems(manifests.filter((m) => m.database).map((m) => m.slug));
  if (clashes.length > 0) throw new FatalManifestError(clashes.join("\n"));
}

async function scanApps(
  appsDir: string = APPS_DIR,
  { emit = true }: { emit?: boolean } = {},
): Promise<AppManifest[]> {
  if (!fs.existsSync(appsDir)) {
    fs.mkdirSync(appsDir, { recursive: true });
  }

  const entries = fs.readdirSync(appsDir, { withFileTypes: true });
  const manifests: AppManifest[] = [];

  for (const entry of entries) {
    // Not templates, and nothing dot-prefixed (see isExtensionFolder).
    if (!isExtensionFolder(entry)) continue;

    const appDir = path.join(appsDir, entry.name);

    // Its name before its code: read from app.json, which imports nothing.
    const misnamed = appFolderNameProblem(appDir, entry.name);
    if (misnamed) throw new FatalManifestError(misnamed);

    // Containment runs FIRST, before anything imports the app's code:
    // loadAppCode() imports widgets.ts and every route.ts, and an import runs
    // the module's top level. A finding skips the app rather than aborting
    // the run. An install never gets this far with such an app: its `--check`
    // runs this same scan on the staged copy and rejects it before it is put
    // in place (checkExtension() in src/lib/repository/install.ts). See
    // scripts/app-containment.ts.
    const findings = scanAppContainment(appDir);
    if (findings.length > 0) {
      console.warn(
        `  Skipping ${entry.name}/ — its code reaches what an app may not:${formatFindings(findings)}`,
      );
      continue;
    }

    let raw: Record<string, unknown> | null;
    try {
      raw = readAppJson(appDir);
    } catch (err) {
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
      // Every check that reads text, then the two that need the code.
      const manifest = await loadAppCode(await readAppText(appDir, entry.name, raw));

      if (emit) emitAppFiles(manifest, appDir);

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

  validateAppsTogether(manifests);
  return manifests;
}

interface ConnectorManifestOut {
  name: string;
  displayName: string;
  version: string;
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

/**
 * Every check on one connector, and its registry entry. All of them read text
 * (the generator never imports a connector's code), and nothing is written, so
 * an install's `--check` runs this on the staged copy as it is.
 */
function readConnector(connectorDir: string, name: string): ConnectorManifestOut {
  const manifestPath = path.join(connectorDir, "connector.json");
  const rawJson = JSON.parse(fs.readFileSync(manifestPath, "utf-8"));

  // Schema-validate the manifest shape (types, required fields, unknown
  // keys, credential-field types). Hard-fails the build on any violation.
  // Its `$schema` first, so a manifest of another shape is told that.
  const connectorShape = schemaProblem("connector", rawJson?.$schema, "connector.json");
  if (connectorShape) throw new Error(connectorShape);
  const parsed = RawConnectorManifestSchema.safeParse(rawJson);
  if (!parsed.success) {
    throw new Error(
      `connector.json failed validation:\n${formatZodError(parsed.error)}`,
    );
  }
  const raw = parsed.data;

  // Named after its registryId, which is also the name apps reach it by
  // (invariant 1), so no two connectors share one.
  // As this function's other messages are: the scan and the install check say
  // which connector before it.
  const connectorId = registryIdProblem("connector", "connector.json", raw.registryId, name);
  if (connectorId) throw new Error(connectorId);

  // Icon: proven to exist, and to be a square >= 512x512 PNG/WebP or an SVG
  // with a viewBox, before anything references it, then copied out with the
  // rest of the connector's assets.
  // The registry contract first: a missing icon and a missing setup guide
  // are one report, not a build each.
  validateRegistryContract(name, raw);
  if (raw.icon) validateConnectorIcon(raw.icon, name, connectorDir);
  // Completeness of the capability list, which the Access tab presents as
  // exhaustive. Runs before the manifest is emitted so a gap cannot ship.
  validateConnectorMethods(
    name,
    connectorDir,
    validateConnectorTelemetry(raw.telemetry, name),
  );
  // Read again by main() for what it accepts; checked here for --check too.
  readReleaseNotes(connectorDir, RELEASE_NOTES_FILE);

  return {
    name,
    displayName: raw.displayName,
    version: raw.version,
    // Stored as the URL the browser will request, not the authoring path,
    // so no call site has to know where assets get copied to.
    ...(raw.icon
      ? {
          // `assets/` is where the file lives in the repo; the copy lands
          // directly under the connector's public directory, so strip it.
          icon: `/connector-assets/${name}/${raw.icon.replace(/^assets\//, "")}`,
        }
      : {}),
    ...(raw.userScoped ? { userScoped: true } : {}),
    description: raw.description ?? "",
    ...(raw.setup ? { setup: raw.setup as ConnectorSetupGuide } : {}),
    credentialFields: raw.credentialFields ?? [],
    authors: normalizeAuthors(raw.authors),
    lastUpdated: parseLastUpdated(raw.lastUpdated),
    telemetry: validateConnectorTelemetry(raw.telemetry, name),
    // Declarative transport/auth policy. Omitted keys stay omitted so the
    // runtime defaults in HttpConnector apply rather than being baked in
    // here — the registry records what was declared, not what was assumed.
    ...(raw.auth ? { auth: raw.auth as ConnectorAuthPolicy } : {}),
    ...(raw.http ? { http: raw.http as ConnectorHttpPolicy } : {}),
    ...(raw.webhook
      ? { webhook: raw.webhook as ConnectorWebhookPolicy }
      : {}),
  };
}

async function scanConnectors(
  connectorsDir: string = CONNECTORS_DIR,
  { emit = true }: { emit?: boolean } = {},
): Promise<ConnectorManifestOut[]> {
  if (!fs.existsSync(connectorsDir)) {
    fs.mkdirSync(connectorsDir, { recursive: true });
    return [];
  }

  const entries = fs.readdirSync(connectorsDir, { withFileTypes: true });
  const connectors: ConnectorManifestOut[] = [];

  for (const entry of entries) {
    // Not templates, and nothing dot-prefixed (see isExtensionFolder).
    if (!isExtensionFolder(entry)) continue;

    const connectorDir = path.join(connectorsDir, entry.name);
    if (!fs.existsSync(path.join(connectorDir, "connector.json"))) continue;

    try {
      const manifest = readConnector(connectorDir, entry.name);
      if (emit) copyAssets(path.join(connectorDir, "assets"), "connector-assets", entry.name);

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

/**
 * Each app's connector entries, held to the connectors in this checkout.
 *
 * An entry names the connector version the app was built against, and the
 * connector here must be the same major version and at least that release:
 * within a major version a connector only adds, so a later 1.x still has
 * everything a 1.2.0 app calls, and 2.0.0 may not. An entry asking for
 * "write" must name a connector that declares a method changing data, or it
 * would grant something nobody could see the use of.
 *
 * A connector that isn't in this checkout is not checked: the activation gate
 * refuses an app whose required connector is missing, as it always has, and
 * an optional one is simply absent.
 */
function connectorRequirementProblems(
  apps: readonly Pick<AppManifest, "slug" | "connectorRequirements">[],
  connectors: readonly Pick<ConnectorManifestOut, "name" | "version" | "telemetry">[],
): string[] {
  const byName = new Map(connectors.map((c) => [c.name, c]));
  const problems: string[] = [];
  for (const app of apps) {
    for (const need of app.connectorRequirements) {
      const connector = byName.get(need.name);
      if (!connector) continue;
      if (!satisfiesConnectorVersion(need.version, connector.version)) {
        const newerMajor = Number(connector.version.split(".")[0]) > Number(need.version.split(".")[0]);
        problems.push(
          `apps/${app.slug}/app.json was built against ${need.name} ${describeConnectorVersion(need.version)}, ` +
            `and connectors/${need.name} is ${connector.version}.\n  ` +
            (newerMajor
              ? `${connector.version} is a new major version, which may remove or change what the app calls. ` +
                `Check the app against it, then name ${connector.version} in its entry.`
              : `Update ${need.name} to ${need.version} or later first.`),
        );
      }
      if (need.access === "write" && !connector.telemetry.some((t) => t.mutates)) {
        problems.push(
          `apps/${app.slug}/app.json asks to change data in ${need.name}, which declares no method ` +
            `that changes anything.\n  Leave "access" out: the app only reads.`,
        );
      }
    }
  }
  return problems;
}

function validateConnectorRequirements(
  apps: readonly AppManifest[],
  connectors: readonly ConnectorManifestOut[],
): void {
  const problems = connectorRequirementProblems(apps, connectors);
  if (problems.length > 0) throw new Error(problems.join("\n"));
}

/* -------------------------------------------------------------------------- */
/*  Installs from a Registry                                                  */
/* -------------------------------------------------------------------------- */

/** One extension this run accepted, and where its folder is. */
interface AcceptedExtension {
  kind: RegistryInstall["kind"];
  slug: string;
  dir: string;
}

/** Files macOS Finder writes into any folder it shows. */
const FINDER_FILE = ".DS_Store";

/**
 * The extensions this build accepted that were installed from a Registry, from
 * the install record, `.registry.json`, at the root of each one's folder
 * (src/lib/repository/install-record.ts). Every kind, in kind then slug order.
 *
 * A folder with no record is a local extension, and isn't listed. Neither is
 * one whose record can't be read or names another kind or slug: that is a
 * warning, and the extension is built and loaded as a local one. So is a
 * record from a catalogue other than mixos.org, which is for development.
 *
 * Each listed folder's files are hashed again, the record left out, and
 * compared with the record's `filesHash`: `modified` is true when they differ,
 * because the folder was edited after it was installed.
 *
 * Returns the warnings rather than printing them, for its tests. Exported for
 * them; main() is the caller.
 */
function scanRegistryInstalls(extensions: readonly AcceptedExtension[]): {
  installs: RegistryInstall[];
  warnings: string[];
} {
  const installs: RegistryInstall[] = [];
  const warnings: string[] = [];
  const order = { app: 0, connector: 1, theme: 2 } as const;
  const sorted = [...extensions].sort((a, b) => order[a.kind] - order[b.kind] || a.slug.localeCompare(b.slug));

  for (const { kind, slug, dir } of sorted) {
    const folder = `${kind === "app" ? "apps" : kind === "connector" ? "connectors" : "themes"}/${slug}`;
    const file = `${folder}/${INSTALL_RECORD_FILE}`;
    const read = readInstallRecord(dir);
    if (read.state === "missing") continue;
    if (read.state === "invalid") {
      warnings.push(`${file} can't be read (${read.reason}), so ${folder}/ is treated as a local extension.`);
      continue;
    }
    const mismatch = recordMismatch(read.record, kind, slug);
    if (mismatch) {
      warnings.push(`${file} isn't this folder's: ${mismatch}. ${folder}/ is treated as a local extension.`);
      continue;
    }
    const record = read.record;

    let modified: boolean;
    try {
      modified = folderFilesHash(dir) !== record.filesHash;
    } catch (err) {
      // A link, or anything else install never writes: the folder has changed.
      if (!(err instanceof FolderReadError)) throw err;
      modified = true;
    }
    if (modified) {
      const from = `${record.version} from ${sourceHost(record.source)}`;
      warnings.push(
        finderFilesOnly(dir, record.filesHash)
          ? `${folder}/ differs from its ${INSTALL_RECORD_FILE} only by ${FINDER_FILE} files, which macOS Finder ` +
              `writes, so it counts as modified locally. Delete them to clear it: ` +
              `find ${folder} -name ${FINDER_FILE} -delete`
          : `${folder}/ no longer matches its ${INSTALL_RECORD_FILE}: its files changed after ${from} was installed. ` +
              `It counts as modified locally.`,
      );
    }
    if (record.source !== DEFAULT_REPOSITORY_URL) {
      warnings.push(
        `${folder}/ was installed from ${record.source}, not ${DEFAULT_REPOSITORY_URL}. Another catalogue is ` +
          `for development: install it from mixos.org before you ship it.`,
      );
    }

    installs.push({
      kind,
      slug,
      version: record.version,
      gitTag: record.gitTag,
      commitSha: record.commitSha,
      source: record.source,
      repository: record.repository,
      requiresMixOS: record.requiresMixOS,
      modified,
    });
  }
  return { installs, warnings };
}

/** Whether `dir` would match `filesHash` but for the Finder files in it. */
function finderFilesOnly(dir: string, filesHash: string): boolean {
  const finder: string[] = [];
  const walk = (at: string) => {
    for (const entry of fs.readdirSync(at, { withFileTypes: true })) {
      const full = path.join(at, entry.name);
      if (entry.isDirectory()) walk(full);
      else if (entry.name === FINDER_FILE) finder.push(full);
    }
  };
  try {
    walk(dir);
    if (finder.length === 0) return false;
    return folderFilesHash(dir, (full) => finder.includes(full)) === filesHash;
  } catch {
    return false;
  }
}

/** Write `src/generated/registry-installs.ts`, which every deployment reads. Written even when empty. */
function writeRegistryInstalls(installs: readonly RegistryInstall[]): void {
  fs.writeFileSync(
    REGISTRY_INSTALLS_FILE,
    `// AUTO-GENERATED by scripts/generate-project-registry.ts — do not edit
//
// The extensions in this build installed from a Registry, from the install
// record, .registry.json, in each one's folder (src/lib/repository/install-record.ts).
// A folder with no record, or with one that isn't its own, is local and isn't
// listed. "modified" is true when its files no longer match its record.
import type { RegistryInstall } from "@/lib/repository/install-record";

export const registryInstalls: RegistryInstall[] = ${JSON.stringify(installs, null, 2)};
`,
    "utf-8",
  );
}

/**
 * Write `src/generated/extension-renames.ts`: the rename ledger, checked, for
 * the release step (scripts/sync-renames.ts). Written even when empty.
 */
function writeExtensionRenames(renames: readonly ExtensionRename[]): void {
  fs.writeFileSync(
    EXTENSION_RENAMES_FILE,
    `// AUTO-GENERATED by scripts/generate-project-registry.ts — do not edit
//
// The extensions renamed in this checkout, oldest first, from the rename ledger,
// extension-renames.json at its root (scripts/extension-renames.ts). The release
// step moves what each instance keeps under an old slug to the new one
// (scripts/sync-renames.ts).
import type { ExtensionRename } from "../../scripts/extension-renames";

export const extensionRenames: readonly ExtensionRename[] = ${JSON.stringify(renames, null, 2)};
`,
    "utf-8",
  );
}

/**
 * Every release note this build carries: MixOS's own, from release-notes.json
 * at the root, and each accepted extension's, from beside its manifest
 * (scripts/release-notes.ts). readAppText(), readConnector() and readTheme()
 * have checked each extension's already, so an install's `--check` refuses a
 * bad file too; this reads them again for what the scan accepted.
 *
 * Newest first. On one day: MixOS, then apps, connectors and themes, each by
 * slug, and each file's own order.
 */
function collectReleaseNotes(
  apps: readonly AppManifest[],
  connectors: readonly ConnectorManifestOut[],
  themes: readonly ThemeManifest[],
): ReleaseNote[] {
  const notes = [
    ...releaseNotesOf("core", CORE_SLUG, CORE_DIR, RELEASE_NOTES_FILE),
    ...apps.flatMap((a) =>
      releaseNotesOf("app", a.slug, path.join(APPS_DIR, a.slug), `apps/${a.slug}/${RELEASE_NOTES_FILE}`),
    ),
    ...connectors.flatMap((c) =>
      releaseNotesOf(
        "connector",
        c.name,
        path.join(CONNECTORS_DIR, c.name),
        `connectors/${c.name}/${RELEASE_NOTES_FILE}`,
      ),
    ),
    ...themes.flatMap((t) =>
      releaseNotesOf("theme", t.slug, path.join(THEMES_DIR, t.slug), `themes/${t.slug}/${RELEASE_NOTES_FILE}`),
    ),
  ];
  const kind = (note: ReleaseNote) => RELEASE_NOTE_KINDS.indexOf(note.kind);
  // A stable sort, so notes of one extension on one day keep their order.
  return notes.sort(
    (a, b) => b.date.localeCompare(a.date) || kind(a) - kind(b) || a.slug.localeCompare(b.slug),
  );
}

/**
 * Write `src/generated/release-notes.ts`. Server only: a person's notes reach
 * the browser through a server action, not this whole list. Written even when
 * empty.
 */
function writeReleaseNotes(notes: readonly ReleaseNote[]): void {
  fs.writeFileSync(
    RELEASE_NOTES_OUTPUT_FILE,
    `// AUTO-GENERATED by scripts/generate-project-registry.ts — do not edit
//
// SERVER ONLY. Every release note in this build, newest first: MixOS's own,
// from release-notes.json at the root, and each accepted extension's, from
// beside its manifest. A person's share reaches the browser through
// src/lib/release-notes/actions.ts, never this whole list.
import type { ReleaseNote } from "@/lib/release-notes/types";

export const releaseNotes: ReleaseNote[] = ${JSON.stringify(notes, null, 2)};
`,
    "utf-8",
  );
}

/**
 * Write `src/generated/remix-index.ts`: every registered app's `remixedFrom`
 * entries, each with its keywords normalized as mixos.org will count them. The
 * admin app dialog reads it for "Remixed from" and "Remixed into". Written even
 * when empty. The manifests were validated a moment ago by readAppText(), so a
 * parse here can only fail on a file that changed during the run.
 */
function writeRemixIndex(apps: readonly AppManifest[]): number {
  const index: RemixIndexEntry[] = [];
  for (const app of apps) {
    const raw = readAppJson(path.join(APPS_DIR, app.slug));
    const entries = z.array(RemixEntrySchema).parse(raw?.remixedFrom ?? []);
    for (const entry of entries) {
      index.push({ app: app.slug, entry, keywords: normalizeRemixKeywords(entry.keywords) });
    }
  }
  fs.writeFileSync(
    REMIX_INDEX_FILE,
    `// AUTO-GENERATED by scripts/generate-project-registry.ts — do not edit
//
// Every remix recorded by an app in this build: its app.json's \`remixedFrom\`
// entries, with keywords normalized as mixos.org counts them. See
// docs/apps/remix.md and src/lib/apps/remix.ts.
import type { RemixIndexEntry } from "@/lib/apps/remix";

export const remixIndex: RemixIndexEntry[] = ${JSON.stringify(index, null, 2)};
`,
    "utf-8",
  );
  return index.length;
}

/**
 * Each install's `requiresMixOS`, from its record, against the version this
 * build stamps (D15 in docs/plans/20261008_2300-extension-lifecycle.md).
 * `error` names every extension whose floor is above it, and main() fails the
 * build with it: leaving the extension out instead would drop it from that
 * deploy without a word.
 *
 * Install and Register compare a floor the same way (checkFloor() in
 * src/lib/platform/version-floor.ts): `X.Y.Z` compared numerically, `X` and
 * `X.Y` read as `X.0.0` and `X.Y.0`, a leading `v`, `>=`, `~` or `^` ignored,
 * and a pre-release or build suffix dropped. A floor that doesn't read as a
 * version isn't enforced there, with a reason logged, so here it is a
 * warning. A local extension has no record, so scanRegistryInstalls() doesn't
 * list it, and it is never checked.
 *
 * The version is package.json's, so a checkout of unreleased work that bumps
 * it locally builds an extension whose floor is the coming release.
 *
 * Exported for its tests; main() is the caller.
 */
function checkInstalledFloors(
  installs: readonly RegistryInstall[],
  version: string,
): { error: string | null; warnings: string[] } {
  const unmet: string[] = [];
  const warnings: string[] = [];
  for (const install of installs) {
    const file = `${KIND_SEGMENT[install.kind]}/${install.slug}/${INSTALL_RECORD_FILE}`;
    const check = checkFloor(install.requiresMixOS, version);
    if (!check.allowed) {
      unmet.push(`  ${file}: release ${install.version} requires MixOS ${install.requiresMixOS} or newer.`);
    } else if (check.reason) {
      warnings.push(`${file}: requiresMixOS "${install.requiresMixOS}" isn't a version, so it isn't checked, here or at install.`);
    }
  }
  if (unmet.length === 0) return { error: null, warnings };
  const one = unmet.length === 1;
  return {
    error:
      `This build is MixOS ${version}, and ${one ? "an extension" : `${unmet.length} extensions`} installed ` +
      `from a Registry need${one ? "s" : ""} a newer one:\n` +
      `${unmet.join("\n")}\n` +
      `Upgrade MixOS, or install an older release of ${one ? "it" : "each"} that runs on ${version}. ` +
      `The build stops rather than leave ${one ? "it" : "them"} out of this deploy.`,
    warnings,
  };
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
 * The files are listed as the runner lists them
 * (scripts/platform-migration-files.ts), so the build expects only a number
 * whose file the runner applies. Two files with one number fail the build: the
 * ledger would record that number for one of them, and the runner would skip
 * the other as already applied.
 */
function expectedSchemaVersion(): number {
  if (!fs.existsSync(MIGRATIONS_DIR)) return 0;
  const numbers = listPlatformMigrations(MIGRATIONS_DIR).map((m) => Number(m.version));
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
 * This checkout's MixOS version: `package.json`'s, the one place it lives.
 *
 * Refused here unless it is `X.Y.Z` (with an optional pre-release or build
 * suffix), so a build never carries a version that extensions' `requiresMixOS`
 * floors cannot be compared against (src/lib/platform/version.ts).
 */
function packageVersion(): string {
  const pkg = JSON.parse(fs.readFileSync(PACKAGE_JSON_FILE, "utf-8")) as { version?: unknown };
  const version = typeof pkg.version === "string" ? pkg.version.trim() : "";
  if (!/^\d+\.\d+\.\d+(?:-[0-9A-Za-z.-]+)?(?:\+[0-9A-Za-z.-]+)?$/.test(version)) {
    throw new Error(
      `package.json's "version" must be X.Y.Z, optionally with a pre-release suffix ` +
        `(found ${JSON.stringify(pkg.version)}). It is the MixOS version this build ` +
        `reports, and the one extensions' requiresMixOS floors are compared against.`,
    );
  }
  return version;
}

/**
 * The build-time facts the running server cannot work out for itself.
 *
 * The version comes from `package.json`, and is stamped on every build: every
 * host runs this generator before compiling, and `package.json` is in every
 * build context, so a checkout and every kind of deployment know their version
 * the same way. There is no runtime variable for it, so nothing can disagree.
 *
 * The schema version is derived from `supabase/migrations/`, and that directory
 * is not copied into the runner image at all, so the number has to travel with
 * the build or not exist.
 *
 * So is the list of app migrations the readiness probe waits for. `apps/` is in
 * the Docker image, but a serverless function sees a repository file only if
 * output tracing put it there; a list compiled into the server needs neither.
 *
 * NOTE: no timestamp and no commit here. Every value in this file is stable for
 * a given checkout, so re-running the generator rewrites an identical file and
 * the dev server has nothing to recompile. A timestamp — or a git SHA, which
 * moves on every commit — would invalidate that on every `predev`. The commit
 * is read at runtime instead (`mixosCommit` in src/lib/platform/version.ts).
 *
 * Returns the version it stamped, which installs' floors are checked against.
 */
function writeBuildInfo(apps: readonly AppManifest[], report = true): string {
  const version = packageVersion();
  const schema = expectedSchemaVersion();
  const appMigrations = expectedAppMigrations(apps);

  const output = `// AUTO-GENERATED by scripts/generate-project-registry.ts — do not edit
//
// Derived from package.json, supabase/migrations/ and apps/*/migrations/ at
// build time, so the running server knows what it was built from without
// reading any of them. See src/lib/platform/version.ts for the version and the
// commit, and src/lib/platform/schema-version.ts and
// src/lib/platform/app-migrations.ts for what the migrations gate.

/** This build's MixOS version: package.json's \`version\`. */
export const MIXOS_VERSION = ${JSON.stringify(version)};

/** Highest migration number in supabase/migrations/ at build time. */
export const EXPECTED_SCHEMA_VERSION = ${schema};

/** Every app migration the release step runs, at build time. */
export const EXPECTED_APP_MIGRATIONS: readonly { slug: string; file: string }[] = ${JSON.stringify(appMigrations, null, 2)};
`;

  fs.writeFileSync(BUILD_INFO_FILE, output, "utf-8");
  if (report) {
    console.log(
      `Build stamp: MixOS ${version}, expected schema version ${schema}, ` +
        `${appMigrations.length} app migration(s)`,
    );
  }
  return version;
}

async function main() {
  if (!fs.existsSync(OUTPUT_DIR)) {
    fs.mkdirSync(OUTPUT_DIR, { recursive: true });
  }
  // What earlier runs copied into public/, which this one prunes at its end.
  const copies = new PublicCopies(PUBLIC_DIR, PUBLIC_COPIES_FILE);
  publicCopies = copies;

  // The stamp lists only the migrations of apps the scan accepts, so it is
  // written after the scan. A fresh checkout still gets one first, in case a
  // module the scan imports reads it.
  if (!fs.existsSync(BUILD_INFO_FILE)) writeBuildInfo([], false);

  console.log("Scanning apps...");
  const apps = await scanApps();
  const version = writeBuildInfo(apps);
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
  // This is what types `client.call("GET /items", …)`: its input and output are
  // inferred from the schemas the route actually declared, not asserted by the
  // caller, who could get them wrong silently. It only works because
  // `RouteDefinition` is generic in those two shapes; a non-generic one would
  // erase them at the export boundary.
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
  validateConnectorRequirements(apps, connectors);

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
  // First by name, then id (compareSlugs()), so the choice is deterministic
  // rather than dependent on directory iteration order or on a slug's id.
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

  // Where each accepted extension came from, from its install record.
  console.log("\nReading install records...");
  const { installs, warnings } = scanRegistryInstalls([
    ...apps.map((a) => ({ kind: "app" as const, slug: a.slug, dir: path.join(APPS_DIR, a.slug) })),
    ...connectors.map((c) => ({ kind: "connector" as const, slug: c.name, dir: path.join(CONNECTORS_DIR, c.name) })),
    ...themes.map((t) => ({ kind: "theme" as const, slug: t.slug, dir: path.join(THEMES_DIR, t.slug) })),
  ]);
  for (const warning of warnings) console.warn(`  ${warning}`);
  writeRegistryInstalls(installs);
  console.log(
    `Generated registry installs with ${installs.length} extension(s) installed from a Registry` +
      (installs.some((i) => i.modified) ? `, ${installs.filter((i) => i.modified).length} modified locally` : ""),
  );

  const remixes = writeRemixIndex(apps);
  console.log(`Generated remix index with ${remixes} remix(es)`);

  // The rename ledger, against what this build carries: a slug still here
  // can't have been renamed away (scripts/extension-renames.ts). A rename's
  // new slug may be gone, removed since.
  const renames = readRenames(CORE_DIR);
  const renameIssues = renameProblems(renames, {
    app: apps.map((a) => a.slug),
    connector: connectors.map((c) => c.name),
    theme: themes.map((t) => t.slug),
  });
  if (renameIssues.length > 0) throw new FatalManifestError(renameIssues.join("\n"));
  writeExtensionRenames(renames);
  console.log(`Generated extension renames with ${renames.length} rename(s)`);

  const notes = collectReleaseNotes(apps, connectors, themes);
  writeReleaseNotes(notes);
  console.log(`Generated release notes with ${notes.length} note(s)`);

  // An install that needs a newer MixOS than this build fails it.
  const floors = checkInstalledFloors(installs, version);
  for (const warning of floors.warnings) console.warn(`  ${warning}`);
  if (floors.error) throw new Error(floors.error);

  // Last, once everything else is written: a run that stops before here
  // deletes nothing from public/.
  const pruned = copies.prune();
  if (pruned.length > 0) {
    console.log(`Deleted ${pruned.length} copy(ies) in public/ this build no longer makes: ${pruned.join(", ")}`);
  }
}

/* -------------------------------------------------------------------------- */
/*  An install's check: --check                                               */
/* -------------------------------------------------------------------------- */

/*
  generate-project-registry.ts --check <kind> <dir> --verdict-file <path>

  What an install from the Registry runs on the extension it has staged, before
  anything is put in place (checkExtension() in src/lib/repository/install.ts).
  It treats <dir> as the extension's own folder, with the folder's name as its
  slug, and runs every check that reads text:

   - for an app, readAppText(): the containment scan and the import allowlist,
     `app.json` against its schema, the SQL check on its migrations, and the
     file and text checks;
   - for an app's routes, the `defineRoute` options each `route.ts` writes out,
     read from its source (scripts/route-reader.ts): a bare handler, a role the
     app does not declare and `raw: true` without its escape are refused, by
     the build's own rules and in its words;
   - for a connector or a theme, readConnector() or readTheme(): everything the
     build checks, since none of it runs code;
   - and the checks that span extensions (App Services and hook wiring, schema
     and role clashes, user-scoped connectors in scheduled jobs) over the
     manifests already registered in src/generated/, with this one added. On
     its own, an app that consumes another app's service would fail them.

  What it leaves out is the point of it. It imports none of the extension's
  code, so what only the code can say is listed as deferred, with the reason,
  and checked at registration, which loads it: `widgets.ts`, and any route
  options the reader cannot read as written (built from a variable, a spread,
  a call or another file, say). Registration also loads every route and checks
  the rest of its contract, such as its schemas. The check writes nothing to
  src/generated/ or public/, and does not stamp the build. The install path
  runs it with PATH and TMPDIR as its whole environment (generatorEnv()).

  It writes one verdict, to the named file, which must not exist yet:
  {"verdict":"accepted"|"rejected","problems":[…],"deferred":[…]}. Exit 0 means
  that verdict was written, and any other exit means there is none. What it
  prints is for a person to read: it repeats file names and manifest strings,
  which the extension chooses, so the install path never parses it.

  `--registry-dir <dir>` reads the registered manifests from a directory other
  than src/generated/, for tests.
*/

const CHECK_USAGE =
  "Usage: generate-project-registry.ts --check <app|connector|theme> <dir> " +
  "--verdict-file <absolute path> [--registry-dir <dir>]";

type CheckKind = "app" | "connector" | "theme";

/** What a check found: `problems` empty means accepted. */
interface Judgement {
  problems: string[];
  deferred: string[];
}

/** The manifests registered in src/generated/, as the checks that span extensions need them. */
interface Registered {
  apps: AppManifest[];
  connectors: ConnectorManifestOut[];
}

class CheckUsageError extends Error {}

/** An error as one line of a verdict. */
function errorText(err: unknown): string {
  const text = err instanceof Error ? err.message : String(err);
  return text || "an error with no message";
}

function parseCheckArgs(args: readonly string[]): {
  kind: CheckKind;
  dir: string;
  verdictFile: string;
  registryDir: string;
} {
  const [flag, kind, dir, ...rest] = args;
  if (flag !== "--check" || !kind || !dir) throw new CheckUsageError(CHECK_USAGE);
  if (kind !== "app" && kind !== "connector" && kind !== "theme") {
    throw new CheckUsageError(`"${kind}" is not a kind of extension. ${CHECK_USAGE}`);
  }

  const options = new Map<string, string>();
  for (let i = 0; i < rest.length; i += 2) {
    const [name, value] = [rest[i], rest[i + 1]];
    if ((name !== "--verdict-file" && name !== "--registry-dir") || value === undefined || options.has(name)) {
      throw new CheckUsageError(CHECK_USAGE);
    }
    options.set(name, value);
  }

  const verdictFile = options.get("--verdict-file");
  if (!verdictFile || !path.isAbsolute(verdictFile)) throw new CheckUsageError(CHECK_USAGE);
  return {
    kind,
    dir: path.resolve(dir),
    verdictFile,
    registryDir: path.resolve(options.get("--registry-dir") ?? OUTPUT_DIR),
  };
}

// What the checks that span extensions read from a registered manifest, held
// to its shape so that a registry written by another version of this
// generator is reported as unreadable rather than blamed on the extension.
const consumersSchema = z.union([z.literal("*"), z.array(z.string())]);
const RegisteredAppSchema = z.looseObject({
  slug: z.string().min(1),
  database: z.boolean(),
  connectors: z.array(z.string()),
  optionalConnectors: z.array(z.string()),
  connectorRequirements: z.array(
    z.looseObject({
      name: z.string(),
      optional: z.boolean(),
      access: z.enum(["read", "write"]),
      version: z.string(),
    }),
  ),
  schedules: z.array(z.looseObject({ name: z.string() })),
  sync: z.array(z.looseObject({ name: z.string() })),
  provides: z.array(z.looseObject({ name: z.string(), consumers: consumersSchema })),
  consumes: z.array(z.looseObject({ app: z.string(), service: z.string() })),
  emits: z.array(z.looseObject({ name: z.string(), consumers: consumersSchema })),
  listensTo: z.array(z.looseObject({ app: z.string(), hook: z.string() })),
});
const RegisteredConnectorSchema = z.looseObject({
  name: z.string().min(1),
  version: z.string(),
  userScoped: z.boolean().optional(),
  telemetry: z.array(z.looseObject({ method: z.string(), mutates: z.boolean().optional() })),
});

/**
 * The value a generated registry module gives `name`, read as text: the module
 * is never imported. The generator wrote it with JSON.stringify, so the
 * initializer's text is JSON.
 */
function generatedValue(file: string, name: string): unknown {
  const source = ts.createSourceFile(
    file,
    fs.readFileSync(file, "utf-8"),
    ts.ScriptTarget.Latest,
    true,
  );
  for (const statement of source.statements) {
    if (!ts.isVariableStatement(statement)) continue;
    for (const declaration of statement.declarationList.declarations) {
      if (
        ts.isIdentifier(declaration.name) &&
        declaration.name.text === name &&
        declaration.initializer
      ) {
        return JSON.parse(declaration.initializer.getText(source));
      }
    }
  }
  throw new Error(`it declares no \`${name}\``);
}

/**
 * The apps and connectors registered in `registryDir`, src/generated/ unless a
 * test says otherwise. Throws when either module is missing or unreadable:
 * that is this checkout's problem, and the check then has no verdict to give.
 */
function readRegistered(registryDir: string): Registered {
  function read<T>(file: string, name: string, schema: z.ZodType<T>): T[] {
    const full = path.join(registryDir, file);
    try {
      return z.array(schema).parse(generatedValue(full, name));
    } catch (err) {
      throw new Error(
        `Could not read the registered manifests in ${full}: ${errorText(err)}\n` +
          `Run \`npm run registry\` in this checkout, then try again.`,
      );
    }
  }
  return {
    apps: read("app-registry.ts", "appRegistry", RegisteredAppSchema) as unknown as AppManifest[],
    connectors: read(
      "connector-registry.ts",
      "connectorRegistry",
      RegisteredConnectorSchema,
    ) as unknown as ConnectorManifestOut[],
  };
}

/**
 * The deferred list for an app: what the check would have to import to read.
 * `routes` is what the route reader could not read; `widgets.ts`, whose config
 * fields are built by helpers, is never read.
 */
function appDeferred(app: AppText, routes: readonly string[]): string[] {
  const out: string[] = [];
  if (app.hasWidgetsTs) {
    out.push(
      `apps/${app.slug}/widgets.ts: the widget config fields it builds are checked at registration, which loads it.`,
    );
  }
  return [...out, ...routes];
}

/**
 * One staged app: readAppText(), each route's `defineRoute` options as its
 * source writes them (scripts/route-reader.ts), and the checks across apps,
 * with nothing loaded.
 */
async function checkStagedApp(dir: string, slug: string, registered: Registered): Promise<Judgement> {
  const findings = scanAppContainment(dir);
  if (findings.length > 0) {
    return { problems: findings.map((f) => findingProblem(slug, f)), deferred: [] };
  }

  let raw: Record<string, unknown> | null;
  try {
    raw = readAppJson(dir);
  } catch (err) {
    return { problems: [`apps/${slug}/app.json could not be read: ${errorText(err)}`], deferred: [] };
  }
  if (!raw) return { problems: [`apps/${slug} has no app.json.`], deferred: [] };

  let app: AppText;
  try {
    app = await readAppText(dir, slug, raw);
  } catch (err) {
    const problems =
      err instanceof AppRejectedError
        ? err.problems
        : err instanceof FatalManifestError
          ? [err.message]
          : [`apps/${slug}: invalid manifest: ${errorText(err)}`];
    return { problems, deferred: [] };
  }

  // The three route rules a route's source decides, by the build's own rules
  // and in its words: a bare handler, an undeclared role, `raw: true` without
  // its escape. What the reader cannot read waits for registration.
  const routes = readRoutesStatically(dir, slug, app.routeFiles, app.manifest);
  const deferred = appDeferred(app, routes.deferred);
  if (routes.problems.length > 0) return { problems: routes.problems, deferred };

  // The registered apps, with this one in place of any registered entry of the
  // same slug: what the build would register once it is installed.
  const apps = [...registered.apps.filter((a) => a.slug !== slug), app.manifest];
  try {
    validateAppsTogether(apps);
    validateUserScopedUsage(apps, registered.connectors);
  } catch (err) {
    return { problems: [errorText(err)], deferred };
  }
  // This app's entries only: another app's problem is not this install's.
  const needs = connectorRequirementProblems([app.manifest], registered.connectors);
  if (needs.length > 0) return { problems: needs, deferred };
  return { problems: [], deferred };
}

/** One staged connector: readConnector(), then user-scoped use by the registered apps. */
function checkStagedConnector(dir: string, name: string, registered: Registered): Judgement {
  if (!fs.existsSync(path.join(dir, "connector.json"))) {
    return { problems: [`connectors/${name} has no connector.json.`], deferred: [] };
  }
  let connector: ConnectorManifestOut;
  try {
    connector = readConnector(dir, name);
  } catch (err) {
    return { problems: [`connectors/${name}: ${errorText(err)}`], deferred: [] };
  }
  try {
    validateUserScopedUsage(registered.apps, [
      ...registered.connectors.filter((c) => c.name !== name),
      connector,
    ]);
  } catch (err) {
    return { problems: [errorText(err)], deferred: [] };
  }
  // The installed apps' entries for this connector, against this release: a
  // new major version an app wasn't built against is refused, not installed
  // under it.
  const needs = connectorRequirementProblems(registered.apps, [connector]);
  if (needs.length > 0) return { problems: needs, deferred: [] };
  return { problems: [], deferred: [] };
}

/** One staged theme: readTheme(). A theme stands alone, so nothing spans themes. */
function checkStagedTheme(dir: string, slug: string): Judgement {
  try {
    if (!readTheme(dir, slug)) return { problems: [`themes/${slug} has no theme.json.`], deferred: [] };
  } catch (err) {
    return {
      problems: [
        err instanceof ThemeError || err instanceof FatalManifestError
          ? err.message
          : `themes/${slug}: ${errorText(err)}`,
      ],
      deferred: [],
    };
  }
  return { problems: [], deferred: [] };
}

/**
 * Judge one staged extension, the folder's name as its slug. Imports none of
 * its code and writes nothing.
 */
async function checkStaged(kind: CheckKind, dir: string, registered: Registered): Promise<Judgement> {
  const slug = path.basename(dir);
  switch (kind) {
    case "app":
      return checkStagedApp(dir, slug, registered);
    case "connector":
      return checkStagedConnector(dir, slug, registered);
    case "theme":
      return checkStagedTheme(dir, slug);
  }
}

/**
 * `--check`, from its arguments to its exit code: 0 once the verdict is
 * written, 2 for arguments it cannot use, and 1, by throwing, for a check that
 * could not run. Never writes anything but the verdict file.
 */
async function runCheck(args: readonly string[]): Promise<number> {
  let parsed: ReturnType<typeof parseCheckArgs>;
  try {
    parsed = parseCheckArgs(args);
  } catch (err) {
    console.error(errorText(err));
    return 2;
  }
  const { kind, verdictFile, registryDir } = parsed;

  let dir: string;
  try {
    dir = fs.realpathSync(parsed.dir);
    if (!fs.statSync(dir).isDirectory()) throw new Error("it is not a directory");
  } catch (err) {
    console.error(`Cannot check ${parsed.dir}: ${errorText(err)}`);
    return 2;
  }

  // Whose problem each failure is decides how it is reported. The registered
  // manifests are this checkout's, so failing to read them throws, and the
  // check has no verdict. Everything about the extension itself is a verdict.
  const registered: Registered =
    kind === "theme" ? { apps: [], connectors: [] } : readRegistered(registryDir);

  const label = `${kind === "app" ? "apps" : kind === "connector" ? "connectors" : "themes"}/${path.basename(dir)}`;
  console.log(`Checking ${label} without running any of its code...`);

  const { problems, deferred } = await checkStaged(kind, dir, registered);
  const verdict = buildCheckVerdict(problems, deferred);

  // `wx` refuses a file that already exists, so the verdict the install path
  // reads is the one written here, and there is only one.
  fs.writeFileSync(verdictFile, serializeCheckVerdict(verdict), { flag: "wx", mode: 0o600 });

  if (verdict.verdict === "rejected") {
    console.log(`  Rejected:\n${verdict.problems.map((p) => `    ${p}`).join("\n")}`);
  } else {
    console.log("  Accepted.");
  }
  if (verdict.deferred.length > 0) {
    console.log(`  Checked at registration:\n${verdict.deferred.map((d) => `    ${d}`).join("\n")}`);
  }
  return 0;
}

/* -------------------------------------------------------------------------- */
/*  The full run, under the checkout lock                                     */
/* -------------------------------------------------------------------------- */

/*
  generate-project-registry.ts [--lock-token <token>]

  A full run rewrites src/generated/ and public/ from apps/, connectors/ and
  themes/, which an install, a registration, a discard or a removal in this
  checkout also changes. So it holds the checkout lock, `.mixos/lock`
  (src/lib/platform/checkout-lock.ts), for as long as it runs. While another
  process holds it, a run waits, saying who for, and gives up after
  LOCK_WAIT_MS. A lock whose holder has stopped on this machine is taken over;
  one from another machine, such as a dev container, never is.

  An install or a registration runs the generator while it holds the lock
  itself, and passes its token: `--lock-token <token>`. The run then works under
  its parent's lock, which it checks the file holds, and leaves it for the
  parent to release. A token the lock doesn't hold stops the run before it
  changes anything.

  `--check` (above) writes nothing but its verdict, so it takes no lock: the
  install that runs it holds one.
*/

const ROOT = path.resolve(__dirname, "..");

/** How long a full run waits for another process's checkout lock. */
const LOCK_WAIT_MS = 5 * 60_000;

const FULL_USAGE = "Usage: generate-project-registry.ts [--lock-token <token>]";

const SIGNAL_EXIT: Partial<Record<NodeJS.Signals, number>> = { SIGHUP: 129, SIGINT: 130, SIGTERM: 143 };

/**
 * The full run, from its arguments to its exit code, under the checkout lock.
 * `options` are for tests: another checkout, another run in main()'s place, a
 * shorter wait.
 */
async function runFullGenerator(
  args: readonly string[],
  {
    root = ROOT,
    run = main,
    waitMs = LOCK_WAIT_MS,
    pollMs = 250,
  }: { root?: string; run?: () => Promise<void>; waitMs?: number; pollMs?: number } = {},
): Promise<number> {
  let token: string | null = null;
  if (args.length === 2 && args[0] === "--lock-token" && args[1]) {
    token = args[1];
  } else if (args.length !== 0) {
    // Never a full run on arguments it does not know: a caller that meant
    // `--check` and lost the flag would otherwise rewrite src/generated/.
    console.error(`Unknown arguments: ${args.join(" ")}\n${FULL_USAGE}\n${CHECK_USAGE}`);
    return 2;
  }

  let lock: CheckoutLock;
  try {
    if (token) {
      lock = adoptCheckoutLock(root, token);
    } else {
      lock = await acquireCheckoutLock(root, "the registry generator", {
        waitMs,
        pollMs,
        onWait: (holder) =>
          console.log(
            holder
              ? `Waiting for the checkout lock (.mixos/lock), held by ${describeCheckoutLockHolder(holder)}...`
              : "Waiting for the checkout lock (.mixos/lock), whose file can't be read...",
          ),
      });
      if (lock.tookOver) {
        console.log(
          `Took over the checkout lock from ${describeCheckoutLockHolder(lock.tookOver)}, which had stopped.`,
        );
      }
    }
  } catch (err) {
    if (err instanceof CheckoutLockHeldError) {
      console.error(`${err.message}\nThe registry was not generated.`);
      return 1;
    }
    if (err instanceof CheckoutLockLostError) {
      console.error(
        "--lock-token names a checkout lock this checkout doesn't hold, so the registry was " +
          "not generated. The process that holds the lock passes it; nothing else should.",
      );
      return 1;
    }
    throw err;
  }

  // A run that took the lock itself releases it however it ends, Ctrl-C
  // included. One under its parent's lock leaves it to the parent.
  const signals = token ? [] : (Object.keys(SIGNAL_EXIT) as NodeJS.Signals[]);
  const onSignal = (signal: NodeJS.Signals) => {
    lock.release();
    process.exit(SIGNAL_EXIT[signal] ?? 1);
  };
  for (const signal of signals) process.once(signal, onSignal);
  try {
    await run();
    return 0;
  } catch (err) {
    console.error(err);
    return 1;
  } finally {
    for (const signal of signals) process.removeListener(signal, onSignal);
    lock.release();
  }
}

/*
  Run as a script: the full generator, or an install's check with `--check`.
  Imported, as the tests import it, nothing runs.
*/
if (require.main === module) {
  const args = process.argv.slice(2);
  const exit = (code: number) => {
    process.exitCode = code;
  };
  if (args[0] === "--check") {
    runCheck(args).then(exit, (err) => {
      console.error(err instanceof Error ? err.message : err);
      exit(1);
    });
  } else {
    runFullGenerator(args).then(exit, (err) => {
      console.error(err);
      exit(1);
    });
  }
}

export {
  checkInstalledFloors,
  checkStaged,
  connectorRequirementProblems,
  readRegistered,
  runFullGenerator,
  scanApps,
  scanConnectors,
  scanRegistryInstalls,
  scanThemes,
  type CheckKind,
  type Judgement,
  type Registered,
};
