# Hooks

## Hook Scoping

Hooks are scoped by the app's folder name using a `:` separator. Core platform hooks use hyphens and are never prefixed (e.g., `user-login`). App hooks are automatically prefixed with the folder name of your app.

- **Core hooks** (`init`, `user-login`, etc.) — no prefix, accessible to all apps
- **App hooks** — auto-prefixed with your app folder name. `doAction("ready")` in `apps/_example` fires as `_example:ready`
- **Listening across apps requires two-sided consent.** An emitter declares who may listen; a listener declares what it listens for. Both halves are build-enforced and default-deny.
- **Firing** — apps can only fire their own custom hooks (auto-prefix prevents firing another app's hooks) and core hooks

## Cross-app hooks: two-sided consent

Listening to another app's hook used to need nothing at all — any app could
`addAction("other-app:thing", fn)` with the full prefixed name and observe
another app's events. [App Services](app-services.md) required two-sided consent
for a *pull*; a *push* had none. It does now, and the shape is deliberately the
same:

```jsonc
// apps/emitter/app.json — the emitter names its consumers
"emits": [
  { "name": "thing-happened", "description": "A thing happened.", "consumers": ["reporting"] }
]
```

```jsonc
// apps/reporting/app.json — the listener declares the dependency
"listensTo": [{ "app": "emitter", "hook": "thing-happened" }]
```

Either half missing fails the build, naming the app and the hook. `"consumers":
"*"` opens a hook to any app that declares the dependency — still a declaration,
just a broad one.

This applies to **cross-app** hooks only. An app firing and listening to its own
hooks, and any app listening to a **core** hook (`init`, `user-login`), needs no
declaration.

## The hook entrypoint: `hooks.ts`

An app may ship `apps/<slug>/hooks.ts`, default-exporting a function that takes
a registrar:

```ts
// apps/my-app/hooks.ts
import type { HookRegistrar } from "@/lib/hooks";

export default function register(hooks: HookRegistrar) {
  hooks.addFilter("brand-name", () => "Acme Workspace");
}
```

The platform imports every app's entrypoint before it dispatches a hook that
needs one, and calls it with a registrar attributed to your app. Registering in
a page or route instead only works on requests that happen to import that file.
On `/login`, for one, nothing imports app code, so a listener registered there
never runs. In development, saving an existing `hooks.ts` replaces your
registrations on the next request. Adding `hooks.ts` for the first time, or
changing `branding` in `app.json`, changes the generated registry, so restart
`npm run dev`, which regenerates it.

`hooks.ts` runs server-side and is held to the same import rules as the rest of
`apps/**`: no connectors, no database.

**Brand hooks must be registered here.** The other hooks can still be
registered elsewhere for now.

## Using Hooks in Your App

Import the hook system from anywhere in your app — pages, widgets, API routes, or utility files. There are four methods:

- `hooks.addAction(name, callback, priority?)` — register a callback for an action hook
- `hooks.addFilter(name, callback, priority?)` — register a callback for a filter hook
- `hooks.doAction(name, ...args)` — fire an action, executing all registered callbacks
- `hooks.applyFilters(name, value, ...args)` — pipe a value through all registered filter callbacks

```ts
// In a page, widget, or any file in your app
import { hooks } from "@/lib/hooks";

// Listen to a core action (no prefix)
hooks.addAction("user-login", async (user) => {
  console.log(`[my-app] user logged in: ${user.email}`);
});

// Modify data flowing through a core filter (no prefix)
hooks.addFilter("user-display-name", async (name, user) => {
  return `${name} (VIP)`;
});

// Fire a custom action — auto-prefixed as "my-app:ready"
await hooks.doAction("ready");

// Listen to another app's custom hook (use full prefixed name)
hooks.addAction("other-app:data-updated", async (data) => {
  console.log("other-app updated:", data);
});
```

## Available Core Hooks

### Actions

| Name | Description | Args |
| --- | --- | --- |
| `init` | Fires once when MixOS initializes. | (none) |
| `user-login` | Declared, but **nothing currently fires it.** Its trigger was the SSO sign-in callback, which no longer exists. | `{ id, email }` |
| `user-sync` | Declared, but **nothing currently fires it.** Its trigger was the SSO profile sync, which no longer exists. | `{ id, email, name }` |

### Filters

| Name | Description | Args |
| --- | --- | --- |
| `user-display-name` | Transform how a user's name is displayed across the platform. | `displayName: string, user: { id, email }` |
| `brand-name` | The product name in the menu bar, on the sign-in page, in the tab title and as the installed PWA's name. **Bounded**, see [Brand hooks](#brand-hooks). | `name: string` |
| `menu-bar-logo` | The mark beside the name in the menu bar. **Bounded.** | `logo: { src, width, height } \| null` |
| `login-logo` | The mark above the name on the sign-in page. **Bounded.** | `logo: { src, width, height } \| null` |

## Brand hooks

`brand-name`, `menu-bar-logo` and `login-logo` let an app change what the
install calls itself and the marks beside that name. They reach every user,
signed in or not, so they are tighter than an ordinary filter.

**Declare them.** List the hooks in `app.json` with a reason. The admin sees it
on the app's details dialog before activating it:

```jsonc
"branding": {
  "hooks": ["brand-name", "menu-bar-logo"],
  "reason": "Brands this install as Acme for the Acme rollout.",
  "logos": ["branding/acme-mark.png"]
}
```

The build fails on any of these:
- a brand hook registered anywhere but `hooks.ts`;
- a brand hook registered there but not declared;
- a hook declared but never registered;
- a logo that is not a `.png`, `.jpg` or `.webp` directly under `branding/`.

**Return what the platform accepts.** After each filter the platform
re-validates the result. If the result is not acceptable, the platform keeps the
previous value and logs a warning:

| Hook | You may return |
| --- | --- |
| `brand-name` | A string of 1–40 characters on one line. |
| `menu-bar-logo`, `login-logo` | `null` to show no mark; the value you were given, to pass; or the `file` of one of **your own** declared logos, e.g. `"branding/acme-mark.png"`. |

There is no way to return a URL. Every mark on the sign-in page is a file the
build published, at its measured size.

**Every slot has one second, shared.** All of a slot's filters together get one
second per request. A filter that throws, or is still running when the second
runs out, is skipped. So is any filter after it. The platform logs each distinct
problem once per process, and again after a `hooks.ts` is reloaded.

**One bad request does not change the brand.** If any filter for a slot failed
on a request, the platform serves the last value that slot resolved to without
a failure, as long as the theme and the active apps are the same. A filter that
fails every time never sets that value, so its result is at least consistent.
The same applies when the database can't be reached to check which apps are
active.

**Each page runs only the filters it needs.** The sign-in page never runs a
`menu-bar-logo` filter. Signed-in pages run `login-logo` only while the welcome
tour is showing.

```ts
// apps/my-app/hooks.ts
export default function register(hooks: HookRegistrar) {
  hooks.addFilter("brand-name", () => "Acme Workspace");
  hooks.addFilter("menu-bar-logo", () => "branding/acme-mark.png");
}
```

**The theme comes first.** Each slot resolves on its own:

1. If the active theme's `theme.json` claims the slot under `branding`, the
   theme's value is used and no app filter runs for that slot.
2. Otherwise the filters of **active** apps run in a fixed order: by priority,
   then by app slug. They start from "MixOS" for the name and from the theme's
   `assets.logo` for both marks. Each filter gets the previous one's value, so
   when two apps filter the same slot, the last one's value is shown. The Apps
   admin page warns when more than one active app filters a slot.

A mark keeps its own aspect ratio. It is drawn 23px high in the menu bar (at most
160px wide) and 69px high on the sign-in page (at most 240px wide).

## App Hooks

Registered apps may expose their own hooks. The registry auto-counts `.doAction(...)` and `.applyFilters(...)` calls in your source and populates `hookCounts` on the manifest. App hooks are always prefixed with the app slug, e.g. `my-app:<action-name>`.
