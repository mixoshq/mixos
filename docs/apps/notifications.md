# Notifications (Web Push)

## Overview

Apps can send **Web Push** notifications — OS-level notifications delivered through a background service worker, so they reach a user even when no MOS tab is focused (or open) — by setting `"notifications": true` in `app.json`. This gives the app a `context.notifications` client in its API routes.

```json
// app.json
{
  "name": "My App",
  "notifications": true
}
```

Push is **platform-native infrastructure**: subscriptions are stored once per user (not per app), the VAPID keys and service worker are managed by the platform, and any app can reach a user by id. You don't manage keys, endpoints, or a service worker yourself.

## How it works

```
user opts in (SDK helper) ──> browser subscribes ──> platform stores subscription
app API route ──> context.notifications.send({ userIds, ... }) ──> web-push ──> service worker ──> OS notification
```

1. A user opts in once (per browser) via the SDK helper — this grants permission and registers a subscription.
2. From an **API route**, the app calls `context.notifications.send(...)` with the recipient user ids.
3. The platform looks up each recipient's stored subscriptions and delivers the push. The platform service worker shows the notification and routes clicks.

## Opting a user in (client)

A user must grant notification permission and subscribe before they can receive anything. Trigger this from a **user gesture** (e.g. a button click) using the apps SDK — never call the `Notification`, `ServiceWorker`, or `PushManager` browser APIs directly.

```tsx
"use client";
import {
  enablePushNotifications,
  getPushPermission,
  isPushSupported,
} from "@/lib/apps/sdk";

function EnableAlertsButton() {
  if (!isPushSupported() || getPushPermission() !== "default") return null;
  return (
    <button onClick={() => enablePushNotifications()}>
      🔔 Enable notifications
    </button>
  );
}
```

`enablePushNotifications()` resolves to a status: `"subscribed" | "denied" | "unsupported" | "not-configured" | "error"`. The service worker is auto-registered for every signed-in user, so a previously-subscribed user keeps receiving pushes without re-enabling. Use `disablePushNotifications()` to opt out.

## Sending (server)

Send from an API route via `context.notifications`. Guard for the capability the same way you guard `context.db`.

```ts
export async function POST(request: Request, { context }: { context: AppContext }) {
  if (!context.notifications) {
    return NextResponse.json({ error: "Notifications not enabled" }, { status: 500 });
  }

  const { sent } = await context.notifications.send({
    userIds: ["<user-uuid>", "..."], // who to notify
    title: "🍕 Lunch has arrived!",
    body: "Lunch is here — head to the kitchen!",
    url: "/apps/my-app",              // opened/focused on click
    tag: "lunch",                     // optional: coalesces in the OS tray
    // icon: "/web-app-manifest-192x192.png" (optional)
  });

  return NextResponse.json({ sent });
}
```

### Payload fields

| Field | Required | Description |
| --- | --- | --- |
| `userIds` | ✓ | Recipient user ids. Automatically filtered (see below). |
| `title` | ✓ | Notification title. |
| `body` | ✓ | Notification body text. |
| `url` |  | In-app path focused/opened when the notification is clicked. Defaults to `/`. |
| `tag` |  | Notifications sharing a tag replace each other in the OS tray. |
| `icon` |  | Icon URL; defaults to the MOS app icon. |

`send()` returns `{ sent }` — the number of subscriptions the push service accepted (a user with no/expired subscription simply contributes 0). Dead endpoints are pruned automatically.

## Recipient scoping

`send()` only delivers to users who actually have your app — global apps reach everyone; otherwise recipients are filtered to users with an explicit grant. You can't push to a user who doesn't have your app, even if you pass their id. Send from **API routes only** (the public route surface has no `context.notifications`).

## Limits

- Delivery needs a registered subscription with granted permission — a user who never opted in, or who revoked permission, receives nothing.
- **Browser support:** desktop Chrome/Edge/Firefox deliver in the background reliably; on iOS, Web Push only works for a PWA **installed to the Home Screen** (iOS 16.4+).
- **HTTPS** is required in production (localhost is exempt for local dev).
- This is not email/SMS — it reaches browsers, not people who have never opened mos. For broader reach, use a connector (e.g. Slack/email) instead.

## Configuration (platform operators)

Web Push requires VAPID keys. Generate a pair with `npx web-push generate-vapid-keys` and set `VAPID_PUBLIC_KEY`, `VAPID_PRIVATE_KEY`, and `VAPID_SUBJECT` (a `mailto:`/`https:` contact) in the Vercel project's environment variables for production, or in `.env.docker` for the local Docker stack (compose loads it into every service — see [docs/local-docker.md](../local-docker.md)). A host `.env.local` reaches the dev container only through the bind mount and never reaches the production image, since `.dockerignore` excludes `.env*` from the build context. If unset, `context.notifications.send()` is a no-op-safe error and the opt-in returns `"not-configured"`.
