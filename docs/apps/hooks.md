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

## App Hooks

Registered apps may expose their own hooks. The registry auto-counts `.doAction(...)` and `.applyFilters(...)` calls in your source and populates `hookCounts` on the manifest. App hooks are always prefixed with the app slug, e.g. `my-app:<action-name>`.
