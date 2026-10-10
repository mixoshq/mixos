# App imports: an allowlist, enforced by the build

**Status:** built
**Scope:** platform — `src/lib/apps/import-policy.mjs` (new), `scripts/app-containment.ts`, `scripts/generate-project-registry.ts`, `eslint-rules/app-imports.mjs` (new), `eslint.config.mjs`, `scripts/generate-import-docs.ts` (new), docs

Builds on [`20261005_2150-app-escapes.md`](20261005_2150-app-escapes.md), whose
containment scan this extends. Supersedes the import half of
[`20260923_0041-app-packages.md`](20260923_0041-app-packages.md).

## Context

An app declares what it needs in `app.json` (`notifications`, `database`, `env`,
`egress`, `connectors`, `services`, `hooks`), and the platform hands it only
that, through `context`. That holds only while `context` is the only way in.
For imports, it wasn't.

ESLint restricted six things in app code: `@/lib/db*`, `@connectors/*` and
`@/lib/connectors/*` outside the server tier, `@/lib/apps/services`,
`@/lib/apps/context`, and the two scoped-DB factories. The rest of `src/` was
importable, and much of it is a capability without its declaration:

| Import from an app route | What the app got |
|---|---|
| `sendPushToUsers` from `@/lib/push/server` | A push to any user, without the `notifications` grant |
| `loadAppEnv(slug)` from `@/lib/apps/env` | Any app's settings, with `password` fields decrypted |
| `getUserById` and `setUserAppRole` from `@/lib/apps/access` | A whole `users` row; any role, for any user, in any app |
| `mintApiKey` from `@/lib/apps/api-keys` | An API key for any app |
| `createHttpClient(slug, egress)` from `@/lib/apps/http` | A `context.http` with an egress list the app chooses |
| `hooks` from `@/lib/hooks` | `createRegistrar(slug, { entrypoint: true })` and `clearEntrypoint(slug)` for any slug: acting as another app, replacing or deleting its brand filters |
| `../../../../src/lib/db/server`, `@/lib/db/../db/client` | The raw DB client, spelled in a way the rule didn't match |
| `node:fs`, `child_process`, `node:module`, `postgres`, `next/headers` | `.env.local`, a shell, `createRequire`, a DB driver, the session cookie |
| `@connectors/<x>` at runtime, in `api/` | A connector built outside `context.connectors` |
| `@apps/<other>/lib/server/db` | Another app's server code, around App Services |

Beneath those sat three structural problems. The rules were a denylist of
spellings, so every new module under `src/` was open the day it was written,
and a relative path or `@/../` reached a banned module under another name.
They were lint-only: lint doesn't run in `next build` (Next 16) or on a
Registry install, and a disable comment silenced it. And every app block
matched `{ts,tsx}` only, so `.js` and `.mjs` files skipped them all.

The containment scan from app-escapes runs on every build and install, before
any app module is imported, but it judged no imports and left five gaps in what
it did claim: `fs` and `child_process` weren't on its module list; `require` was
caught only as a direct callee, so `const r = require`, `(0, require)(…)` and
`module.require(…)` passed; `` import(`../${x}`) `` passed as a "relative
template"; `import("data:text/javascript,…")` passed; and code in a
dot-directory, `assets/` or a symlinked directory was never read, though an app
could import it.

Two runtime channels between apps rode on the same gap. `callAppRoute` runs any
app's routes, mutations included, as the current user, with no
`provides`/`consumes` on either side. And the hook system's `createRegistrar`
and `clearEntrypoint` take any slug.

## Decisions

