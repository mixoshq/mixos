# Roles & Permissions

App grants are **binary** at the platform level — a user either has the app or they don't. For finer-grained, in-app permissions (e.g. "admin" vs "read-only", "editor" vs "approver"), an app declares its own **roles**.

Roles are **isolated to your app**: the role keys mean nothing outside it, and the platform provides only the membership check. *Your app* decides what each role is allowed to do — MOS never enforces a policy on your behalf.

## Declaring roles

Add `roles` and an optional `defaultRole` to `app.json`. Each role is a `{ key, label }` object — `key` is the stable identifier stored on the grant and passed to `hasRole()`; `label` is the human-readable name shown in admin UI.

```json
{
  "name": "Example",
  "roles": [
    { "key": "admin", "label": "Admin" },
    { "key": "read_only", "label": "Read-Only" }
  ],
  "defaultRole": "read_only"
}
```

Rules enforced by the registry generator (a violation aborts the build):

- Each role needs a non-empty string `key` and `label`.
- Role `key`s must be unique within the app.
- `defaultRole`, if set, must match one of the declared `key`s.
- Declaring `defaultRole` without any `roles` is an error.

## How a user gets a role

- When an admin grants the app to a user (User Management → expand a user → **Grant**), the user receives `defaultRole`.
- An admin can change a user's role anytime via the **role dropdown** next to the app in User Management.
- A user with **no explicitly-set role resolves to `defaultRole`**. This covers pre-existing grants (no migration/backfill needed) and every user of a `global` app (which writes no grant rows until a role is assigned).

One role per user per app. Assigning a role to a `global` app writes a grant row that carries *only* the role — it does not change who can access the app (global access still applies to everyone).

## Declaring roles on a route

**Declare them; do not check them.** A route names the roles that satisfy it and
the platform enforces the gate before your handler runs:

```ts
export const POST = defineRoute({
  auth: ["session"],
  roles: ["admin"],          // any one of these satisfies the route
  input: z.object({ /* … */ }),
  output: z.object({ ok: z.boolean() }),
  handler: async (context, input) => {
    // Reached only by a user holding "admin".
    return { ok: true };
  },
});
```

The build cross-checks each name against the app's declared `roles`, so a typo is
a build failure rather than a route that 403s forever. Enforcement is
default-deny and lives in one place (`runRoute`), so no dispatch path can reach a
handler having skipped it.

**A platform admin does not bypass an app role.** `isAdmin` says nothing about
what your app's "approver" means; grant the role instead.

## Checking roles inside a handler

`context.user.hasRole([...])` remains, for branching *within* a route the caller
already reached — which fields to include, whether to show a total:

```ts
const rows = base.map((r) =>
  context.user.hasRole(["finance"]) ? r : { ...r, cost: null },
);
```

`context.user.roles` is also available (the user's role keys for this app, currently at most one) if you need the value rather than a check.

### `hasRole` is pure

`hasRole` reflects only assigned app roles. It does **not** treat platform admins (`context.user.isAdmin`) specially. If you want platform admins to bypass a role check, combine them yourself:

```ts
if (!(context.user.isAdmin || context.user.hasRole(["admin"]))) {
  return NextResponse.json({ error: "Forbidden" }, { status: 403 });
}
```

### Empty / no-role cases

- An app that declares no `roles` → `hasRole([...])` always returns `false`. Gate optional features behind it safely; existing apps are unaffected.
- `hasRole([])` (empty array) → `false`.
- **Public / password routes** run with `context.user === null` and therefore have no roles. Never read roles from a public handler — type the handler against `PublicAppContext` so the compiler enforces it.

## Where enforcement belongs

Always enforce on the **server** (API routes). Hiding a button in a widget is a UX nicety, not a security boundary — a widget can't import `context` and must not be trusted to gate access. Put every real check in the route handler that returns the data or performs the action.
