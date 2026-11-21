/* This Source Code Form is subject to the terms of the Mozilla Public
 * License, v. 2.0. If a copy of the MPL was not distributed with this
 * file, You can obtain one at https://mozilla.org/MPL/2.0/. */

/**
 * What app code may import, and what it may do with what it imported.
 *
 * An app gets what its manifest declares, through `context`, and nothing else.
 * That holds only while `context` is the only way in, and an import is another
 * way in: a platform module that sends a push, reads any app's settings or
 * mints an API key is a capability without its declaration. So app code loads
 * three things, and nothing else:
 *
 *  - its own files, inside apps/<slug>/;
 *  - the platform modules in PLATFORM, and from some of them only the names
 *    listed there;
 *  - the packages in PACKAGES and PACKAGE_PATHS.
 *
 * Types may come from anywhere. `import type` is erased before anything runs.
 *
 * JUDGED BY WHERE IT LANDS. A specifier is resolved first, through relative
 * paths, the tsconfig `paths` aliases and symlinks, and the file it lands on
 * decides. `@/lib/db/../db/client` and `../../../../src/lib/db/server` land in
 * src/lib/db/ like `@/lib/db` does, and are refused like it. A new platform
 * module is closed to apps the day it is written.
 *
 * WHAT CANNOT BE READ IS REFUSED. `require`, `module`, an `import()` whose
 * name is built at runtime, a URL, `import.meta`, a bundler's own loader, and a
 * file in a directory the build does not read: each would load code this check
 * never judged.
 *
 * ONE POLICY, TWO READERS. The registry generator's containment scan
 * (scripts/app-containment.ts) runs `checkAppSource` on every build and every
 * Registry install, and that is the copy that holds. The ESLint rule
 * (eslint-rules/app-imports.mjs) runs the same function in an editor, so the
 * two cannot disagree. Plain .mjs with JSDoc because eslint.config.mjs loads
 * under plain Node.
 *
 * THERE IS NO ESCAPE HATCH. A function worth granting one app is either safe
 * for every app, and goes on the list for all of them, or it is a capability,
 * and belongs on `context` behind a manifest declaration. Adding an entry is a
 * reviewed change to this file, and the reviewer asks four questions of it:
 *
 *  1. Does it take a slug, user or key the app could choose, rather than using
 *     the caller's own?
 *  2. Does it do I/O that `context` already mediates?
 *  3. Does it return a privileged object?
 *  4. For a "*" entry: does every export suit every app?
 *
 * A yes to any of the first three means it belongs on `context`.
 * See docs/plans/20261007_0153-app-import-allowlist.md.
 */
import fs from "node:fs";
import path from "node:path";
import { isBuiltin } from "node:module";
import { fileURLToPath } from "node:url";
import ts from "typescript";

// ── Where an import can land ────────────────────────────────────────────────

/** The repository root, through any symlink, as every resolved path is. */
const ROOT = fs.realpathSync(path.resolve(path.dirname(fileURLToPath(import.meta.url)), "../../.."));
const SRC = path.join(ROOT, "src");
const APPS = path.join(ROOT, "apps");
const CONNECTORS = path.join(ROOT, "connectors");

// ── The lists ───────────────────────────────────────────────────────────────

/**
 * @typedef {object} PlatformEntry
 * @property {readonly string[] | "*"} names
 *   The runtime names an app may import, or "*" when every export is app API.
 * @property {string} use What an app uses it for. Rendered into the docs.
 */

/**
 * The platform modules app code may import at runtime, by the specifier an app
 * writes. Several modules hold app API beside platform internals, so they name
 * what an app may take: `@/lib/apps/route` exports the dispatcher's `runRoute`
 * beside `defineRoute`, and `@/lib/connectors/errors` a Set the platform reads
 * beside the error class.
 *
 * @type {ReadonlyMap<string, PlatformEntry>}
 */
export const PLATFORM = new Map([
  ["@/lib/apps/route", { names: ["defineRoute", "AppError", "isAppError"], use: "The route contract and its errors" }],
  ["@/lib/apps/errors", { names: ["AppError", "isAppError"], use: "The same errors, for server code outside a route" }],
  [
    "@/lib/apps/call",
    {
      names: ["callAppRoute"],
      use: 'A server page calling its own routes in-process. The first argument is the app\'s own slug, written as a string: `callAppRoute("my-app", …)`',
    },
  ],
  ["@/lib/apps/sdk", { names: "*", use: "The browser SDK: `createAppClient`, `AppClientError`, `track` and the push opt-in helpers" }],
  ["@/lib/apps/use-app-query", { names: "*", use: "The client data hook, `useAppQuery`" }],
  ["@/lib/apps/swr-cache", { names: ["createSwrCache"], use: "A cache over the app's own `context.db`" }],
  ["@/lib/apps/sync", { names: ["defineSync"], use: "Declared syncs" }],
  [
    "@/lib/apps/search",
    {
      names: ["searchFields", "containsPattern", "matchesQuery"],
      use: "A search handler's ranking: contains, title first (`docs/apps/search.md`)",
    },
  ],
  ["@/lib/apps/widget-config-presets", { names: "*", use: "Widget config field builders" }],
  ["@/lib/connectors/errors", { names: ["ConnectorError", "isConnectorError"], use: "Recognising a connector failure" }],
  ["@/lib/use-client-value", { names: "*", use: "`useClientValue`" }],
  ["@/lib/utils", { names: ["cn"], use: "Class merging" }],
  ["@/components/ui/*", { names: "*", use: "The UI primitives, one module per file in `src/components/ui/`" }],
]);

/** Packages app code may import, at any path inside them. */
export const PACKAGES = new Set(["react", "zod", "lucide-react"]);

/**
 * Packages app code may import only at these exact paths. The rest of `next`
 * (`next/headers`, `next/server`, …) is the request, the session and the
 * response, which belong to the platform.
 */
export const PACKAGE_PATHS = new Set(["next/link", "next/navigation", "next/font/google", "next/font/local"]);

/** Node built-ins app code may import: none, until an app needs one. */
export const BUILTINS = new Set();

// ── Why each refusal ────────────────────────────────────────────────────────

const ALLOWED_PACKAGES = "react, zod, lucide-react, next/link, next/navigation, next/font/google and next/font/local";

/**
 * Each sentence follows what was refused: `<file>:<line> — <what> <why>`. It
 * says what the import reaches, then what to use instead.
 */
