# Usage in Apps

## Declaring a Connector Dependency

To use a connector in your app, add its name to the `connectors` array in your `app.json`. The platform will automatically load, initialize, and inject the connector into your app context.

```json
// app.json
{
  "name": "My App",
  "connectors": ["my-service", "hubspot"]
}
```

## Accessing Connectors in API Routes

Connectors are available on `context.connectors` in your app's API route handlers. This is the only place you should use them directly.

```ts
// apps/my-app/api/items/route.ts
import { NextResponse } from "next/server";
import type { AppContext } from "@/lib/hooks/types";

export async function GET(
  _request: Request,
  { context }: { context: AppContext }
) {
  const myService = context.connectors["my-service"];

  if (!myService?.configured) {
    return NextResponse.json(
      { error: "my-service connector is not configured" },
      { status: 503 }
    );
  }

  const items = await myService.getItems({ limit: 50 });
  return NextResponse.json(items);
}
```

## Calling from Widgets and Pages

Widgets and client-side pages cannot import connectors directly. Instead, use the SDK to call your API routes, which access the connector behind the secure gateway.

```tsx
// apps/my-app/widgets/items-list.tsx
"use client";

import { useEffect, useState } from "react";
import type { WidgetProps } from "@/lib/hooks/types";
import { createAppClient } from "@/lib/apps/sdk";

export default function ItemsList({ appSlug }: WidgetProps) {
  const [items, setItems] = useState([]);

  useEffect(() => {
    const client = createAppClient(appSlug);
    client.get("/items").then(setItems);
  }, [appSlug]);

  return (
    <ul>
      {items.map((item: any) => (
        <li key={item.id}>{item.name}</li>
      ))}
    </ul>
  );
}
```
