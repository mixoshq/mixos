# Hooks

## Hook Scoping

Hooks are scoped by the app's folder name using a `:` separator. Core platform hooks use hyphens and are never prefixed (e.g., `user-login`). App hooks are automatically prefixed with the folder name of your app.

- **Core hooks** (`init`, `user-login`, etc.) — no prefix, accessible to all apps
- **App hooks** — auto-prefixed with your app folder name. `doAction("ready")` in `apps/_example` fires as `_example:ready`
- **Listening** — any app can listen to any hook by using the full name, e.g. `addAction("_example:ready", fn)`
- **Firing** — apps can only fire their own custom hooks (auto-prefix prevents firing another app's hooks) and core hooks

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
| `init` | Fires once when MOS initializes. | (none) |
| `user-login` | Fires when a user logs in via SSO. | `{ id, email }` |
| `user-sync` | Fires when a user's profile is synced from SSO. | `{ id, email, name }` |

### Filters

| Name | Description | Args |
| --- | --- | --- |
| `user-display-name` | Transform how a user's name is displayed across the platform. | `displayName: string, user: { id, email }` |

## App Hooks

Registered apps may expose their own hooks. The registry auto-counts `.doAction(...)` and `.applyFilters(...)` calls in your source and populates `hookCounts` on the manifest. App hooks are always prefixed with the app slug, e.g. `my-app:<action-name>`.