export const WHY = {
  platform:
    'is not on the list of platform modules an app may import (see "What an app can import" in docs/apps/architecture.md). `import type` is fine from anywhere.',
  db: "reaches the database around context.db. Use context.db; `import type { ScopedClient }` is fine.",
  services: "is the platform's App Services broker or context builder. Use context.services.",
  push: 'sends push notifications without the `notifications` grant. Declare "notifications": true in app.json and use context.notifications.send().',
  env: "reads settings past the manifest, other apps' included. Declare what the app needs under `env` in app.json and read it as context.env.<KEY>.",
  network: "reaches the network directly, past the manifest's `egress`. Use context.http, or a connector for a fixed upstream.",
  hooks:
    "is the platform's hook system, which can act as any app. Use context.hooks, or the registrar hooks.ts is called with; `import type { HookRegistrar }` is fine.",
  admin: "administers users, roles, keys or sessions, which is the platform's job. context.user describes the caller.",
  connectors:
    "builds a connector outside context.connectors. Declare it under `connectors` in app.json and use context.connectors.<name>; types are fine.",
  otherApp: "runs another app's code around App Services. Declare `consumes` in app.json and use context.services; types are fine.",
  leavesApp: "leaves the app's own directory. An app imports its own files, and platform modules by their @/ name.",
  notRead:
    "loads a file the build does not read: one in a dot-directory, in assets/, plans/, migrations/ or screenshots/, or a .d.ts. Keep code with the rest of the app's source.",
  nothing: "resolves to no file the build can read.",
  url: "is a URL, which loads code the build never read.",
  package: `is not a package MixOS provides to apps. Apps may import ${ALLOWED_PACKAGES}.`,
  next: `belongs to the platform: the request, the session and the response are not an app's. Apps may import next/link, next/navigation, next/font/google and next/font/local.`,
  builtin:
    "is a Node built-in, and apps get none: the file system, other processes and the module loader are what context exists to mediate.",
  dynamic: "loads a module at runtime. import() is for the app's own files, named by a string literal; import anything else statically.",
  computed: "loads a module whose name is built at runtime, which is how the import rules would otherwise be routed around.",
  commonjs: "is CommonJS. App code is ES modules: use import.",
  loader: "is a module loader, which would load code these rules never judged. App code loads modules with import.",
  importMeta: "is the module's own location, which bundlers turn into a loader and a file reference. App code has no use for it.",
  globalObject:
    "hands the global object on, which hides which of its names are read, and so routes round the rules on them. Read a name off it where it is used: window.location.",
  serverTier:
    'reaches the app\'s server tier from a page or widget, around the gateway: no roles, no validation, no budget, no telemetry. A server page calls callAppRoute("<slug>", "GET /path", input); a widget calls createAppClient(appSlug).',
  patch: "writes to a module the app shares with the platform and every other app. What an app imports is read-only to it.",
};

/**
 * Platform modules apps reach for, matched against the file they resolve to
 * (relative to src/), with what to use instead. Anything else in src/ that is
 * not on the list gets WHY.platform.
 *
 * @type {ReadonlyArray<[RegExp, string]>}
 */
