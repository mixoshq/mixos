# Widgets

## Overview

Widgets are small, embeddable UI components that render inside dashboard cards. Users can add, remove, resize, and rearrange widgets on their dashboard. Each widget belongs to an app and is declared in the app's `app.json` manifest.

## Declaring a Widget

Add a `widgets` array to your `app.json`. The widget `id` is automatically derived from the component filename (e.g., `widgets/sales-chart.tsx` becomes `sales-chart`).

```json
{
  "name": "My App",
  "widgets": [
    {
      "name": "Sales Chart",
      "description": "Shows monthly sales trends",
      "component": "widgets/sales-chart.tsx",
      "defaultSize": { "w": 6, "h": 4 },
      "minSize": { "w": 3, "h": 2 },
      "config": [
        {
          "key": "period",
          "label": "Time Period",
          "type": "select",
          "default": "month",
          "options": [
            { "label": "Weekly", "value": "week" },
            { "label": "Monthly", "value": "month" }
          ]
        }
      ]
    }
  ]
}
```

### Field Reference

| Field | Required | Description | Example |
| --- | --- | --- | --- |
| `name` | ✅ | Display name shown in the widget catalog and widget header during edit mode. | `"name": "Sales Chart"` |
| `description` | ✅ | Brief description shown in the widget catalog when users browse available widgets. | `"description": "Shows monthly sales trends"` |
| `component` | ✅ | Relative path to the widget's React component file from the app directory. Must be a `"use client"` component that exports a default function. | `"component": "widgets/sales-chart.tsx"` |
| `defaultSize` |  | Default grid size when the widget is added to the dashboard. `w` is width in columns (1–12), `h` is height in rows. Defaults to `4x3` if omitted. | `"defaultSize": { "w": 6, "h": 4 }` |
| `minSize` |  | Minimum size the widget can be resized to. Prevents users from making it too small. Uses the same `w`/`h` format. | `"minSize": { "w": 3, "h": 2 }` |
| `config` |  | Array of configuration fields that let users customize the widget when adding it. A config modal appears automatically. |  |
| `config[].key` | ✅ | The property name used to access this value in `config` within your widget component. | `"key": "period"` |
| `config[].label` | ✅ | Human-readable label shown in the configuration modal. | `"label": "Time Period"` |
| `config[].type` | ✅ | One of `text`, `number`, `boolean`, `select`, or `multiselect`. | `"type": "select"` |
| `config[].required` |  | If `true`, the field must be filled before saving. | `"required": true` |
| `config[].default` |  | Default value used when the widget is first added. | `"default": "month"` |
| `config[].options` |  | For `select` and `multiselect`. Array of `{ label: string, value: string }` objects. `resolveConfig` can replace them when the modal opens. | `"options": [{ "label": "Weekly", "value": "week" }]` |
| `config[].ordered` |  | For `multiselect` only. When `true`, the config modal renders a drag-to-reorder list; the array order of the stored value is the display order. Leave off (default `false`) when order is meaningless — you'll get the classic checkbox UI. | `"ordered": true` |

## Writing a Widget Component

Widget components must be client components (`"use client"`) and accept `WidgetProps`. The props provide:

- `appSlug` — the app's slug, used to create an API client for fetching data through the secure gateway
- `config` — user-configured values from the config schema declared in `app.json`
- `size` — current grid size `{ w, h }`

```tsx
// apps/my-app/widgets/sales-chart.tsx
"use client";

import { useEffect, useState } from "react";
import type { WidgetProps } from "@/lib/hooks/types";
import { createAppClient } from "@/lib/apps/sdk";
import { Skeleton } from "@/components/ui/skeleton";

export default function SalesChart({ appSlug, config, size }: WidgetProps) {
  const [data, setData] = useState(null);
  const period = (config.period as string) ?? "month";

  useEffect(() => {
    const client = createAppClient(appSlug);
    client.get(`/sales?period=${period}`).then(setData);
  }, [appSlug, period]);

  if (!data) {
    return (
      <div className="flex h-full flex-col p-4">
        <Skeleton className="h-5 w-32" />
        <Skeleton className="mt-3 flex-1 rounded-md" />
      </div>
    );
  }

  return (
    <div className="flex h-full flex-col">
      <h3>{(config.title as string) ?? "Sales Overview"}</h3>
      <div className="flex-1">
        {/* Render chart using data */}
      </div>
    </div>
  );
}
```

