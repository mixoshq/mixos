# Architecture

## App Structure

Create a new directory under `/apps` with the following structure:

```
apps/my-app/
  app.json          # App manifest — or use app.ts (see below)
  README.md         # Long-form description, published on the public listing (optional)
  pages/
    Main.tsx        # Root page at /apps/my-app
    settings/
      Main.tsx      # Nested page at /apps/my-app/settings
  widgets/
    my-widget.tsx   # Dashboard widget component
  api/
    hello/
      route.ts      # API handler at /api/apps/my-app/hello
  migrations/
    001_init.sql    # Database migrations (optional)
```

**Templates:** any app directory whose name starts with an underscore (e.g. `apps/_template/`) is treated as a template and skipped by the registry. Use this for starter scaffolds you want to keep in the repo without exposing to users.

### Long-Form Description (README.md)

A `README.md` beside `app.json` is the app's long-form description: what it does, who it is for, what it needs to work. It is **optional**, no manifest field points at it — the path is the convention — and nothing fails a build over its absence.

The manifest's `description` is specified as a brief one-liner, which is the right length for a tile and too short for a page. So [mixos.org](https://mixos.org) reads this file when it publishes the app and renders it as the prose section of the public listing at `mixos.org/extend/apps/<slug>`. Where the file is absent, the listing falls back to `description`.

Write it for a stranger deciding whether to install: what the app does, what it needs (connectors, `env` settings an admin fills in, a database), and anything surprising about how it behaves — scheduled jobs, `egress` destinations, declared `escapes`. Leave out install instructions; the catalogue owns those.

#### What the renderer does to it

The listing renders GitHub-Flavoured Markdown and then sanitizes the result. These are limits of that renderer, not style advice — a README that ignores them publishes a listing with dead links and missing images, and the author never sees it, because the same file renders fine on GitHub.

| Rule | Why |
| --- | --- |
| **Raw HTML is stripped entirely.** No `<br>`, `<img>`, `<details>` — no inline HTML of any kind. | It is dropped before it ever becomes an element, so the content inside it disappears too, not just the tag. |
| **Links must be absolute `https://`** (or `mailto:`). | Relative links resolve against mixos.org, not against your GitHub repo, so `./setup.md` is a broken link on the listing. |
| **Images must be absolute `https://` URLs.** | Same resolution rule: a relative `./screenshot.png` 404s on the listing page. |
| Headings are re-levelled automatically. | Whatever the shallowest heading in the file is becomes `<h2>`, with relative depth preserved — so a README that opens with `#` and one that opens with `##` both render correctly. Nothing to plan around. |

One thing to leave out: the listing page already displays the app's name, `tagline`, `license`, `authors`, `keywords`, and its `appUrl` / `appSupportUrl` links. A README that repeats them renders as duplication.

## App Manifest (app.json)

The manifest declares your app's metadata, widgets, and dependencies. Every app needs one.

```json
{
  "name": "My App",
  "description": "A brief description of what this app does",
  "tagline": "The one-line version, for a listing card",
  "icon": "box",
  "authors": [
    { "name": "Jane Doe", "email": "jane@example.com" }
  ],
  "keywords": ["reporting", "sales"],
  "license": "MPL-2.0",
  "appUrl": "https://example.com/my-app",
  "appSupportUrl": "https://example.com/my-app/issues",
  "connectors": [],
  "database": false,
  "roles": [
    { "key": "admin", "label": "Admin" },
    { "key": "read_only", "label": "Read-Only" }
  ],
  "defaultRole": "read_only",
  "widgets": [
    {
      "name": "My Widget",
      "description": "Shows something useful",
      "defaultSize": { "w": 3, "h": 2 },
      "minSize": { "w": 2, "h": 2 },
      "component": "widgets/my-widget.tsx"
    }
  ]
}
```

`roles` and `defaultRole` are optional — omit them for apps that don't need in-app permission tiers. See [Roles & Permissions](./roles.md).

### Field Reference

