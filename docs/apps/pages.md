# Pages

## Overview

Pages are full-screen views that render when a user opens your app. They live in the `pages/` directory of your app and are accessed at `/apps/your-app-folder`. Pages support unlimited nesting for complex multi-view apps.

## Root Page

`pages/Main.tsx` is the entry point that renders at `/apps/your-app-folder`. Pages are optional: an app with only widgets has no `pages/` directory.

```tsx
// apps/my-app/pages/Main.tsx

export default function MyAppPage() {
  return (
    <div className="p-8">
      <h1 className="text-2xl font-bold">My App</h1>
      <p>This is the root page of your app.</p>
    </div>
  );
}
```

## Nested Pages

Create subdirectories inside `pages/` with their own `Main.tsx` to add nested routes. The folder structure maps directly to URL paths.

```
apps/my-app/
  pages/
    Main.tsx              → /apps/my-app
    settings/
      Main.tsx            → /apps/my-app/settings
    reports/
      Main.tsx            → /apps/my-app/reports
      monthly/
        Main.tsx          → /apps/my-app/reports/monthly
```

Each `Main.tsx` is a standalone React component. There is no shared layout between nested pages — each page controls its own full layout. Paths are literal: there are no dynamic segments (a folder named `[id]` is not one), and a page receives no props.

## Navigation Between Pages

Use standard Next.js `Link` components to navigate between your app's pages.

```tsx
// apps/my-app/pages/Main.tsx
import Link from "next/link";

export default function MyAppPage() {
  return (
    <div className="p-8">
      <h1 className="text-2xl font-bold">My App</h1>
      <nav className="mt-4 flex gap-4">
        <Link href="/apps/my-app/settings">Settings</Link>
        <Link href="/apps/my-app/reports">Reports</Link>
      </nav>
    </div>
  );
}
```

## Server vs Client Components

