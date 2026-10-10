# Pages

## Overview

Pages are full-screen views that render when a user opens your app. They live in the `pages/` directory of your app and are accessed at `/apps/your-app-folder`. Pages support unlimited nesting for complex multi-view apps.

## Root Page

Every app needs a `pages/Main.tsx` file. This is the entry point that renders at `/apps/your-app-folder`.

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

Each `Main.tsx` is a standalone React component. There is no shared layout between nested pages — each page controls its own full layout.

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

Pages are server components by default. Add `"use client"` at the top if you need client-side interactivity (state, effects, event handlers). You can also mix server and client components using standard React patterns.

```tsx
// Server component (default) — can fetch data directly
export default async function ReportsPage() {
  const data = await fetchReports();
  return <ReportTable data={data} />;
}

// Client component — for interactivity
"use client";
export default function SettingsPage() {
  const [value, setValue] = useState("");
  return <input value={value} onChange={(e) => setValue(e.target.value)} />;
}
```

## Skeleton Loading States

Client pages that fetch data must show skeleton placeholders while loading — never bare spinners or "Loading..." text. Use the shared `Skeleton` component and mirror the shape of the final layout.

```tsx
"use client";

import { useEffect, useState } from "react";
import { createAppClient } from "@/lib/apps/sdk";
import { Skeleton } from "@/components/ui/skeleton";

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
        <div className="rounded-lg border border-border bg-card">
          {Array.from({ length: 6 }, (_, i) => (
            <div key={i} className="flex items-center gap-4 border-b px-4 py-3">
              <Skeleton className="h-4 flex-1" />
              <Skeleton className="h-4 w-24" />
              <Skeleton className="h-4 w-16" />
            </div>
          ))}
        </div>
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

Pages are **private by default** — they live under `/apps/<slug>/...` and require a signed-in user with the app installed. To make a page reachable without sign-in, declare it in `app.json` under `pageVisibility`:

```json
{
  "pageVisibility": {
    "": "public",
    "report/[id]": "password",
    "admin": "private"
  }
}
```

Keys are POSIX paths relative to `apps/<slug>/pages/`, without leading or trailing slashes. The empty string `""` refers to the root page (`pages/Main.tsx`). Anything not listed defaults to `"private"`. The registry generator verifies every key resolves to a real `Main.tsx` on disk and aborts the build otherwise.

### Where they're served

| Visibility | URL | Layout | Auth |
| --- | --- | --- | --- |
| `private` (default) | `/apps/<slug>/...` | Full MixOS chrome (menu bar, providers) | Signed-in user with the app installed |
| `public` | `/p/<slug>/...` | **Minimal — no menu bar, no chrome** | None |
| `password` | `/p/<slug>/...` | **Minimal — no menu bar, no chrome** (unlock form shown first) | App-wide password set by the installer; 24h cookie |

Both `public` and `password` pages render on the same minimal shell. Once a visitor enters the correct password, the rendered page is indistinguishable from a fully public one.

### What page code can rely on

Public and password-protected pages run as **server components without a logged-in user**:

- There is no `dbUser` in the rendering environment. Don't call `requireServerSession()` or read `auth()` — they will redirect.
- Calls from these pages to your own API routes need to target the **public API surface** (`/api/p/<slug>/...`) and the API route itself must be declared in `apiVisibility`. See [API Routes](./api-routes.md#public-and-password-protected-routes).
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