const REFUSED_PLATFORM = [
  [/^lib\/db(\/|\.)/, WHY.db],
  [/^lib\/apps\/scoped-db\./, WHY.db],
  [/^lib\/apps\/(services|context)\./, WHY.services],
  [/^lib\/push\//, WHY.push],
  [/^lib\/apps\/notifications\./, WHY.push],
  [/^lib\/apps\/env\./, WHY.env],
  [/^lib\/env\//, WHY.env],
  [/^lib\/apps\/http\./, WHY.network],
  // Not types.ts, which holds only types: the general answer, `import type`, fits it.
  [/^lib\/hooks\/(?!types\.)/, WHY.hooks],
  [/^lib\/apps\/(access|api-keys|admin-actions|admin-audit|app-password-store)\./, WHY.admin],
  [/^lib\/auth\//, WHY.admin],
  [/^lib\/connectors\//, WHY.connectors],
];

/** Packages apps reach for, with what to use instead. Anything else gets WHY.package. */
const REFUSED_PACKAGES = new Map([
  ...["undici", "node-fetch", "axios", "got", "ky", "superagent", "cross-fetch", "isomorphic-fetch", "ws"].map(
    (name) => /** @type {const} */ ([name, WHY.network]),
  ),
  ["postgres", WHY.db],
  ["pg", WHY.db],
  ["@supabase/supabase-js", WHY.db],
  ["next-auth", WHY.admin],
  ["bcryptjs", WHY.admin],
  ["web-push", WHY.push],
]);

/** Built-ins with a more useful answer than WHY.builtin. */
const REFUSED_BUILTINS = new Map([
  ["process", WHY.env],
  ...["http", "https", "http2", "net", "tls", "dgram", "dns"].map((name) => /** @type {const} */ ([name, WHY.network])),
]);

// ── Which files the build reads ─────────────────────────────────────────────

/** Source the scan reads, and the extensions a bundler or tsx would run. */
export const SOURCE_EXTENSIONS = new Set([".ts", ".tsx", ".mts", ".cts", ".js", ".jsx", ".mjs", ".cjs"]);

/**
 * Directories at the root of an app that hold nothing it runs. The scan does
 * not read them, so nothing may load code from them. Dot-directories, at any
 * depth, are the same.
 */
export const NOT_CODE = new Set(["assets", "plans", "migrations", "screenshots"]);

/** What an app may import from its own tree without it being code. */
const ASSET_EXTENSIONS = new Set([
  ".json",
  ".css",
  ".png",
  ".jpg",
  ".jpeg",
  ".gif",
  ".webp",
  ".avif",
  ".ico",
  ".bmp",
  ".svg",
  ".woff",
  ".woff2",
  ".ttf",
  ".otf",
]);

/** `x.d.ts`, `x.d.mts`, `x.d.cts` and `x.d.css.ts`: types that describe code, not code. */
const DECLARATION_FILE = /\.d(\.[^./\\]+)?\.[cm]?ts$/;

/** `a` is `b`, or inside it. Both absolute and real. */
function within(a, b) {
  const rel = path.relative(b, a);
  return rel === "" || (!rel.startsWith(`..${path.sep}`) && rel !== ".." && !path.isAbsolute(rel));
}

/**
 * Whether the scan reads `file` as the app's source: a source file under
 * `appDir`, outside dot-directories, `node_modules/`, the root NOT_CODE
 * directories, and not a declaration file. Both paths absolute and real.
 *
 * @param {string} appDir
 * @param {string} file
 */
export function isScannedFile(appDir, file) {
  if (!within(file, appDir) || file === appDir) return false;
  const parts = path.relative(appDir, file).split(path.sep);
  if (parts.some((part) => part.startsWith(".") || part === "node_modules")) return false;
  if (parts.length > 1 && NOT_CODE.has(parts[0])) return false;
  if (DECLARATION_FILE.test(file)) return false;
  return SOURCE_EXTENSIONS.has(path.extname(file));
}

/** The real path of `p`, or of its deepest existing ancestor with the rest appended. */
function realish(p) {
  const rest = [];
  let at = path.resolve(p);
  for (;;) {
    try {
      return path.join(fs.realpathSync(at), ...rest.reverse());
    } catch {
      const parent = path.dirname(at);
      if (parent === at) return path.resolve(p);
      rest.push(path.basename(at));
      at = parent;
    }
  }
}

/**
 * The app directory a real path belongs to, `apps/<slug>/`, or null when it is
 * not in one.
 *
 * @param {string} file
 */
function appDirOf(file) {
  if (!within(file, APPS)) return null;
  const [slug, ...rest] = path.relative(APPS, file).split(path.sep);
  return slug && rest.length > 0 ? path.join(APPS, slug) : null;
}

// ── Resolution ──────────────────────────────────────────────────────────────

/** @type {ts.CompilerOptions | undefined} */
let compilerOptions;
/** @type {ts.ModuleResolutionCache | undefined} */
let resolutionCache;

/**
 * The project's own compiler options, read once. Resolution uses exactly what
 * the build does, so a `paths` alias added later is followed without a change
 * here. The project's file list is not enumerated: only the options are needed.
 */
function options() {
  if (!compilerOptions) {
    const configPath = path.join(ROOT, "tsconfig.json");
    const { config } = ts.readConfigFile(configPath, ts.sys.readFile);
    const host = { ...ts.sys, readDirectory: () => [] };
    compilerOptions = ts.parseJsonConfigFileContent(config, host, ROOT, undefined, configPath).options;
    resolutionCache = ts.createModuleResolutionCache(ROOT, (f) => f, compilerOptions);
  }
  return compilerOptions;
}

/** Whether `specifier` matches one of the tsconfig `paths` patterns. */
function isAliased(specifier) {
  return Object.keys(options().paths ?? {}).some((pattern) => {
    const star = pattern.indexOf("*");
    if (star === -1) return specifier === pattern;
    return specifier.startsWith(pattern.slice(0, star)) && specifier.endsWith(pattern.slice(star + 1));
  });
}

/** A `paths` alias applied by hand, for an asset TypeScript will not resolve. */
function unalias(specifier) {
  const opts = options();
  for (const [pattern, targets] of Object.entries(opts.paths ?? {})) {
    const star = pattern.indexOf("*");
    const prefix = star === -1 ? pattern : pattern.slice(0, star);
    if (star === -1 ? specifier !== pattern : !specifier.startsWith(prefix)) continue;
    const base = /** @type {string} */ (opts.pathsBasePath ?? ROOT);
    return path.resolve(base, targets[0].replace("*", specifier.slice(prefix.length)));
  }
  return null;
}

/**
 * `@scope/name/sub` → `@scope/name`; `name/sub` → `name`.
 *
 * @param {string} specifier
 */
function packageName(specifier) {
  const parts = specifier.split("/");
  return specifier.startsWith("@") ? parts.slice(0, 2).join("/") : parts[0];
}

/**
 * @typedef {{ kind: "file", file: string, relative: boolean }
 *   | { kind: "none", relative: boolean, near?: string }
 *   | { kind: "package", name: string }
 *   | { kind: "builtin", name: string }
 *   | { kind: "url" }} Resolution
 *
 * `near`, when nothing resolves, is where the path pointed, so a refusal can
 * still say where it was headed.
 */

/**
 * Where `specifier`, imported from `importer`, lands.
 *
 * Relative and absolute paths, `@apps/<own slug>/…`, and anything matching a
 * tsconfig `paths` pattern are resolved as the build resolves them, then
 * through symlinks. `relative` says the specifier named a path (or the app's
 * own alias) rather than a platform alias, which decides whether it may leave
 * the app at all. Any other bare specifier is judged by its package name.
 *
 * @param {string} specifier
 * @param {string} importer Absolute path of the importing file.
 * @param {string} appDir Absolute, real path of the importing app.
 * @returns {Resolution}
 */
export function resolveImport(specifier, importer, appDir) {
  if (specifier.startsWith("node:") || isBuiltin(specifier)) {
    return { kind: "builtin", name: specifier.replace(/^node:/, "") };
  }
  // data:, file:, http:… name no file and no package. A Windows drive letter
  // is a path, which path.isAbsolute recognises first.
  if (!path.isAbsolute(specifier) && /^[a-z][a-z\d+.-]*:/i.test(specifier)) return { kind: "url" };

  // `@apps/<own slug>/…` is the app's own path under another name: resolved
  // from the app's root, so it may not climb out either.
  const slug = path.basename(appDir);
  const own = specifier === `@apps/${slug}` || specifier.startsWith(`@apps/${slug}/`);
  const relative =
    own || specifier === "." || specifier === ".." || /^\.\.?\//.test(specifier) || path.isAbsolute(specifier);
  if (!relative && !isAliased(specifier)) {
    // `#x` resolves through a package.json, and an app has none.
    return specifier.startsWith("#") ? { kind: "none", relative: false } : { kind: "package", name: packageName(specifier) };
  }

  const spec = own ? `./${specifier.slice(`@apps/${slug}`.length).replace(/^\//, "")}` : specifier;
  const from = own ? path.join(appDir, "index.ts") : importer;
  const near = realish(
    /^\.\.?(\/|$)/.test(spec) ? path.resolve(path.dirname(from), spec) : path.isAbsolute(spec) ? spec : (unalias(spec) ?? ROOT),
  );
  let file = ts.resolveModuleName(spec, from, options(), ts.sys, resolutionCache).resolvedModule?.resolvedFileName;
  // TypeScript resolves no stylesheet or image, so an asset is found by hand.
  if (!file && ASSET_EXTENSIONS.has(path.extname(spec)) && fs.existsSync(near)) file = near;
  if (!file) return { kind: "none", relative, near };
  try {
    return { kind: "file", file: fs.realpathSync(file), relative };
  } catch {
    return { kind: "none", relative, near };
  }
}

/** The real path of a platform specifier, resolved once; null when it names nothing. */
const platformFiles = new Map();
function platformFile(specifier) {
  if (!platformFiles.has(specifier)) {
    const resolved = ts.resolveModuleName(specifier, path.join(ROOT, "index.ts"), options(), ts.sys, resolutionCache)
      .resolvedModule?.resolvedFileName;
    platformFiles.set(specifier, resolved ? fs.realpathSync(resolved) : null);
  }
  return platformFiles.get(specifier);
}

/**
 * The PLATFORM entry a file in src/ falls under, or null. A "/*" entry covers
 * the modules directly in its directory.
 *
 * @param {string} file
 */
function platformEntry(file) {
  for (const [specifier, entry] of PLATFORM) {
    if (specifier.endsWith("/*")) {
      const dir = unalias(specifier.slice(0, -2));
      if (path.dirname(file) === dir && SOURCE_EXTENSIONS.has(path.extname(file)) && !DECLARATION_FILE.test(file)) {
        return entry;
      }
    } else if (platformFile(specifier) === file) {
      return entry;
    }
  }
  return null;
}

// ── The verdict on one import ───────────────────────────────────────────────

/**
 * @typedef {object} ImportRequest
 * @property {string} specifier As written.
 * @property {string} importer Absolute path of the importing file.
 * @property {string} appDir Absolute, real path of the importing app.
 * @property {boolean} [typeOnly] Erased before it runs: allowed from anywhere.
 * @property {readonly string[]} [names] The runtime names taken (`default` for a default import).
 * @property {boolean} [namespace] Takes every export: `import * as`, `export *`, `import()`.
 * @property {boolean} [dynamic] An `import()` call.
 * @property {"import" | "export"} [form] For the message: an import or a re-export.
 */

/** @typedef {{ what: string, why: string }} Refusal */

/**
 * Null when app code may make this import; otherwise what was refused and why.
 *
 * @param {ImportRequest} request
 * @returns {Refusal | null}
 */
export function classifyImport({
  specifier,
  importer,
  appDir,
  typeOnly = false,
  names = [],
  namespace = false,
  dynamic = false,
  form = "import",
}) {
  if (typeOnly) return null;
  const what = dynamic ? `import("${specifier}")` : form === "export" ? `export … from "${specifier}"` : `import "${specifier}"`;
  const refuse = (why) => ({ what, why });
  const target = resolveImport(specifier, importer, appDir);

  switch (target.kind) {
    case "url":
      return refuse(WHY.url);
    case "builtin":
      return BUILTINS.has(target.name) ? null : refuse(REFUSED_BUILTINS.get(target.name) ?? WHY.builtin);
    case "package": {
      const allowed = PACKAGES.has(target.name) || PACKAGE_PATHS.has(specifier);
      if (allowed && dynamic) return refuse(WHY.dynamic);
      if (allowed) return null;
      if (target.name === "next") return refuse(WHY.next);
      return refuse(REFUSED_PACKAGES.get(target.name) ?? WHY.package);
    }
    case "none": {
      // Nothing there, but a path out of the app, or to a connector or another
      // app that is not installed here, is refused for where it was going.
      const { near } = target;
      if (near && !within(near, appDir)) {
        if (target.relative) return refuse(WHY.leavesApp);
        if (within(near, CONNECTORS)) return refuse(WHY.connectors);
        if (within(near, APPS)) return refuse(WHY.otherApp);
      }
      return refuse(WHY.nothing);
    }
  }

  const { file } = target;
  if (within(file, appDir)) {
    // Its own code, if the build read it; JSON, CSS and images from anywhere in it.
    if (!isScannedFile(appDir, file) && !ASSET_EXTENSIONS.has(path.extname(file))) return refuse(WHY.notRead);
    const from = path.relative(appDir, importer).split(path.sep)[0];
    const to = path.relative(appDir, file).split(path.sep);
    if ((from === "pages" || from === "widgets") && to[0] === "lib" && to[1] === "server") return refuse(WHY.serverTier);
    return null;
  }
  // Out of the app. A path may not leave it, even for a file on the list:
  // the platform is reached by its @/ name, which is what the list names.
  if (target.relative) return refuse(WHY.leavesApp);
  if (dynamic) return refuse(WHY.dynamic);

  if (within(file, SRC)) {
    const listed = platformEntry(file);
    if (!listed) {
      const rel = path.relative(SRC, file).split(path.sep).join("/");
      return refuse(REFUSED_PLATFORM.find(([pattern]) => pattern.test(rel))?.[1] ?? WHY.platform);
    }
    const allowed = listed.names;
    if (allowed === "*") return null;
    const list = allowed.join(", ");
    if (namespace) {
      return {
        what: form === "export" ? `export * from "${specifier}"` : `import * as … from "${specifier}"`,
        why: `takes every export of "${specifier}", which also holds platform internals. Import the names you use: ${list}.`,
      };
    }
    const refused = names.filter((name) => !allowed.includes(name));
    if (refused.length === 0) return null;
    return {
      what: `${form} { ${refused.join(", ")} } from "${specifier}"`,
      why: `${refused.length === 1 ? "is" : "are"} not app API. From "${specifier}" an app may import ${list}.`,
    };
  }
  if (within(file, CONNECTORS)) return refuse(WHY.connectors);
  if (within(file, APPS)) return refuse(WHY.otherApp);
  return refuse(WHY.leavesApp);
}

// ── Reading a file ──────────────────────────────────────────────────────────

/**
 * How app source is compiled for reading: syntax and names only. No standard
 * library and no module resolution, so a real global resolves to nothing. Every
 * file is a module, as it is to a bundler, so a script file's top-level
 * declaration cannot pose as a global for the rest of the app.
 *
 * @type {ts.CompilerOptions}
 */
export const SCAN_OPTIONS = {
  noLib: true,
  noResolve: true,
  types: [],
  allowJs: true,
  checkJs: false,
  jsx: ts.JsxEmit.Preserve,
  target: ts.ScriptTarget.ES2022,
  module: ts.ModuleKind.ESNext,
  moduleDetection: ts.ModuleDetectionKind.Force,
  noEmit: true,
};

/** The global object, by every name it goes by. */
export const GLOBAL_OBJECTS = new Set(["globalThis", "window", "self", "global"]);

/** Properties of the global object that are the global object again: `window.top`, `globalThis.global`. */
const GLOBAL_SELF_NAMES = new Set([...GLOBAL_OBJECTS, "frames", "parent", "top"]);

/** The legacy accessors every object has, which share the `__name__` shape. */
const OBJECT_DUNDERS = new Set(["__proto__", "__defineGetter__", "__defineSetter__", "__lookupGetter__", "__lookupSetter__"]);

/**
 * Globals that load modules: CommonJS's own, and every `__name__` a bundler or
 * framework provides, such as `__non_webpack_require__`, `__turbopack_context__`
 * and `__next_require__`. Matched by shape, because the names change between
 * bundler versions and none of them is app API.
 *
 * @param {string} name
 */
export function isLoaderGlobal(name) {
  return name === "require" || name === "module" || (/^__\w+__$/.test(name) && !OBJECT_DUNDERS.has(name));
}

/**
 * `(x as any)`, `x!`, `<T>x`, `x satisfies T` and `(x)` are all still `x`.
 *
 * @param {ts.Expression} expr
 * @returns {ts.Expression}
 */
export function unwrap(expr) {
  let e = expr;
  while (
    ts.isParenthesizedExpression(e) ||
    ts.isAsExpression(e) ||
    ts.isTypeAssertionExpression(e) ||
    ts.isNonNullExpression(e) ||
    ts.isSatisfiesExpression(e)
  ) {
    e = e.expression;
  }
  return e;
}

/**
 * True when `node` sits inside a type, where a name refers to nothing at runtime.
 *
 * @param {ts.Node} node
 */
export function inTypePosition(node) {
  for (let n = node.parent; n; n = n.parent) {
    if (ts.isTypeNode(n)) return true;
    if (ts.isStatement(n) || ts.isSourceFile(n)) return false;
  }
  return false;
}

/**
 * The property name of `a.b` or `a["b"]`, when it is written literally.
 *
 * @param {ts.PropertyAccessExpression | ts.ElementAccessExpression} node
 * @returns {string | undefined}
 */
export function accessedName(node) {
  if (ts.isPropertyAccessExpression(node)) return node.name.text;
  const arg = node.argumentExpression;
  return ts.isStringLiteralLike(arg) ? arg.text : undefined;
}

/**
 * The local name an `export { a as b }` reads: `a`. Only an export with no
 * `from` reads one; `export { a } from "x"` names another module's export.
 */
function exportedLocal(specifier) {
  return specifier.parent.parent.moduleSpecifier ? undefined : (specifier.propertyName ?? specifier.name);
}

/**
 * True when the identifier reads a variable. Not when it is a property key
 * (`b` in `a.b`, `{ b: 1 }`, `class { b() {} }`), a label, an intrinsic JSX
 * tag, or the name of something being declared (`const b`, `function b`,
 * `import { b }`, `declare const b`).
 *
 * @param {ts.Identifier} id
 */
export function isReference(id) {
  const parent = id.parent;
  const named = /** @type {{ name?: ts.Node }} */ (parent).name === id;
  return !(
    (named &&
      (ts.isPropertyAccessExpression(parent) ||
        ts.isPropertyAssignment(parent) ||
        ts.isMethodDeclaration(parent) ||
        ts.isPropertyDeclaration(parent) ||
        ts.isPropertySignature(parent) ||
        ts.isMethodSignature(parent) ||
        ts.isGetAccessorDeclaration(parent) ||
        ts.isSetAccessorDeclaration(parent) ||
        ts.isEnumMember(parent) ||
        ts.isMetaProperty(parent) ||
        ts.isVariableDeclaration(parent) ||
        ts.isParameter(parent) ||
        ts.isBindingElement(parent) ||
        ts.isFunctionDeclaration(parent) ||
        ts.isFunctionExpression(parent) ||
        ts.isClassDeclaration(parent) ||
        ts.isClassExpression(parent) ||
        ts.isInterfaceDeclaration(parent) ||
        ts.isTypeAliasDeclaration(parent) ||
        ts.isEnumDeclaration(parent) ||
        ts.isModuleDeclaration(parent) ||
        ts.isTypeParameterDeclaration(parent) ||
        ts.isImportClause(parent) ||
        ts.isImportSpecifier(parent) ||
        ts.isNamespaceImport(parent) ||
        ts.isImportEqualsDeclaration(parent) ||
        ts.isNamespaceExport(parent))) ||
    (ts.isBindingElement(parent) && parent.propertyName === id) ||
    (ts.isImportSpecifier(parent) && parent.propertyName === id) ||
    (ts.isExportSpecifier(parent) && exportedLocal(parent) !== id) ||
    ts.isJsxAttribute(parent) ||
    ((ts.isJsxOpeningElement(parent) || ts.isJsxSelfClosingElement(parent) || ts.isJsxClosingElement(parent)) &&
      parent.tagName === id &&
      /^[a-z]/.test(id.text)) ||
    ts.isLabeledStatement(parent) ||
    ((ts.isBreakStatement(parent) || ts.isContinueStatement(parent)) && parent.label === id)
  );
}

/**
 * The symbol a reference reads. Two forms need asking differently: `{ a }`,
 * whose `a` is both a key and a read, and `export { a }`, whose own symbol is
 * the export rather than the `a` it reads.
 *
 * @param {ts.TypeChecker} checker
 * @param {ts.Identifier} id
 */
export function referencedSymbol(checker, id) {
  const parent = id.parent;
  if (ts.isShorthandPropertyAssignment(parent) && parent.name === id) {
    return checker.getShorthandAssignmentValueSymbol(parent);
  }
  if (ts.isExportSpecifier(parent) && exportedLocal(parent) === id) {
    return checker.getExportSpecifierLocalTargetSymbol(parent);
  }
  return checker.getSymbolAtLocation(id);
}

/**
 * Whether a declaration gives its name a binding in the running code: a
 * variable, parameter, function with a body, class, enum, value namespace or
 * runtime import, and not one the compiler erases.
 */
function bindsAtRuntime(decl, symbol) {
  if (decl.flags & ts.NodeFlags.Ambient) return false;
  if (
    ts.isVariableDeclaration(decl) ||
    ts.isParameter(decl) ||
    ts.isBindingElement(decl) ||
    ts.isFunctionExpression(decl) ||
    ts.isClassDeclaration(decl) ||
    ts.isClassExpression(decl) ||
    ts.isEnumDeclaration(decl)
  ) {
    return true;
  }
  // An overload signature has no body, and nothing of it is left to run.
  if (ts.isFunctionDeclaration(decl)) return decl.body !== undefined;
  if (ts.isModuleDeclaration(decl)) return (symbol.flags & ts.SymbolFlags.ValueModule) !== 0;
  if (ts.isImportSpecifier(decl)) return !decl.isTypeOnly && !decl.parent.parent.isTypeOnly;
  if (ts.isImportClause(decl)) return !decl.isTypeOnly;
  if (ts.isNamespaceImport(decl)) return !decl.parent.isTypeOnly;
  // `import x = require("…")`; an alias of a namespace member may be erased.
  if (ts.isImportEqualsDeclaration(decl)) return !decl.isTypeOnly && ts.isExternalModuleReference(decl.moduleReference);
  return false;
}

/**
 * True when `id` names a global: nothing in the file binds it at runtime.
 *
 * What the type checker resolves is not enough. `declare const process`, a
 * `declare global` block and a type-only import each give a name a
 * declaration the compiler erases, and in a .js file `module.exports = …`
 * gives `module` one it made up; in every case the running code still reaches
 * the real global.
 *
 * @param {ts.TypeChecker} checker
 * @param {ts.Identifier} id
 */
export function isGlobalReference(checker, id) {
  const symbol = referencedSymbol(checker, id);
  return !symbol?.declarations?.some((decl) => bindsAtRuntime(decl, symbol));
}

/**
 * True when `expr` is the global object: `globalThis`, `window`, `self` or
 * `global`, or one of them read off another, as in `globalThis.window`.
 *
 * @param {ts.TypeChecker} checker
 * @param {ts.Expression} expr
 * @returns {boolean}
 */
export function isGlobalObject(checker, expr) {
  const e = unwrap(expr);
  if (ts.isIdentifier(e)) return GLOBAL_OBJECTS.has(e.text) && isReference(e) && isGlobalReference(checker, e);
  if (ts.isPropertyAccessExpression(e) || ts.isElementAccessExpression(e)) {
    const name = accessedName(e);
    return name !== undefined && GLOBAL_SELF_NAMES.has(name) && isGlobalObject(checker, e.expression);
  }
  return false;
}

/** `(x)`, `x as T`, `x!`, `<T>x` and `x satisfies T`: what unwrap() sees through. */
function isWrapper(node) {
  return (
    ts.isParenthesizedExpression(node) ||
    ts.isAsExpression(node) ||
    ts.isTypeAssertionExpression(node) ||
    ts.isNonNullExpression(node) ||
    ts.isSatisfiesExpression(node)
  );
}

/**
 * How the global object at `expr` is used. "name" when a name is read straight
 * off it (`window.location`, `window["x"]`, `typeof window`, `"x" in window`),
 * "self" when what is read is the global object again (`globalThis.window`),
 * and "value" when it is handed on, which hides which names are read.
 */
function globalObjectUse(expr) {
  let e = expr;
  while (isWrapper(e.parent)) e = e.parent;
  const parent = e.parent;
  if ((ts.isPropertyAccessExpression(parent) || ts.isElementAccessExpression(parent)) && parent.expression === e) {
    const name = accessedName(parent);
    return name !== undefined && GLOBAL_SELF_NAMES.has(name) ? "self" : "name";
  }
  if (ts.isTypeOfExpression(parent)) return "name";
  if (ts.isBinaryExpression(parent) && parent.operatorToken.kind === ts.SyntaxKind.InKeyword && parent.right === e) {
    return "name";
  }
  return "value";
}

/**
 * True when `arguments` here is the module's own, outside any function. A
 * CommonJS module runs inside a wrapper whose arguments are its `require` and
 * `module`, and a bundler wraps every module the same way.
 */
function isModuleArguments(id) {
  for (let n = id.parent; n; n = n.parent) {
    if (ts.isFunctionLike(n) && !ts.isArrowFunction(n)) return false;
    if (ts.isClassStaticBlockDeclaration(n) || ts.isPropertyDeclaration(n)) return false;
  }
  return true;
}

/** Where a node starts, 1-based line and 0-based column. */
function position(source, node) {
  const { line, character } = source.getLineAndCharacterOfPosition(node.getStart(source));
  return { line: line + 1, column: character };
}

/** The first `max` characters of a node's text, on one line. */
function excerpt(source, node, max = 40) {
  const text = node.getText(source).replace(/\s+/g, " ");
  return text.length > max ? `${text.slice(0, max - 1)}…` : text;
}

/** `Object.defineProperty(x, …)` and the other ways to write through a reference. */
const WRITERS = new Map([
  ["Object", new Set(["defineProperty", "defineProperties", "assign", "setPrototypeOf"])],
  ["Reflect", new Set(["set", "defineProperty", "deleteProperty", "setPrototypeOf"])],
]);

/** `x` for `x`, `x.a`, `x["a"].b` and `(x as T).a`: the identifier a chain starts from. */
function rootIdentifier(expr) {
  let e = unwrap(expr);
  while (ts.isPropertyAccessExpression(e) || ts.isElementAccessExpression(e)) e = unwrap(e.expression);
  return ts.isIdentifier(e) ? e : undefined;
}

/** Every expression an assignment writes to: `a.b` in `a.b = 1`, `[a.b] = …` and `({ k: a.b } = …)`. */
function assignmentTargets(target, out = []) {
  const e = unwrap(target);
  if (ts.isArrayLiteralExpression(e)) {
    for (const el of e.elements) assignmentTargets(ts.isSpreadElement(el) ? el.expression : el, out);
  } else if (ts.isObjectLiteralExpression(e)) {
    for (const prop of e.properties) {
      if (ts.isPropertyAssignment(prop)) assignmentTargets(prop.initializer, out);
      else if (ts.isSpreadAssignment(prop)) assignmentTargets(prop.expression, out);
    }
  } else if (ts.isBinaryExpression(e) && e.operatorToken.kind === ts.SyntaxKind.EqualsToken) {
    assignmentTargets(e.left, out); // a default: `[a.b = 1] = …`
  } else {
    out.push(e);
  }
  return out;
}

/**
 * @typedef {object} SourceFinding
 * @property {number} line 1-based.
 * @property {number} column 0-based.
 * @property {string} what The construct, as written.
 * @property {string} why Why it is refused, and what to use instead.
 */

/**
 * Everything one app file does to load code, and to what it loaded, held to
 * this policy:
 *
 *  - every import, re-export and `import()` goes through classifyImport();
 *  - `require`, `module`, a bundler's `__loader__` globals, the module's own
 *    `arguments`, `import x = require()` and `import.meta` are refused outright,
 *    and so is the global object handed on, which would hide which of its names
 *    are read;
 *  - `callAppRoute` may only be called, with this app's own slug as a string
 *    literal, so it cannot run another app's routes;
 *  - nothing imported from outside the app is written to: no property
 *    assignment, `delete` or `Object.defineProperty`/`assign`/`Reflect.set`
 *    through an imported binding, which every other app shares.
 *
 * @param {object} args
 * @param {ts.SourceFile} args.source Parsed with parent pointers.
 * @param {ts.TypeChecker} args.checker From a program compiled with SCAN_OPTIONS.
 * @param {string} args.appDir Absolute, real path of the app.
 * @returns {SourceFinding[]}
 */
export function checkAppSource({ source, checker, appDir }) {
  const importer = source.fileName;
  const slug = path.basename(appDir);
  /** @type {SourceFinding[]} */
  const findings = [];
  const report = (node, what, why) => findings.push({ ...position(source, node), what, why });

  /** Bindings imported from outside the app, which every other app shares. */
  const shared = new Set();
  /** The local bindings of callAppRoute. */
  const callers = new Set();
  const callFile = platformFile("@/lib/apps/call");

  const judge = (node, request) => {
    const refusal = classifyImport({ importer, appDir, ...request });
    if (refusal) report(node, refusal.what, refusal.why);
    return refusal;
  };

  /** Remember what a runtime import binds, for the rules on how it is used. */
  const bind = (specifier, nameNodes) => {
    const target = resolveImport(specifier, importer, appDir);
    if (target.kind === "file" && within(target.file, appDir)) return;
    for (const { imported, local } of nameNodes) {
      const symbol = checker.getSymbolAtLocation(local);
      if (!symbol) continue;
      shared.add(symbol);
      if (target.kind === "file" && target.file === callFile && imported === "callAppRoute") callers.add(symbol);
    }
  };

  for (const statement of source.statements) {
    if (ts.isImportDeclaration(statement) && ts.isStringLiteral(statement.moduleSpecifier)) {
      const specifier = statement.moduleSpecifier.text;
      const clause = statement.importClause;
      /** @type {{ imported: string, local: ts.Identifier }[]} */
      const bound = [];
      let namespace = false;
      if (clause && !clause.isTypeOnly) {
        if (clause.name) bound.push({ imported: "default", local: clause.name });
        const named = clause.namedBindings;
        if (named && ts.isNamespaceImport(named)) {
          namespace = true;
          bound.push({ imported: "*", local: named.name });
        } else if (named) {
          for (const el of named.elements) {
            if (!el.isTypeOnly) bound.push({ imported: (el.propertyName ?? el.name).text, local: el.name });
          }
        }
      }
      // `import { type A }`, every specifier a type, is erased whole.
      const typeOnly =
        !!clause &&
        (clause.isTypeOnly ||
          (!clause.name &&
            !!clause.namedBindings &&
            ts.isNamedImports(clause.namedBindings) &&
            clause.namedBindings.elements.length > 0 &&
            clause.namedBindings.elements.every((el) => el.isTypeOnly)));
      const names = bound.filter((b) => b.imported !== "*").map((b) => b.imported);
      if (!judge(statement, { specifier, typeOnly, names, namespace })) bind(specifier, bound);
    } else if (ts.isExportDeclaration(statement) && statement.moduleSpecifier && ts.isStringLiteral(statement.moduleSpecifier)) {
      const specifier = statement.moduleSpecifier.text;
      const clause = statement.exportClause;
      const elements = clause && ts.isNamedExports(clause) ? clause.elements.filter((el) => !el.isTypeOnly) : [];
      const typeOnly =
        statement.isTypeOnly ||
        (!!clause && ts.isNamedExports(clause) && clause.elements.length > 0 && elements.length === 0);
      const names = elements.map((el) => (el.propertyName ?? el.name).text);
      const refusal = judge(statement, {
        specifier,
        typeOnly,
        names,
        namespace: !clause || ts.isNamespaceExport(clause),
        form: "export",
      });
      // Handing callAppRoute on under the app's own name would let another
      // file call it with any slug, so passing it on is a use like any other.
      if (!refusal && !typeOnly && names.includes("callAppRoute")) {
        const target = resolveImport(specifier, importer, appDir);
        if (target.kind === "file" && target.file === callFile) {
          report(statement, `export { callAppRoute } from "${specifier}"`, callAppRouteWhy(slug));
        }
      }
    } else if (
      ts.isImportEqualsDeclaration(statement) &&
      ts.isExternalModuleReference(statement.moduleReference) &&
      !statement.isTypeOnly
    ) {
      const ref = statement.moduleReference.expression;
      report(statement, `import ${statement.name.text} = require(${ref ? excerpt(source, ref) : ""})`, WHY.commonjs);
    }
  }

  const visit = (node) => {
    // The global object handed on: `const g = globalThis`, `Reflect.get(window,
    // …)`, `const { process } = globalThis`. A name read off it later cannot be
    // seen, which would route round every rule on globals, these included.
    if (
      (ts.isIdentifier(node) || ts.isPropertyAccessExpression(node) || ts.isElementAccessExpression(node)) &&
      !inTypePosition(node) &&
      isGlobalObject(checker, node) &&
      globalObjectUse(node) === "value"
    ) {
      report(node, excerpt(source, node), WHY.globalObject);
    }

    if (ts.isCallExpression(node) && node.expression.kind === ts.SyntaxKind.ImportKeyword) {
      // import("./x"): judged like a static import of the whole module.
      const arg = node.arguments[0] && unwrap(node.arguments[0]);
      if (arg && ts.isStringLiteralLike(arg)) {
        judge(node, { specifier: arg.text, namespace: true, dynamic: true });
      } else if (arg) {
        report(node, "import(…)", WHY.computed);
      }
    } else if (ts.isMetaProperty(node) && node.keywordToken === ts.SyntaxKind.ImportKeyword) {
      report(node, "import.meta", WHY.importMeta);
    } else if (ts.isPropertyAccessExpression(node) || ts.isElementAccessExpression(node)) {
      // globalThis.require, window["__next_require__"]
      const name = accessedName(node);
      if (name !== undefined && isLoaderGlobal(name) && isGlobalObject(checker, node.expression)) {
        report(node, `${unwrap(node.expression).getText(source)}.${name}`, WHY.loader);
      }
    } else if (ts.isIdentifier(node) && !inTypePosition(node) && isReference(node)) {
      if (isLoaderGlobal(node.text) && isGlobalReference(checker, node)) {
        report(node, node.text, WHY.loader);
      } else if (node.text === "arguments" && isModuleArguments(node)) {
        report(node, "arguments", WHY.loader);
      } else {
        checkUse(node);
      }
    }

    // Writes through an imported binding: `X.y = …`, `X.prototype.y = …`,
    // `delete X.y`, `X.y++`, and destructuring into `X.y`.
    if (
      ts.isBinaryExpression(node) &&
      node.operatorToken.kind >= ts.SyntaxKind.FirstAssignment &&
      node.operatorToken.kind <= ts.SyntaxKind.LastAssignment
    ) {
      for (const target of assignmentTargets(node.left)) checkWrite(target, `${excerpt(source, target)} =`);
    } else if ((ts.isForInStatement(node) || ts.isForOfStatement(node)) && !ts.isVariableDeclarationList(node.initializer)) {
      for (const target of assignmentTargets(node.initializer)) checkWrite(target, `${excerpt(source, target)} =`);
    } else if (
      (ts.isPrefixUnaryExpression(node) || ts.isPostfixUnaryExpression(node)) &&
      (node.operator === ts.SyntaxKind.PlusPlusToken || node.operator === ts.SyntaxKind.MinusMinusToken)
    ) {
      checkWrite(node.operand, excerpt(source, node));
    } else if (ts.isDeleteExpression(node)) {
      checkWrite(node.expression, excerpt(source, node));
    } else if (ts.isCallExpression(node) && node.arguments.length > 0) {
      // Object.defineProperty(X, …), Object.assign(X.prototype, …), Reflect.set(X, …)
      const callee = unwrap(node.expression);
      if (ts.isPropertyAccessExpression(callee) || ts.isElementAccessExpression(callee)) {
        const holder = unwrap(callee.expression);
        const method = accessedName(callee);
        if (ts.isIdentifier(holder) && method && WRITERS.get(holder.text)?.has(method)) {
          const root = rootIdentifier(node.arguments[0]);
          if (root && shared.has(checker.getSymbolAtLocation(root))) {
            report(node, `${holder.text}.${method}(${excerpt(source, node.arguments[0])}, …)`, WHY.patch);
          }
        }
      }
    }
    ts.forEachChild(node, visit);
  };

  /** A write is refused when what it writes to hangs off an imported binding. */
  const checkWrite = (target, what) => {
    const e = unwrap(target);
    if (!ts.isPropertyAccessExpression(e) && !ts.isElementAccessExpression(e)) return;
    const root = rootIdentifier(e);
    if (root && shared.has(checker.getSymbolAtLocation(root))) report(e, what, WHY.patch);
  };

  /**
   * callAppRoute may be called, with this app's slug as a literal, and used
   * no other way: a call with another slug runs that app's routes as the
   * current user, and the binding passed anywhere else can be called with any.
   */
  const checkUse = (id) => {
    if (callers.size === 0 || ts.isImportSpecifier(id.parent) || ts.isImportClause(id.parent)) return;
    const symbol = referencedSymbol(checker, id);
    if (!symbol || !callers.has(symbol)) return;

    let callee = id;
    while (ts.isParenthesizedExpression(callee.parent) || ts.isNonNullExpression(callee.parent)) callee = callee.parent;
    const call = callee.parent;
    if (ts.isCallExpression(call) && call.expression === callee) {
      const first = call.arguments[0] && unwrap(call.arguments[0]);
      if (first && ts.isStringLiteralLike(first) && first.text === slug) return;
      report(call, `${id.text}(${first ? `${excerpt(source, first, 30)}, …` : ""})`, callAppRouteWhy(slug));
    } else {
      report(id, id.text, callAppRouteWhy(slug));
    }
  };

  visit(source);
  return findings;
}

/** @param {string} slug */
function callAppRouteWhy(slug) {
  return (
    `can run another app's routes as the current user. callAppRoute is called directly, with this app's own ` +
    `slug as a string literal, "${slug}"; another app's data comes through App Services.`
  );
}

/**
 * checkAppSource for one file's text, compiled on its own: what the ESLint rule
 * runs, on the editor's unsaved text rather than what is on disk. Empty for a
 * file that is not app source the build reads.
 *
 * @param {string} file Absolute path; it need not exist.
 * @param {string} text
 * @returns {SourceFinding[]}
 */
export function checkAppText(file, text) {
  const real = realish(file);
  const appDir = appDirOf(real);
  if (!appDir || !isScannedFile(appDir, real)) return [];
  const host = ts.createCompilerHost(SCAN_OPTIONS);
  const getSourceFile = host.getSourceFile;
  host.getSourceFile = (name, languageVersion, ...rest) =>
    name === real
      ? ts.createSourceFile(name, text, languageVersion, true)
      : getSourceFile.call(host, name, languageVersion, ...rest);
  host.fileExists = (name) => name === real || ts.sys.fileExists(name);
  host.readFile = (name) => (name === real ? text : ts.sys.readFile(name));
  const program = ts.createProgram([real], SCAN_OPTIONS, host);
  const source = program.getSourceFile(real);
  return source ? checkAppSource({ source, checker: program.getTypeChecker(), appDir }) : [];
}

// ── The docs ────────────────────────────────────────────────────────────────

/**
 * The allowlist as Markdown, for docs/apps/architecture.md. Generated so the
 * page and the policy cannot disagree; scripts/generate-import-docs.ts writes
 * it between the markers, and a test fails when the two differ.
 */
export function renderAllowlist() {
  const code = (s) => `\`${s}\``;
  const series = (items) =>
    items.length <= 1 ? items.join("") : `${items.slice(0, -1).join(", ")} and ${items[items.length - 1]}`;
  const rows = [...PLATFORM].map(
    ([specifier, { names, use }]) =>
      `| ${code(specifier)} | ${names === "*" ? "all" : names.map(code).join(", ")} | ${use} |`,
  );
  return [
    "| Module | Names | For |",
    "| --- | --- | --- |",
    ...rows,
    "",
    `**Packages:** ${series([...PACKAGES].map(code))}, at any path inside them, and ${series(
      [...PACKAGE_PATHS].map(code),
    )}, at exactly that path.`,
    "",
    `**Node built-ins:** ${BUILTINS.size === 0 ? "none" : series([...BUILTINS].map(code))}.`,
  ].join("\n");
}