Pages are server components by default. Add `"use client"` at the top if you need client-side interactivity (state, effects, event handlers). You can also mix server and client components using standard React patterns. A server page gets its data from its own routes with `callAppRoute`; see [API Routes](./api-routes.md#server-components).

```tsx
// apps/my-app/pages/reports/Main.tsx — a server component (the default)
import { callAppRoute } from "@/lib/apps/call";

export default async function ReportsPage() {
  const { reports } = await callAppRoute<{ reports: Report[] }>("my-app", "GET /reports");
  return <ReportList reports={reports} />;
}
```

```tsx
// apps/my-app/pages/settings/Main.tsx — a client component, for interactivity
"use client";

import { useState } from "react";
import { Field } from "@/components/ui/field";
import { Input } from "@/components/ui/input";

export default function SettingsPage() {
  const [value, setValue] = useState("");
  return (
    <Field label="Display name">
      {(field) => (
        <Input {...field} value={value} onChange={(e) => setValue(e.target.value)} />
      )}
    </Field>
  );
}
```

## Skeleton Loading States

Client pages that fetch data must show skeleton placeholders while loading — never bare spinners or "Loading..." text. Use the shared `Skeleton` component and mirror the shape of the final layout.

```tsx
"use client";

import { useEffect, useState } from "react";
import { createAppClient } from "@/lib/apps/sdk";
import { Skeleton } from "@/components/ui/skeleton";
import { TableSkeleton } from "@/components/ui/data-table";

export default function MyPage() {
  const [data, setData] = useState<Data | null>(null);
  const [loading, setLoading] = useState(true);

  useEffect(() => {
    createAppClient("my-app")
      .get<Data>("/items")
      .then(setData)
      .finally(() => setLoading(false));
  }, []);

  if (loading) {
    return (
      <div className="p-6">
        <Skeleton className="h-8 w-48 mb-6" />
        <TableSkeleton columns={3} rows={6} />
      </div>
    );
  }

  return <div>{/* render data */}</div>;
}
```

**Guidelines:**
- Match the page's final layout: same padding, same card structure, same number of columns
- For data tables, render 6-8 skeleton rows inside the same card/border treatment
- For header areas, include skeleton blocks for the title and action buttons
- For stat cards or summary sections, mirror the grid with skeleton card shapes
- Keep the skeleton layout stable so the page doesn't jump when data arrives

## Public and Password-Protected Pages

Pages are **private by default** — they live under `/apps/<slug>/...` and require a signed-in user who holds the app's grant (a `global` app is granted to everyone). To change who can open a page, declare it in `app.json` under `pageVisibility`:

```json
{
  "pageVisibility": {
    "": ["public"],
    "report": ["password"],
    "directory": ["signed-in"]
  }
}
```

Keys are POSIX paths relative to `apps/<slug>/pages/`, without leading or trailing slashes. The empty string `""` refers to the root page (`pages/Main.tsx`). Each value is a non-empty array of the auths the page accepts: `session`, `signed-in`, `password` or `public` (`key` is API-only, and the build rejects it on a page). Anything not listed accepts `["session"]`. The registry generator verifies every key resolves to a real `Main.tsx` on disk and aborts the build otherwise.

### Where they're served

| Auth | URL | Layout | Who can open it |
| --- | --- | --- | --- |
| `session` (default) | `/apps/<slug>/...` | Full MixOS chrome (menu bar, providers) | A signed-in user who holds the app's grant |
| `signed-in` | `/apps/<slug>/...` | Full MixOS chrome (menu bar, providers) | Any signed-in user, grant or not |
| `public` | `/p/<slug>/...` | **Minimal — no menu bar, no chrome** | Anyone |
| `password` | `/p/<slug>/...` | **Minimal — no menu bar, no chrome** (unlock form shown first) | App-wide password set by the installer; 24h cookie |

Both `public` and `password` pages render on the same minimal shell. Once a visitor enters the correct password, the rendered page is indistinguishable from a fully public one.

### What page code can rely on

Public and password-protected pages run as **server components without a logged-in user**:

- There is no `dbUser` in the rendering environment. Don't call `requireServerSession()` or read `auth()` — they will redirect.
- Get data the way any server page does: from your own routes, with `callAppRoute` (see [API Routes](./api-routes.md#server-components)). It resolves the caller from the tiers `/api/apps/<slug>/…` serves, `session`, `signed-in` and `public`, so for a visitor without a session the route must accept `public`. A route that accepts `public` answers anyone at `/api/p/<slug>/…`, whatever the visibility of the page that calls it.
- A route that accepts only `password` or `key` can't be called from a page: `callAppRoute` doesn't resolve those tiers, and `createAppClient` always calls `/api/apps/<slug>/…`, which doesn't serve them.
- Pages are served with `<meta name="robots" content="noindex, nofollow">` by default. They are reachable from the public internet but won't be crawled.
- The platform CSP currently sets `frame-ancestors 'self'`, so public pages cannot be embedded in third-party iframes. Loosening this is a future, per-app opt-in.

### Password gate UX

When a visitor opens a `password` page without a valid unlock cookie:

1. Server checks whether `app_passwords` has a row for this slug. If not, the page renders an **"App not available"** notice (fail-closed) and writes a loud server log telling the admin to set a password.
2. Otherwise it renders the password form. Wrong passwords are rate-limited per IP per app (5 attempts in 15 minutes → 1 hour lockout) before bcrypt even runs.
3. On success, two `__Secure` `HttpOnly` cookies are set (one scoped to `/p/<slug>`, one to `/api/p/<slug>`), valid for 24h with no refresh. Visitors can navigate between password-protected pages and APIs in the same app without re-entering the password.

### Anti-patterns

- Don't reference `context.user` or any logged-in-user-only API from a public/password page.
- Don't render visitor input as markup. `dangerouslySetInnerHTML` and the other HTML sinks fail the build in any app; formatted text goes through `Markdown` (`@/components/ui/markdown`), which drops raw HTML. Public pages are reachable by anyone, so XSS is more dangerous here than on authenticated surfaces.
- Don't bake credentials, secrets, or another user's data into a public page's HTML — even if the user only navigated there logged in, the page is being served to anonymous traffic.
- Don't rely on a `password` page being "private". The visitor only had to know one password; treat the surface as semi-trusted.
