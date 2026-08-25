import fs from "fs";
import path from "path";
import { pathToFileURL } from "url";
import type {
  AppManifest,
  AppAuthor,
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
} from "../src/lib/apps/types";
import { MIXOS_SOURCE } from "../src/lib/apps/types";
import type {
  ConnectorAuthPolicy,
  ConnectorHttpPolicy,
  ConnectorTelemetryDefinition,
  ConnectorWebhookPolicy,
} from "../src/lib/connectors/types";
import {
  RawAppManifestSchema,
  RawConnectorManifestSchema,
  formatZodError,
} from "./manifest-schemas";

/**
 * Thrown when an app's manifest contains an invalid visibility declaration.
 * Distinct from generic load errors because we want misconfigured visibility
 * to *abort the entire generator run* instead of being silently swallowed
 * by the per-app `Skipping ...` warning path. A public/password mis-declaration
 * is a security-relevant config issue and must not ship.
 */
class FatalManifestError extends Error {
  constructor(message: string) {
    super(message);
    this.name = "FatalManifestError";
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
const CONNECTOR_REGISTRY_FILE = path.resolve(OUTPUT_DIR, "connector-registry.ts");

function scanPages(dir: string, slug: string, prefix: string, out: string[]) {
  for (const entry of fs.readdirSync(dir, { withFileTypes: true })) {
    if (entry.isDirectory()) {
      scanPages(path.join(dir, entry.name), slug, prefix + entry.name + "/", out);
    } else if (entry.name === "Main.tsx" || entry.name === "Main.ts") {
      const key = `${slug}/pages/${prefix}Main`;
      out.push(`  "${key}": () => import("@apps/${slug}/pages/${prefix}${entry.name}"),`);
    }
  }
}

// Core hook names are never slug-prefixed. Keep in sync with CORE_HOOKS in
// src/lib/hooks/hook-system.ts.
const CORE_HOOK_NAMES = new Set<string>([
  "init",
  "user-login",
  "user-sync",
  "user-display-name",
]);

// Mirror resolveHookName(): an app's own custom hook is qualified with its
// slug; core hooks and already-qualified ("app:hook") names pass through.
function qualifyHookName(name: string, slug: string): string {
  if (CORE_HOOK_NAMES.has(name) || name.includes(":")) return name;
  return `${slug}:${name}`;
}

interface HookScan {
  // Emitted-hook counts, including dynamic (non-literal) calls — preserves the
  // historical `hookCounts` semantics.
  counts: { actions: number; filters: number };
  // String-literal hook names this app fires / listens for, slug-qualified.
  emits: { actions: string[]; filters: string[] };
  listens: { actions: string[]; filters: string[] };
}

function scanHooks(appDir: string, slug: string): HookScan {
  let actionCount = 0;
  let filterCount = 0;
  const emitActions = new Set<string>();
  const emitFilters = new Set<string>();
  const listenActions = new Set<string>();
  const listenFilters = new Set<string>();

  // First string-literal arg of a hook call, e.g. .doAction("new-deal").
  // Dynamic (variable) names can't be captured and only show in the counts.
  const literalCall = (method: string) =>
    new RegExp(`\\.${method}\\s*\\(\\s*["'\\\`]([^"'\\\`]+)["'\\\`]`, "g");
  const collect = (src: string, re: RegExp, into: Set<string>) => {
    let m: RegExpExecArray | null;
    while ((m = re.exec(src)) !== null) into.add(qualifyHookName(m[1], slug));
  };

  function walk(dir: string) {
    if (!fs.existsSync(dir)) return;
    for (const entry of fs.readdirSync(dir, { withFileTypes: true })) {
      const full = path.join(dir, entry.name);
      if (entry.isDirectory()) {
        walk(full);
      } else if (/\.(ts|tsx|js|jsx)$/.test(entry.name)) {
        const src = fs.readFileSync(full, "utf-8");
        actionCount += (src.match(/\.doAction\s*\(/g) ?? []).length;
        filterCount += (src.match(/\.applyFilters\s*\(/g) ?? []).length;
        collect(src, literalCall("doAction"), emitActions);
        collect(src, literalCall("applyFilters"), emitFilters);
        collect(src, literalCall("addAction"), listenActions);
        collect(src, literalCall("addFilter"), listenFilters);
      }
    }
  }
  walk(appDir);

  const sorted = (s: Set<string>) => [...s].sort();
  return {
    counts: { actions: actionCount, filters: filterCount },
    emits: { actions: sorted(emitActions), filters: sorted(emitFilters) },
    listens: { actions: sorted(listenActions), filters: sorted(listenFilters) },
  };
}

/**
 * Load an app manifest from either `app.ts` (for manifests that use preset
 * helpers or other TS composition) or `app.json` (the original static form).
 * `app.ts` takes precedence when both exist.
 */
async function loadAppManifest(
  appDir: string,
): Promise<Record<string, unknown> | null> {
  const tsPath = path.join(appDir, "app.ts");
  if (fs.existsSync(tsPath)) {
    // tsx's ESM loader handles transpilation. Append a cache-busting query so
    // repeated generator runs during `next dev` pick up manifest edits.
    const href = `${pathToFileURL(tsPath).href}?t=${Date.now()}`;
    const mod = (await import(href)) as { default?: unknown };
    if (!mod.default || typeof mod.default !== "object") return null;
    return mod.default as Record<string, unknown>;
  }

  const jsonPath = path.join(appDir, "app.json");
  if (fs.existsSync(jsonPath)) {
    return JSON.parse(fs.readFileSync(jsonPath, "utf-8"));
  }

  return null;
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
  for (const [key, value] of Object.entries(raw as Record<string, RouteAuth[]>)) {
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
const ROUTE_BRAND = Symbol.for("mixos.route.definition");

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
  outputValidation: "always" | "dev-only";
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
    .map((seg) => seg.slice(1, -1).replace(/^\.\.\./, "").replace(/^\[|\]$/g, ""));
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
 * the build can only half-enforce. So this follows the `app.ts` precedent
 * instead, which has imported app code since the manifest gained a TS form.
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
    const routeFile = [path.join(dir, "route.ts")].find((f) => fs.existsSync(f));
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
      const routePath = segments.join("/") === "index" ? "" : segments.join("/");

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
          outputValidation: exported.outputValidation,
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

/**
 * Carry through the app's declared escapes, failing on a duplicate rule. Shape
 * and the closed rule set are already schema-validated; a duplicate would leave
 * two different reasons on the record for one exception.
 */
function validateEscapes(
  raw: { rule: string; reason: string }[] | undefined,
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
  raw: { key: string; label: string; type: "text" | "password"; required?: boolean }[] | undefined,
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
 * trade-off (and same regex approach) as `scanHooks`. It catches the common
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

/** As validateAppTelemetry, but for a connector's declared method list. */
function validateConnectorTelemetry(
  raw: { method: string; description?: string }[] | undefined,
  name: string,
): ConnectorTelemetryDefinition[] {
  if (!raw || raw.length === 0) return [];
  const seen = new Set<string>();
  for (const e of raw) {
    if (seen.has(e.method)) {
      throw new Error(
        `connectors/${name}/connector.json: duplicate telemetry method "${e.method}".`,
      );
    }
    seen.add(e.method);
  }
  return raw.map((e) => ({
    method: e.method,
    ...(e.description != null ? { description: e.description } : {}),
  }));
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
    let raw: Record<string, unknown> | null;
    try {
      raw = await loadAppManifest(appDir);
    } catch (err) {
      console.warn(`  Skipping ${entry.name}/ — failed to load manifest: ${err}`);
      continue;
    }
    if (!raw) {
      console.warn(`  Skipping ${entry.name}/ — no app.ts or app.json found`);
      continue;
    }

    try {
      const pagesDir = path.join(APPS_DIR, entry.name, "pages");
      const hasPages = fs.existsSync(pagesDir) && fs.readdirSync(pagesDir).length > 0;

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

      const hookScan = scanHooks(path.join(APPS_DIR, entry.name), entry.name);

      const manifest: AppManifest = {
        slug: entry.name,
        name: r.name,
        description: r.description ?? "",
        icon: r.icon ?? "box",
        connectors: r.connectors ?? [],
        database: r.database ?? false,
        notifications: r.notifications ?? false,
        hasPages,
        global: r.global ?? false,
        roles: r.roles ?? [],
        defaultRole: r.defaultRole ?? null,
        hookCounts: hookScan.counts,
        hooks: { emits: hookScan.emits, listens: hookScan.listens },
        authors: normalizeAuthors(r.authors),
        lastUpdated: parseLastUpdated(raw.lastUpdated),
        widgets: (r.widgets ?? []).map((w) => {
          const component = w.component;
          const filename = path.basename(component, path.extname(component));
          return { ...w, id: filename, component, defaultSize: w.defaultSize ?? { w: 4, h: 3 } };
        }),
        schedules,
        sync: validateSyncs(r.sync, entry.name, appDir, r.connectors ?? []),
        escapes: validateEscapes(r.escapes, entry.name),
        env: validateEnv(r.env, entry.name),
        egress: r.egress ?? [],
        routes,
        telemetry: validateAppTelemetry(r.telemetry, entry.name),
        provides: validateProvides(r.provides, entry.name, appDir),
        consumes: normalizeConsumes(r.consumes),
        mcp: validateMcpTools(r.mcp, entry.name, appDir, r.connectors ?? []),
        ...(pageVisibility ? { pageVisibility } : {}),
        ...(apiVisibility ? { apiVisibility } : {}),
      };

      manifests.push(manifest);
      console.log(`  App: ${manifest.name} (/${manifest.slug})`);
    } catch (err) {
      // FatalManifestError aborts the entire generator run — see class doc.
      if (err instanceof FatalManifestError) throw err;
      console.warn(`  Skipping ${entry.name}/ — invalid manifest: ${err}`);
    }
  }

  // App Services two-sided consent: every consumes ↔ provides pair must agree.
  validateServiceWiring(manifests);

  return manifests;
}

interface ConnectorManifestOut {
  name: string;
  displayName: string;
  description: string;
  credentialFields: { key: string; label: string; type: string }[];
  authors: AppAuthor[];
  lastUpdated: number | null;
  telemetry: ConnectorTelemetryDefinition[];
  auth?: ConnectorAuthPolicy;
  http?: ConnectorHttpPolicy;
  webhook?: ConnectorWebhookPolicy;
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

      const manifest: ConnectorManifestOut = {
        name: raw.name,
        displayName: raw.displayName,
        description: raw.description ?? "",
        credentialFields: raw.credentialFields ?? [],
        authors: normalizeAuthors(raw.authors),
        lastUpdated: parseLastUpdated(raw.lastUpdated),
        telemetry: validateConnectorTelemetry(raw.telemetry, entry.name),
        // Declarative transport/auth policy. Omitted keys stay omitted so the
        // runtime defaults in HttpConnector apply rather than being baked in
        // here — the registry records what was declared, not what was assumed.
        ...(raw.auth ? { auth: raw.auth as ConnectorAuthPolicy } : {}),
        ...(raw.http ? { http: raw.http as ConnectorHttpPolicy } : {}),
        ...(raw.webhook ? { webhook: raw.webhook as ConnectorWebhookPolicy } : {}),
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

async function main() {
  if (!fs.existsSync(OUTPUT_DIR)) {
    fs.mkdirSync(OUTPUT_DIR, { recursive: true });
  }

  console.log("Scanning apps...");
  const apps = await scanApps();
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
          `  "${key}": () => import("@apps/${app.slug}/${widget.component}"),`
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

// Static import maps — Turbopack requires statically analyzable imports
// eslint-disable-next-line @typescript-eslint/no-explicit-any
export const pageLoaders: Record<string, () => Promise<{ default: ComponentType<any> }>> = {
${pageImports.join("\n")}
};

// Widget modules may also export an optional \`resolveConfig\` that the
// config modal calls to fill in dynamic options/defaults at open time.
// eslint-disable-next-line @typescript-eslint/no-explicit-any
export const widgetLoaders: Record<string, () => Promise<{ default: ComponentType<any>; resolveConfig?: (args: { appSlug: string }) => Promise<ResolvedConfig> | ResolvedConfig }>> = {
${widgetImports.join("\n")}
};
`;

  fs.writeFileSync(APP_REGISTRY_FILE, appOutput, "utf-8");
  console.log(`\nGenerated app registry with ${apps.length} app(s)`);

  console.log("\nScanning connectors...");
  const connectors = await scanConnectors();

  const connectorOutput = `// AUTO-GENERATED by scripts/generate-project-registry.ts — do not edit
import type { ConnectorManifest } from "@/lib/connectors/types";

export const connectorRegistry: ConnectorManifest[] = ${JSON.stringify(connectors, null, 2)};

export const connectorNames = [${connectors.map((c) => `"${c.name}"`).join(", ")}] as const;
export type ConnectorName = (typeof connectorNames)[number];
`;

  fs.writeFileSync(CONNECTOR_REGISTRY_FILE, connectorOutput, "utf-8");
  console.log(`Generated connector registry with ${connectors.length} connector(s)`);

}

main().catch((err) => {
  console.error(err);
  process.exit(1);
});