### Fetch only what you render

A widget should ask its route for just the data it displays. Several widgets often share one route, and each connector call that route makes is latency the user waits on. If your widget shows a list of names, don't trigger the route's ticket scan or health lookup; pass a `scope` / `include` query param so the route can skip enrichment this widget never shows. This is the client half of [Calling Connectors Efficiently](./api-routes.md#calling-connectors-efficiently) — keep the two in sync: the param the widget sends must match a branch the route guards.

```tsx
// renders account names only → ask for company data, skip the ticket scan
client.get(`/accounts?manager=${manager}&include=company`);
```

Remember every config value the request depends on must be in the `useEffect` dependency array, so changing a setting refetches.

## Skeleton Loading States

Widgets must show skeleton placeholders while fetching data — never bare "Loading..." text. Use the shared `Skeleton` component from `@/components/ui/skeleton` to match the shape of the final rendered content.

```tsx
"use client";

import { useEffect, useState } from "react";
import type { WidgetProps } from "@/lib/hooks/types";
import { createAppClient } from "@/lib/apps/sdk";
import { Skeleton } from "@/components/ui/skeleton";

export default function MyWidget({ appSlug }: WidgetProps) {
  const [data, setData] = useState<Data | null>(null);

  useEffect(() => {
    createAppClient(appSlug).get<Data>("/endpoint").then(setData);
  }, [appSlug]);

  if (!data) {
    return (
      <div className="flex h-full flex-col p-4">
        <Skeleton className="h-3 w-24" />
        <Skeleton className="mt-2 h-8 w-32" />
        <Skeleton className="mt-2 h-3 w-16" />
      </div>
    );
  }

  return <div>{/* render data */}</div>;
}
```

**Guidelines:**
- Mirror the layout of the loaded state (same padding, same general shape)
- Use `Skeleton` with `h-*` and `w-*` classes to approximate text lines, headings, and blocks
- For repeated items (lists, table rows), render 3-8 skeleton rows to fill the space
- For circular elements (avatars, status dots), add `rounded-full` to the Skeleton
- Never show a bare spinner or "Loading..." text as the only loading indicator

### Declaring the config (widgets.ts)

Config fields built from presets live in `widgets.ts`, beside the manifest —
`app.json` is the only manifest form and cannot call a helper. Collect the
fields in a `const` array with `as const`, then derive the widget's config type
from it:

```ts
// apps/my-app/widgets.ts
import {
  titleField,
  selectionField,
  displayModeField,
  groupByField,
  type InferConfig,
} from "@/lib/apps/widget-config-presets";

export const favoriteLinksConfigFields = [
  titleField({ default: "Favorites" }),
  selectionField({ key: "linkIds", label: "Links to show", ordered: true }),
  displayModeField({ modes: ["list", "icon"], default: "list" }),
  groupByField({ label: "Group by category" }),
] as const;

export type FavoriteLinksWidgetConfig = InferConfig<
  typeof favoriteLinksConfigFields
>;
// {
//   title: string;
//   linkIds: string[];
//   displayMode: "list" | "icon";
//   groupByCategory: boolean;
// }

// Keyed by the widget's `component` path, exactly as app.json spells it.
export default {
  "widgets/favorite-links.tsx": favoriteLinksConfigFields,
};
```

The manifest itself stays plain JSON and says nothing about this widget's config:

```json
{
  "widgets": [
    {
      "name": "Favorite Links",
      "description": "Links you keep coming back to",
      "component": "widgets/favorite-links.tsx"
    }
  ]
}
```

The `as const` is load-bearing: without it, TypeScript widens the array to a plain `WidgetConfigField[]` and `InferConfig` can't see the per-field literal types.

The generator refuses to guess when the two files disagree: a key in `widgets.ts` that matches no widget in `app.json` is an error, and so is a widget that declares `config` in both. Plain, one-off config needs no `widgets.ts` — put it inline in `app.json`.

### Consuming the type in the widget

The widget's `config` prop becomes typed — no `as string` casts, and the destructure is checked against the manifest:

```tsx
// apps/my-app/widgets/favorite-links.tsx
import type { WidgetProps } from "@/lib/hooks/types";
import type { FavoriteLinksWidgetConfig } from "../widgets";

export default function FavoriteLinksWidget({
  config,
}: WidgetProps<FavoriteLinksWidgetConfig>) {
  const { title, linkIds, displayMode, groupByCategory } = config;
  //      ^string  ^string[]  ^"list"|"icon"  ^boolean
  // ...
}
```

`WidgetProps` is generic; the default is `Record<string, unknown>`, so widgets that don't declare a config type, including any whose config is inline in `app.json`, keep working unchanged.

### Preset reference

| Preset | Value type | Defaults |
| --- | --- | --- |
| `titleField(opts?)` | `string` | key=`title`, required=`true`, default=`""` |
| `selectionField({ key, label, ordered? })` | `string[]` | ordered=`true`; pair with `resolveConfig` to populate options |
| `displayModeField({ modes, default? })` | Union of the `modes` values (e.g. `"list" \| "icon"`) | key=`displayMode`; pass modes as a literal array |
| `groupByField({ key?, label? })` | `boolean` | key=`groupByCategory`, default=`false` |

All four are generic over their `key` string — you can pass `titleField({ key: "header" })` and the inferred type keys off `header` instead of `title`.

These return plain objects that structurally satisfy `WidgetConfigField`, so nothing about the runtime changes — the generator serializes them into the registry just like JSON-declared fields.

## Dynamic Config with `resolveConfig`

Some fields need data that doesn't exist until the user opens the config modal — a list of items the user has created, for example. Export an async `resolveConfig` from your widget file; the modal awaits it before rendering and overrides each listed field's behavior.

```tsx
// apps/my-app/widgets/favorite-links.tsx
import type { ResolvedConfig } from "@/lib/hooks/types";
import { createAppClient } from "@/lib/apps/sdk";

export async function resolveConfig({
  appSlug,
}: {
  appSlug: string;
}): Promise<ResolvedConfig> {
  const client = createAppClient(appSlug);
  const [linksRes, catsRes] = await Promise.all([
    client.get<{ links: Link[] }>("/links").catch(() => ({ links: [] })),
    client.get<{ categories: Category[] }>("/categories").catch(() => ({ categories: [] })),
  ]);

  return {
    // Populate the multiselect options at open time
    linkIds: {
      options: linksRes.links.map((l) => ({ label: l.title, value: l.id })),
    },

    // Hide "group by category" entirely when no categories exist yet —
    // the toggle would be a no-op otherwise.
    groupByCategory: {
      visible: catsRes.categories.length > 0,
    },
  };
}
```

Each key in the returned object matches a `config[].key` declared in your manifest. Supported overrides per field:

| Key | Effect |
| --- | --- |
| `options` | Replaces the static `options` array for `select` / `multiselect` fields. |
| `default` | Overrides the manifest default (useful when the "right" default depends on user data). |
| `visible` | When `false`, the field is hidden from the modal. Its stored value remains the manifest default — so hidden fields are safe to read in your widget component. Use this to suppress fields that would be no-ops given current state. |

### `resolveConfig` blocks the modal — keep it fast and bulletproof

The config modal `await`s your `resolveConfig` and shows **"Loading configuration..."** until it settles. If the promise is slow it looks stuck; if it never settles the modal hangs forever. Three rules:

1. **Hit a lightweight endpoint, not your data route.** `resolveConfig` only needs option lists (ids + labels). Don't reuse the heavy route that builds the widget's full dataset — give it a dedicated route that returns just the choices. Calling a route that fans out per-record connector calls is the usual cause of a "stuck" modal.
2. **Catch every call** so a failure degrades to the manifest's static `options` instead of throwing.
3. **Race a timeout** so a stalled request can't trap the user — fall back to static options after a few seconds.

```tsx
export async function resolveConfig({ appSlug }: { appSlug: string }): Promise<ResolvedConfig> {
  const fetched = createAppClient(appSlug)
    .get<{ managers: { id: string; name: string }[] }>("/managers") // light, not /accounts
    .catch(() => null);
  const timeout = new Promise<null>((r) => setTimeout(() => r(null), 8000));
  const res = await Promise.race([fetched, timeout]);

  return {
    manager: {
      options: [
        { label: "All", value: "all" },
        ...(res?.managers ?? []).map((m) => ({ label: m.name, value: m.id })),
      ],
    },
  };
}
```