| Field | Required | Description | Example |
| --- | --- | --- | --- |
| `name` | ✅ | Display name shown in the App Manager, the Apps admin page, and the header dropdown. | `"name": "Sales Dashboard"` |
| `description` |  | Brief summary of what the app does. Shown in the App Manager and the Apps admin page. | `"description": "Real-time sales metrics and pipeline overview"` |
| `tagline` |  | The one-line version of `description`, for surfaces with room for a sentence and not a paragraph — a listing card, a tile subtitle. Max 100 characters, single line. Where it is absent, `description` is used instead; setting only one of the two is the normal case. | `"tagline": "Sales metrics, live"` |
| `icon` |  | A [Lucide icon](https://lucide.dev/icons/) name. Use the lowercase hyphenated name (e.g. `bar-chart`, `users`, `settings`). Defaults to `box`. | `"icon": "bar-chart"` |
| `authors` |  | Array of `{ name, email }` objects identifying the app's authors. Shown in the Apps admin page. Optional but recommended so others know who to contact. | `"authors": [{ "name": "Jane Doe", "email": "jane@example.com" }]` |
| `keywords` |  | Search and browse terms for the catalogue. Lowercase words, separated by single spaces or hyphens; max 10, no duplicates. Lowercase is enforced because a facet list dedupes on the exact string — `Gmail` next to `gmail` renders as two filters for one idea and splits the results between them. | `"keywords": ["email", "time tracking"]` |
| `license` |  | SPDX identifier or expression for the app's licence, or `UNLICENSED` for something not redistributable. Validated as a shape, not against the full SPDX list — which still rejects the mistake worth rejecting: prose. `"MIT License"` fails the build; `"MIT"` passes. | `"license": "MPL-2.0"` |
| `appUrl` |  | Where the app lives for someone who wants to read about it — a homepage, a docs site, a repository directory. Absolute `https://` only: these render as links on pages served over https, and an author never sees the downgrade because their own dev server is http. | `"appUrl": "https://example.com/my-app"` |
| `appSupportUrl` |  | Where a user takes a problem with this app — an issue tracker, a support page. Same `https://` rule. Kept separate from `appUrl` because "read about it" and "something is broken" are different destinations, and collapsing them sends bug reports to a marketing page. | `"appSupportUrl": "https://example.com/my-app/issues"` |
| `connectors` |  | Array of connector names this app requires. These must match registered connectors in the Connector Registry. The platform will initialize and inject them into the app context. | `"connectors": ["hubspot", "notion"]` |
| `database` |  | Set to `true` to enable a scoped database for this app. The app gets its own isolated tables prefixed with the app slug. Migrations go in the `migrations/` directory. | `"database": true` |
| `notifications` |  | Set to `true` to enable Web Push. The app gets `context.notifications.send(...)` in its API routes and can opt users in with the SDK helper. See [Notifications](./notifications.md). | `"notifications": true` |
| `schedules` |  | Array of scheduled jobs. Each `name` maps to a handler at `jobs/<name>.ts` and sets **exactly one** cadence: `everyMinutes` (interval, min 5, multiple of 5) **or** a 5-field `cron` expression with an optional IANA `timezone` (default UTC). The platform runs them on a 5-minute scheduler. See [Scheduled Jobs](./scheduled-jobs.md). | `"schedules": [{ "name": "refresh-cache", "everyMinutes": 60 }, { "name": "digest", "cron": "0 8 * * 1" }]` |
| `global` |  | Set to `true` to make the app implicitly granted to every user. It appears as **Granted** on every user's **App Access** tab in Users and cannot be revoked per-user. No `user_app_grants` rows are written. Users still need to install it from their App Manager. | `"global": true` |
| `widgets` |  | Array of widget definitions for the dashboard. See [Widgets](./widgets.md). |  |
| `pageVisibility` |  | Map of `pages/<key>` → an array of accepted auths (`session`, `signed-in`, `password`, `public`; `key` is API-only). Anything not listed defaults to `["session"]`. A page accepting `public` or `password` is served from `/p/<slug>/...` with no menu bar. See [Pages](./pages.md#public-and-password-protected-pages). | `"pageVisibility": { "": ["public"], "report/[id]": ["password"] }` |
| `apiVisibility` |  | Same shape, keyed by `api/<key>`. **Prefer declaring the auth on the route itself** with `defineRoute({ auth: [...] })` — it sits next to the handler and types `context.user`. Where both exist the build requires them to agree. See [API Routes](./api-routes.md#auth-a-set-not-a-fallback-chain). | `"apiVisibility": { "report": ["password"] }` |
| `roles` |  | Array of `{ key, label }` role objects, isolated to this app. `key` is stored on the user's grant and passed to `context.user.hasRole([...])`; `label` is shown in admin UI. The app itself enforces what each role can do. See [Roles & Permissions](./roles.md). | `"roles": [{ "key": "admin", "label": "Admin" }]` |
| `defaultRole` |  | Role `key` auto-assigned when a user is granted this app. Must match one of `roles[].key`. A user with no explicitly-set role resolves to this default. | `"defaultRole": "read_only"` |
| `escapes` |  | Declared exceptions to platform guarantees: `[{ rule, reason }]`. `rule` is a closed set (`raw-html`, `raw-response`, `output-validate-dev-only`, `process-env`, `raw-fetch`) — an unknown name fails the build, because a typo'd escape reads as declared while enforcing nothing. `reason` must be a sentence a reviewer can act on. Shown on the app's admin page. | `"escapes": [{ "rule": "raw-html", "reason": "Renders sanitized Markdown from the CMS connector." }]` |
| `env` |  | App-scoped settings an admin fills in, read as `context.env.<KEY>`. Keys are `SCREAMING_SNAKE_CASE`; `type` is `text` or `password` (encrypted at rest). This exists so `process.env` can be banned in app code — an app reading the raw environment can read the platform's own secrets. | `"env": [{ "key": "WEBHOOK_URL", "label": "Webhook URL", "type": "password" }]` |
| `egress` |  | Hostnames `context.http` may reach. Bare lowercase hostnames only — no scheme, port, or path, and no IP literals (an IP is the shape an SSRF payload takes and bypasses the resolve-and-recheck). `*.example.com` covers one level of subdomain. | `"egress": ["api.example.com", "*.cdn.example.com"]` |
| `sync` |  | Declarative incremental syncs. Each `name` maps to `sync/<name>.ts`. The app writes only the fetch and the mapper; the platform owns the watermark, the window tuning, the budget and the invalidation — and owns the pagination cursor, which is what makes the expired-cursor outage unrepresentable. See [Data Freshness](./data-freshness.md). | `"sync": [{ "name": "calls", "schedule": { "everyMinutes": 60 }, "source": "gong", "window": { "coldStartDays": 30, "defaultDays": 7, "minDays": 1 }, "budgetMs": 200000 }]` |
| `emits` |  | Hooks this app fires and who may listen: `[{ name, description?, consumers }]`. `consumers` is an allowlist of app slugs or `"*"`. Cross-app hook listening is two-sided consent, default-deny, build-enforced — see [Hooks](./hooks.md#cross-app-hooks-two-sided-consent). | `"emits": [{ "name": "deal-won", "consumers": ["reporting"] }]` |
| `listensTo` |  | Hooks from other apps this app listens for: `[{ app, hook }]`. The emitter must allow you, or the build fails. | `"listensTo": [{ "app": "sales", "hook": "deal-won" }]` |
| `mcp` |  | Array of read-only tools this app exposes to the MixOS MCP server, so Claude can answer questions using its data. Each `name` maps to a handler at `mcp/<name>.ts` exporting `inputSchema` (Zod) and a default handler; `description` is written for a model and is the only thing it sees when deciding to call the tool. Max 5 per app. Reachable only when the connecting user consented to this app *and* holds a grant for it. See [MCP Tools](./mcp.md). | `"mcp": [{ "name": "quarter-summary", "description": "Closed-won ARR for the current quarter." }]` |

> **Tool-written:** `lastUpdated` lives in `app.json` as an ISO 8601 date-time (e.g. `"2026-08-24T03:21:40.694Z"`) and is stamped automatically: `.githooks/pre-commit` runs [`scripts/stamp-updated.ts`](../../scripts/stamp-updated.ts), which rewrites the date on every app with a file in the commit and re-stages the manifest. It records when the app last changed, so a dependency bump or a formatting pass inside the app moves it too. A commit that touches only `lastUpdated` never re-stamps. Don't edit it by hand; an invalid value fails the build. An `app.ts` manifest is warned about, never rewritten — the script won't edit arbitrary TypeScript, so add the line to the default export yourself.

> **Per-app roles:** the `roles` / `defaultRole` fields let an app define its own access tiers and gate features with `context.user.hasRole([...])`. See the dedicated [Roles & Permissions](./roles.md) guide.

### TS Manifests (app.ts)

For manifests that benefit from shared helpers — most commonly, widget config fields that follow a common pattern (title / selection / display mode / group-by) — you can use `app.ts` instead of `app.json`. The default export has the same shape as the JSON manifest; the only difference is that you can `import` helpers from across the codebase.

```ts
// apps/my-app/app.ts
import {
  titleField,
  selectionField,
  displayModeField,
  groupByField,
} from "@/lib/apps/widget-config-presets";

export default {
  name: "My App",
  description: "…",
  icon: "star",
  widgets: [
    {
      name: "My Widget",
      description: "…",
      component: "widgets/my-widget.tsx",
      config: [
        titleField({ default: "My Widget" }),
        selectionField({ key: "itemIds", label: "Items to show" }),
        displayModeField({ modes: ["list", "grid"] }),
        groupByField({ label: "Group by team" }),
      ],
    },
  ],
};
```

**Rules:**
- When both `app.ts` and `app.json` exist, `app.ts` wins. Delete the JSON after migrating.
- The default export must be plain data — the generator serializes it into the registry with `JSON.stringify`. Functions, class instances, and React nodes won't survive. Preset helpers return plain data, so they're safe.
- Imports resolve through the project's tsconfig paths (`@/*`, `@apps/*`, `@connectors/*`). Any import that works in runtime TS works here.

See [`src/lib/apps/widget-config-presets.ts`](../../src/lib/apps/widget-config-presets.ts) for the list of built-in presets and [Widgets → Config Presets](./widgets.md#config-presets) for when to use which.
