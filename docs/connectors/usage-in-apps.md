# Usage in Apps

## Declaring a Connector Dependency

To use a connector in your app, add its name to the `connectors` array in your `app.json`. The platform will automatically load, initialize, and inject the connector into your app context.

```json
// app.json
{
  "name": "My App",
  "connectors": ["my-service", "monday"]
}
```

## Accessing Connectors in API Routes

Connectors are available on `context.connectors` in your app's API route handlers, keyed by the connector's manifest name. This is the only place you should use them directly.

```ts
// apps/my-app/api/items/route.ts
import { z } from "zod";
import { AppError, defineRoute } from "@/lib/apps/route";
import type MyServiceConnector from "@connectors/my-service";

const Item = z.object({ id: z.string(), name: z.string() });

export const GET = defineRoute({
  output: z.object({ items: z.array(Item) }),
  handler: async (context) => {
    // Typed as the base connector; name the class to call its methods.
    const myService = context.connectors["my-service"] as MyServiceConnector | undefined;

    if (!myService?.configured) {
      throw AppError.unavailable("My Service is not configured. Ask an admin to set it up.");
    }

    return { items: await myService.listItems() };
  },
});
```

A route is a `defineRoute` declaration that returns plain data; the build rejects a bare exported handler. See [API routes](../apps/api-routes.md).

## Calling from Widgets and Pages

Widgets and client-side pages cannot import connectors directly. Instead, use the SDK to call your API routes, which access the connector behind the secure gateway.

```tsx
// apps/my-app/widgets/items-list.tsx
"use client";

import type { WidgetProps } from "@/lib/hooks/types";
import { useAppQuery } from "@/lib/apps/use-app-query";
import { AsyncView } from "@/components/ui/async-view";
import { Skeleton } from "@/components/ui/skeleton";

export default function ItemsList({ appSlug }: WidgetProps) {
  const query = useAppQuery<{ items: { id: string; name: string }[] }>(appSlug, "GET /items");

  return (
    <AsyncView
      query={query}
      skeleton={<Skeleton className="h-24 w-full" />}
      empty={{ cause: "no-data", body: "My Service has no items yet." }}
    >
      {(data) => (
        <ul>
          {data.items.map((item) => (
            <li key={item.id}>{item.name}</li>
          ))}
        </ul>
      )}
    </AsyncView>
  );
}
```

`AsyncView` also renders a failed connector call for you. See [Failure handling](failure-handling.md#in-a-widget).
