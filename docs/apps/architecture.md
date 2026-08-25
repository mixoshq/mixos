# Architecture

## App Structure

Create a new directory under `/apps` with the following structure:

```
apps/my-app/
  app.json          # App manifest — or use app.ts (see below)
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

## App Manifest (app.json)

The manifest declares your app's metadata, widgets, and dependencies. Every app needs one.

```json
{
  "name": "My App",
  "description": "A brief description of what this app does",
  "icon": "box",
  "authors": [
    { "name": "Jane Doe", "email": "jane@example.com" }
  ],
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
| `name` | ✅ | Display name shown in the App Manager, App Registry, and header dropdown. | `"name": "Sales Dashboard"` |
| `description` |  | Brief summary of what the app does. Shown in the App Manager and App Registry. | `"description": "Real-time sales metrics and pipeline overview"` |
| `icon` |  | A [Lucide icon](https://lucide.dev/icons/) name. Use the lowercase hyphenated name (e.g. `bar-chart`, `users`, `settings`). Defaults to `box`. | `"icon": "bar-chart"` |
| `authors` |  | Array of `{ name, email }` objects identifying the app's authors. Shown in the App Registry admin page. Optional but recommended so others know who to contact. | `"authors": [{ "name": "Jane Doe", "email": "jane@example.com" }]` |
| `connectors` |  | Array of connector names this app requires. These must match registered connectors in the Connector Registry. The platform will initialize and inject them into the app context. | `"connectors": ["hubspot", "notion"]` |
| `database` |  | Set to `true` to enable a scoped database for this app. The app gets its own isolated tables prefixed with the app slug. Migrations go in the `migrations/` directory. | `"database": true` |
| `notifications` |  | Set to `true` to enable Web Push. The app gets `context.notifications.send(...)` in its API routes and can opt users in with the SDK helper. See [Notifications](./notifications.md). | `"notifications": true` |
| `schedules` |  | Array of scheduled jobs. Each `name` maps to a handler at `jobs/<name>.ts` and sets **exactly one** cadence: `everyMinutes` (interval, min 5, multiple of 5) **or** a 5-field `cron` expression with an optional IANA `timezone` (default UTC). The platform runs them on a 5-minute scheduler. See [Scheduled Jobs](./scheduled-jobs.md). | `"schedules": [{ "name": "refresh-cache", "everyMinutes": 60 }, { "name": "digest", "cron": "0 8 * * 1" }]` |
| `global` |  | Set to `true` to make the app implicitly granted to every user. Once the app is registered, it appears as **Granted** on every user in User Management and cannot be revoked per-user. No `user_app_grants` rows are written. Users still need to install it from their App Manager. | `"global": true` |
| `widgets` |  | Array of widget definitions for the dashboard. See [Widgets](./widgets.md). |  |
| `pageVisibility` |  | Map of `pages/<key>` → an array of accepted auths (`session`, `signed-in`, `password`, `public`; `key` is API-only). Anything not listed defaults to `["session"]`. A page accepting `public` or `password` is served from `/p/<slug>/...` with no menu bar. See [Pages](./pages.md#public-and-password-protected-pages). | `"pageVisibility": { "": ["public"], "report/[id]": ["password"] }` |
| `apiVisibility` |  | Same shape, keyed by `api/<key>`. **Prefer declaring the auth on the route itself** with `defineRoute({ auth: [...] })` — it sits next to the handler and types `context.user`. Where both exist the build requires them to agree. See [API Routes](./api-routes.md#auth-a-set-not-a-fallback-chain). | `"apiVisibility": { "report": ["password"] }` |
| `roles` |  | Array of `{ key, label }` role objects, isolated to this app. `key` is stored on the user's grant and passed to `context.user.hasRole([...])`; `label` is shown in admin UI. The app itself enforces what each role can do. See [Roles & Permissions](./roles.md). | `"roles": [{ "key": "admin", "label": "Admin" }]` |
| `defaultRole` |  | Role `key` auto-assigned when a user is granted this app. Must match one of `roles[].key`. A user with no explicitly-set role resolves to this default. | `"defaultRole": "read_only"` |
| `escapes` |  | Declared exceptions to platform guarantees: `[{ rule, reason }]`. `rule` is a closed set (`raw-html`, `raw-response`, `output-validate-dev-only`, `process-env`, `raw-fetch`) — an unknown name fails the build, because a typo'd escape reads as declared while enforcing nothing. `reason` must be a sentence a reviewer can act on. Shown on the app's admin page. | `"escapes": [{ "rule": "raw-html", "reason": "Renders sanitized Markdown from the CMS connector." }]` |
| `env` |  | App-scoped settings an admin fills in, read as `context.env.<KEY>`. Keys are `SCREAMING_SNAKE_CASE`; `type` is `text` or `password` (encrypted at rest). This exists so `process.env` can be banned in app code — an app reading the raw environment can read the platform's own secrets. | `"env": [{ "key": "WEBHOOK_URL", "label": "Webhook URL", "type": "password" }]` |
| `egress` |  | Hostnames `context.http` may reach. Bare lowercase hostnames only — no scheme, port, or path, and no IP literals (an IP is the shape an SSRF payload takes and bypasses the resolve-and-recheck). `*.example.com` covers one level of subdomain. | `"egress": ["api.example.com", "*.cdn.example.com"]` |
| `sync` |  | Declarative incremental syncs. Each `name` maps to `sync/<name>.ts`. The app writes only the fetch and the mapper; the platform owns the watermark, the window tuning, the budget and the invalidation — and owns the pagination cursor, which is what makes the expired-cursor outage unrepresentable. See [Data Freshness](./data-freshness.md). | `"sync": [{ "name": "calls", "schedule": { "everyMinutes": 60 }, "source": "gong", "window": { "coldStartDays": 30, "defaultDays": 7, "minDays": 1 }, "budgetMs": 200000 }]` |
| `mcp` |  | Array of read-only tools this app exposes to the MOS MCP server, so Claude can answer questions using its data. Each `name` maps to a handler at `mcp/<name>.ts` exporting `inputSchema` (Zod) and a default handler; `description` is written for a model and is the only thing it sees when deciding to call the tool. Max 5 per app. Reachable only when the connecting user consented to this app *and* holds a grant for it. See [MCP Tools](./mcp.md). | `"mcp": [{ "name": "quarter-summary", "description": "Closed-won ARR for the current quarter." }]` |

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