| # | Decision | Why |
|---|---|---|
| 1 | **Default-deny, judged by where an import lands.** Relative specifiers, absolute paths and anything matching a tsconfig `paths` pattern are resolved with `ts.resolveModuleName` and the project's own compiler options, then through `fs.realpathSync`. Other bare specifiers are judged by package name. | Spelling stops mattering: `@/lib/db/../db/client`, a relative path, an absolute path and a symlink all land in `src/lib/db/` and are refused. A future alias can't open a door either. |
| 2 | **The destination decides.** Inside `apps/<slug>/`, the app's own code. In `src/`, it must be on the list. A connector or another app: type-only. A package or built-in: the package list. Anything else, including a specifier that resolves to nothing (`#x`, a typo) or a URL (`data:`, `file:`, `https:`), is refused. | One rule per destination. |
| 3 | **The list names exports, not just modules.** An entry is a module plus the runtime names an app may take, or `*` when every export is app API. `import * as`, `export *`, `export * as` and `import()` take every export, so they're allowed only for `*` modules. | Several modules hold app API beside platform internals: `@/lib/apps/route` exports the dispatcher's `runRoute` beside `defineRoute`; `@/lib/apps/sync`, `runSync`; `@/lib/connectors/errors`, a `Set` the platform reads. Naming exports keeps each one module. |
| 4 | **Types from anywhere.** `import type`, `export type … from`, `import { type A }` when every name is a type, `export type *`, `import type x = require()` and `typeof import("…")`. | They're erased before anything runs. `tsconfig.json` leaves `verbatimModuleSyntax` off, which is what erases the inline form whole, and a test pins it. Owner's decision: anywhere, rather than only from published modules; the cost is that a platform refactor can break an app's typecheck, not its security. |
| 5 | **Relative imports stay inside the app and land on code the scan reads.** `@apps/<own-slug>/…` counts as relative. A path out of the app is refused even when it points at a module on the list, because `@/` is the only way into `src/`. A runtime import of code in a dot-directory, the app's root `assets/`, `plans/`, `migrations/` or `screenshots/`, or a `.d.ts` is refused. JSON, CSS, images and fonts in the app are fine wherever they are. | Closes the hidden-code gap without scanning `.git/`. The non-code directories are skipped at the app root, where they live; code anywhere else is read. |
| 6 | **No symbolic link, `node_modules/` or `package.json` anywhere in an app tree.** The walk refuses each, in every directory but dot-directories. | The walk can't see where a link leads. A nested `node_modules/zod` shadows the instance's copy, which turns the package list into a name check on code nobody read. A `package.json` changes resolution under the scan: its `types` tells TypeScript one file while its `main` tells the bundler and tsx another, and its `imports` maps `#x`. The installer already refuses symlinks; a dev instance's checkout is not checked. |
| 7 | **Code loads no other way.** A literal `import("./x")` is judged like a static import of the whole module, and only the app's own files load at runtime. A computed `import()`, `require`, `module`, a bundler's or framework's own loader global (any `__name__`: `__non_webpack_require__`, `__turbopack_context__`, `__next_require__`), the module wrapper's top-level `arguments`, `import x = require()` and `import.meta` are refused wherever they appear, bare or read off `globalThis`/`window`/`self`/`global`. | App code is ES modules, and no first-party app uses any of these. The generator loads app modules through tsx as CommonJS, where `require` and `module` are live; under a bundler, the loader globals and `import.meta` reach modules by id or path. |
| 8 | **The generator enforces it, before any app module is imported.** The check is part of `scanAppContainment()`, so it runs wherever the generator runs: `predev`, `prebuild`, `pretypecheck`, `release`, `premigrate:apps`, and step 9 of every Registry install. A finding skips the app (`Skipping <slug>/ — …`), which the installer reports as `rejected-by-registry` and rolls back. Every source extension is read, `.js`/`.mjs`/`.cjs` included. Every entry point the generator registers (routes, pages, widgets, `hooks.ts`, `widgets.ts`, jobs, syncs, services, MCP tools) must be a file the scan read, and a route is checked before the generator imports it. | Lint runs on pull requests to this repository and nowhere else. An entry point is loaded by the platform, not imported by the app, so the import rules alone would not cover one in a skipped directory. |
| 9 | **One policy, two readers.** `src/lib/apps/import-policy.mjs` holds the lists and the checks: `classifyImport()` for one import, and `checkAppSource()` for everything a file does to load code. The scan calls it per file, and the ESLint rule `mos-apps/app-imports` runs the same function on the editor's text. The three `no-restricted-imports` blocks go. | The editor and the build can't drift apart, and a test compares them. `.mjs` with JSDoc because `eslint.config.mjs` loads under plain Node. |
| 10 | **No per-app escape hatch.** No `escapes` rule and no manifest field opens an import. A function apps need is added for all apps by a reviewed change to the policy, or becomes a `context` capability behind a manifest declaration. | An import worth granting one app is either safe for every app, or a capability without its gate: `sendPushToUsers` is `notifications` without the declaration. |
| 11 | **Shown where authors look.** The table in `docs/apps/architecture.md` is generated from the policy (`scripts/generate-import-docs.ts`), and a test fails when they differ. Every refusal names the file, the line, the import and what to use instead. | An author sees the whole public surface in one place, and the docs can't go stale. |
| 12 | **The page/widget → `lib/server/` tier rule moves into the policy unchanged.** | It's an app-internal rule the old blocks carried. |
| 13 | **`callAppRoute` runs the app's own routes only.** Its first argument must be the app's own slug as a string literal, and any other use of the binding is refused: a variable slug, a spread, an alias, `.call`/`.apply`, passing it as a value, re-exporting it. | Owner's decision. Fully static, and it closes the second app-to-app channel at build time. `export *` and `import()` of `@/lib/apps/call` are refused by decisions 3 and 7. |
| 14 | **No Node built-ins.** | Owner's decision: none until an app asks. Web Crypto, `Buffer`, `URL` and `TextEncoder` are globals anyway. |
| 15 | **Writes to shared modules: the direct forms are refused.** An assignment, compound assignment, `++`/`--`, `delete` or destructuring target whose chain starts at a binding imported from outside the app (`X.y = …`, `X.prototype.y = …`), and `Object.defineProperty`/`defineProperties`/`assign`/`setPrototypeOf` or `Reflect.set`/`defineProperty`/`deleteProperty`/`setPrototypeOf` on one. Indirect forms stay a documented residual. | Owner's decision. Apps share module instances with the platform, so `AppError.prototype.toJSON = …` or a write to `zod` changes every app and the platform's own validation. |
| 16 | **The hook system is not app code's.** `@/lib/hooks` and everything under it are refused at runtime; `import type { HookRegistrar }` is what the docs teach and stays fine. | `createRegistrar` and `clearEntrypoint` take any slug. An app gets `context.hooks` and the registrar `hooks.ts` is called with. |
| 17 | **A declaration the compiler erases does not hide a global.** The scan treats a name as local only if something binds it at runtime: a variable, parameter, function with a body, class, enum, value namespace or runtime import. `declare const process`, a `declare global` block, a type-only import, a bodiless overload, `import x = N.member`, `export { process }` and the symbol TypeScript invents for `module.exports` in a `.js` file are not bindings. Every file is compiled as a module, so a script file's top-level `var` can't pose as a global either. And the global object is read by name only: handing it on (`const g = globalThis`, `Reflect.get(window, …)`, destructuring it) is refused, and `window.top` or `globalThis.global` counts as the global object. | The `require` and `module` bans mean nothing if `declare const require: any` gets round them, nor the `process` ban if `const { process } = globalThis` does. The same fixes hold every name the scan refuses. |
| 18 | **The app-packages plan is partly superseded.** This replaces its Phase 1 import scan (item 2's `scanAppImports`, items 4 and 5) and decisions 9 and 13, and brings forward the generator's refusal of `node_modules/` and `package.json` from decision 1. Decision 1's installer preflight and lockfiles, decision 10 (refusing JS-family files) and Phase 2 (`packages`) stay there, built on this policy module. | Owner's decision. |

**Why the build and not a sandbox.** Five options were weighed: add the newly
found modules to the ESLint denylist (still default-allow and lint-only); an
allowlist in ESLint only (lint doesn't run on install); **an allowlist in the
generator's scan, with ESLint reading the same policy** (chosen); a runtime
guard in every sensitive function (every function needs it forever, and "who
called" is ambiguous when app handlers run inside platform calls); and running
apps in a worker or separate process (the only real boundary, and months of
work). The scan closes this for code a reviewer can read. Isolation is the
answer if MixOS ever runs code nobody reviews.

## The allowlist

**Platform modules, at runtime.** What first-party apps and the app docs use,
less anything that hands over more than the manifest grants.

| Module | Names | For |
|---|---|---|
| `@/lib/apps/route` | `defineRoute`, `AppError`, `isAppError` | The route contract and its errors |
| `@/lib/apps/errors` | `AppError`, `isAppError` | The same errors, for server code outside a route |
| `@/lib/apps/call` | `callAppRoute` | A server page calling its own routes in-process (decision 13) |
| `@/lib/apps/sdk` | `*` | The browser SDK. The browser can already do all of it |
| `@/lib/apps/use-app-query` | `*` | The client data hook |
| `@/lib/apps/swr-cache` | `createSwrCache` | A cache over the app's own `context.db` |
| `@/lib/apps/sync` | `defineSync` | Declared syncs |
| `@/lib/apps/widget-config-presets` | `*` | Widget config field builders |
| `@/lib/connectors/errors` | `ConnectorError`, `isConnectorError` | Recognising a connector failure |
| `@/lib/use-client-value` | `*` | `useClientValue` |
| `@/lib/utils` | `cn` | Class merging |
| `@/components/ui/*` | `*` | The UI primitives. A test holds the directory to presentational imports |

**Packages:** `react`, `zod` and `lucide-react` by package name; `next/link`,
`next/navigation`, `next/font/google` and `next/font/local` by exact path, so
`next/headers`, `next/server`, `next/image` and the rest stay refused.

**Node built-ins:** none. **Types:** from anywhere.

**Refused with a pointer.** Everything else is refused; these get their own
message:

| Refused | Use instead |
|---|---|
| `@/lib/db*`, `@/lib/apps/scoped-db` at runtime, `postgres`, `pg` | `context.db`. `import type { ScopedClient }` is fine |
| `@/lib/apps/services`, `@/lib/apps/context` | `context.services` |
| `@/lib/push/*`, `@/lib/apps/notifications`, `web-push` | Declare `notifications`, then `context.notifications.send()` |
| `@/lib/apps/env`, `@/lib/env/*`, `process` | Declare `env`, then read `context.env` |
| `@/lib/apps/http`, the network built-ins, HTTP client packages | `context.http`, bounded by `egress`, or a connector |
| `@/lib/hooks*` at runtime | `context.hooks`, or the registrar `hooks.ts` receives |
| `@/lib/apps/access`, `@/lib/apps/api-keys`, `@/lib/auth/*`, `next-auth`, `bcryptjs` | Nothing. `context.user` describes the caller |
| `@connectors/*`, `@/lib/connectors/*` at runtime (except `errors`) | `context.connectors`. Types are fine |
| `@apps/<other>/*` at runtime | Declare `consumes`, then `context.services`. Types are fine |
| Any other `next/*` | Nothing: the request, the session and the response are the platform's |
| Any other Node built-in: `fs`, `child_process`, `module`, `vm`, `worker_threads`, … | Nothing. These are what `context` exists to mediate |

**Adding an entry** is a change to `import-policy.mjs`, and the reviewer asks
four questions: does it take a slug, user or key the app could choose, rather
than using the caller's own? Does it do I/O that `context` already mediates?
Does it return a privileged object? For a `*` entry, does every export suit
every app? A yes to any of the first three means it belongs on `context`. A
test snapshots every `*` module's exports, so a new export shows up as a diff.

## What a static check can't stop

| Trick | What the scan does |
|---|---|
| `import(expr)`, `` import(`./${x}`) ``, `require(x)` | Refused (decision 7) |
| `require` or `module` aliased or reached indirectly: `const r = require`, `(0, require)`, `module.require`, `globalThis.require`, `createRequire` | Refused: both are refused wherever they appear, and `module` is a refused built-in |
| `globalThis[name]`, `eval`, `new Function` | Refused by app-escapes |
| `data:`, `file:` and `http:` specifiers | Refused: they name no file and no package |
| Code in files the scan doesn't read | Refused (decisions 5, 6 and 8) |
| Reaching a privileged object through what `context` hands over | **Not stopped.** The scan can't see where an object leads, so `context` must carry no privileged references |
| Writing to a shared module indirectly: through an alias of an imported binding, an object one returns, or a prototype reached through an instance | **Not stopped.** Only the direct forms are refused (decision 15) |
| An allowlisted function misused with valid arguments | **Not stopped.** That is what the reviewer's questions for new entries are for |

The scan makes accidental and naive use impossible to ship, and evasion
conspicuous in review. It doesn't make unreviewed code safe.

## Structure

| File | Change |
|---|---|
| `src/lib/apps/import-policy.mjs` | **new.** `PLATFORM`, `PACKAGES`, `PACKAGE_PATHS`, `BUILTINS` and the refusal messages; `resolveImport()`, `classifyImport()`, `isScannedFile()`; `checkAppSource()` (imports, loaders, `callAppRoute`, writes to shared modules) and `checkAppText()` for one file's text; the global-reference helpers the scan shares; `renderAllowlist()` for the docs |
| `scripts/app-containment.ts` | `walkApp()` replaces `listSourceFiles()`, refusing symlinks, `node_modules/` and `package.json` and reading only what `isScannedFile()` reads. Each file goes through `checkAppSource()`. `checkModule()`, `RESTRICTED_MODULES`, `isRelativeTemplate()` and the `require(…)` branch are removed. Findings are sorted by file and line, and one about a file itself prints without a line |
| `scripts/generate-project-registry.ts` | A route outside what the scan reads is refused before it is imported; `unscannedEntryPoints()` refuses an app whose pages, widgets, `hooks.ts`, jobs, syncs, services or MCP tools the scan didn't read |
| `eslint-rules/app-imports.mjs` | **new.** `mos-apps/app-imports`, a thin adapter over `checkAppText()` |
| `eslint.config.mjs` | The three `no-restricted-imports` blocks go. `mos-apps/app-imports` runs on `apps/**/*.{ts,tsx,mts,cts,js,jsx,mjs,cjs}`, and the containment block widens to the same glob (`react/no-danger` less `.cjs`, where the React plugin isn't registered). The palette, opaque-fill and `dark:` selectors become `PALETTE_SELECTORS`, spread into the raw-element block too: flat config replaces a rule's options, so that block had been dropping them for app `.tsx` files |
| `scripts/generate-import-docs.ts` | **new.** Writes `renderAllowlist()` between the markers in `docs/apps/architecture.md` |
| `scripts/app-containment.test.ts` | **new.** Fixture apps for every refused construct, with file, line and message; the allowed imports; `_template` and `wall-e` scanned directly; ESLint and the scan compared on one probe |
| `src/lib/apps/import-policy.test.ts` | **new.** Listed names exist; the `*` exports snapshot; UI primitives import only presentational modules; `verbatimModuleSyntax` stays off; the docs table matches |
| `src/lib/apps/call.ts`, `src/lib/hooks/hook-system.ts`, `src/lib/db/server.ts`, `src/lib/mcp/store.ts` | Comments say where the rule now lives |
| `apps/AGENTS.md` | Invariants 3, 9, 18 and 28 follow; invariant 31 added |
| `docs/apps/architecture.md` | "What an app can import", with the generated table; the `widgets.ts` import line rewritten |
| `docs/apps/api-routes.md`, `hooks.md`, `connectors.md`, `app-services.md`, `mcp.md`, `assets.md` | Follow the rule: `callAppRoute`'s own slug, the hook system off-limits, `@connectors/slack` in place of `@/../connectors/slack`, no `next/image` |
| `docs/security-architecture.md` | §2.3, §3.3, §4, §8 and §17 point at the import list; §24 gains "What app code can import"; §25 records that `callAppRoute` is bound to the calling app |
| `docs/secure-edge-gateway-architecture.md` | Enforcement item 3 is the import list, not tiered ESLint blocks |
| `.claude/skills/mixos/actions/app.md`, `convert.md` | What's importable, and how a converted app's dependencies and platform calls map to the list and to `context` |
| `docs/plans/20260923_0041-app-packages.md` | Marked partly superseded (decision 18) |
| `OS-UPDATES.md`, `.github/workflows/ci.yml` | Say where containment is enforced |

## Existing apps

`_template` and `wall-e` pass unchanged. Every import they make is on the list:
`defineRoute` from `@/lib/apps/route`, `callAppRoute("_template", …)` with its
own slug, `useAppQuery`, the UI primitives, types from `@/lib/hooks/types`,
`react`, `zod` and `next/link`, and `wall-e`'s relative import of its own
`lib/shared/quotes`. The generator skips `_` directories, so a test scans the
template directly, because every scaffolded app starts from it. A scaffolded
app must replace `"_template"` in `callAppRoute` with its own slug, or the build
says so.

Third-party apps that import anything else now fail, with a message naming the
replacement. That is a breaking change.

## Verification

1. `npx tsx scripts/generate-project-registry.ts`: both apps register, and the
   generated registry files are byte-identical to before.
2. `npm test`: the new suites cover each refused construct, the allowed forms
   and the agreement between ESLint and the scan.
3. Throwaway fixture apps in `apps/`, one per refused construct, each skipped
   with its file, line and message, and a fixture importing only from the list
   registers. Removed afterwards. The install path matches on the same
   `Skipping <slug>/` line, so a skip here is a `rejected-by-registry` install.
4. `npx eslint --print-config` on an app widget lists the palette and `dark:`
   selectors beside the raw-element ones.
5. `npm run typecheck`, `npm run lint`, `npm run build`.
