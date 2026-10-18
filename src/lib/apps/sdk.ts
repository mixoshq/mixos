/* This Source Code Form is subject to the terms of the Mozilla Public
 * License, v. 2.0. If a copy of the MPL was not distributed with this
 * file, You can obtain one at https://mozilla.org/MPL/2.0/. */

/**
 * Client-side SDK for apps and widgets to communicate with the
 * secure edge gateway at /api/apps/[...slug].
 *
 * All database and connector access MUST go through this SDK
 * rather than importing DB or connector modules directly.
 */

export interface AppClient<S extends string = string> {
  /**
   * Call one of this app's declared routes, with the input and output types
   * taken from the route's own schemas.
   *
   * ```tsx
   * const client = createAppClient<"my-app">(appSlug);
   * const { items } = await client.call("GET /items", { limit: 20 });
   * //      ^ inferred from the route's `output`, not asserted
   * ```
   *
   * The spec is `"<METHOD> /<pattern>"` with `[param]` segments left in place —
   * values go in the input object, which is where the route's schema can
   * validate them. A spec the app does not declare is a compile error.
   *
   * **Uploads.** A `raw: true` route reads its own body, so a POST, PUT or
   * PATCH to one can take a `FormData` in place of the input object:
   *
   * ```tsx
   * const form = new FormData();
   * form.set("folder", folderId); // fills [folder]
   * form.set("file", file);
   * await client.call("POST /folders/[folder]/files", form);
   * ```
   *
   * The form's fields fill the spec's `[param]` segments by name, and the rest
   * of the form is the body, sent as `multipart/form-data`. The caller's form is
   * left as it was. A raw route's result is `unknown`: it answers with its own
   * Response, which the client reads as JSON.
   *
   * **The `<"my-app">` type argument is what buys the types.** `appSlug` arrives
   * as a plain `string` from `WidgetProps`, which TypeScript cannot narrow to a
   * literal, so the app names itself once and gets a checked client. Without it
   * the call still works and falls back to `unknown`.
   */
  call: TypedCall<S>;
}

/** The routes an app declares, or an open map when the slug is not a literal. */
type RoutesFor<S extends string> = S extends keyof AppRouteTypes
  ? AppRouteTypes[S]
  : Record<string, never>;

/** The methods that carry a body, and so the only ones a form can go with. */
type BodySpec = `${"POST" | "PUT" | "PATCH"} ${string}`;

/**
 * What a call takes: the route's input, or, for a body method on a raw route,
 * a form. A JSON route parses its body as JSON, so it never takes a form.
 */
type CallInput<K, D> = K extends BodySpec
  ? RouteOutputOf<D> extends Response
    ? RouteInputOf<D> | FormData
    : RouteInputOf<D>
  : RouteInputOf<D>;

type CallArgs<K, D> = Record<string, never> extends RouteInputOf<D>
  ? [input?: CallInput<K, D>]
  : [input: CallInput<K, D>];

/**
 * What a call resolves to: the route's output, or `unknown` for a raw route,
 * whose Response the client reads as JSON.
 */
type CallOutput<D> = RouteOutputOf<D> extends Response ? unknown : RouteOutputOf<D>;

/**
 * `call()` typed over one app's route map. `AppClient<"my-app">` has it over the
 * map the registry generator writes for that app.
 */
export type RouteCall<R> = <K extends keyof R & string>(
  spec: K,
  ...args: CallArgs<K, R[K]>
) => Promise<CallOutput<R[K]>>;

// `[S] extends [keyof AppRouteTypes]` — wrapped in a tuple so a plain `string`
// (what `WidgetProps.appSlug` is) does NOT distribute and match some member of
// the union. Without the tuple, `string extends "my-app"` was evaluated the
// wrong way round and every caller silently took the typed branch against an
// empty route map.
type TypedCall<S extends string> = [S] extends [keyof AppRouteTypes]
  ? RouteCall<RoutesFor<S>>
  : // Slug wasn't a literal: stay usable, but check nothing and say so.
    (spec: string, input?: Record<string, unknown> | FormData) => Promise<unknown>;

import type { AppRouteTypes } from "@/generated/app-clients";
import type { RouteInputOf, RouteOutputOf } from "@/lib/apps/route";
import { isConnectorErrorEnvelope } from "@/lib/connectors/response";
import type { ConnectorErrorEnvelope } from "@/lib/connectors/response";

// Re-exported because a widget may not import `@/lib/connectors/*`, and this is
// the type `ConnectorErrorState` takes.
export type { ConnectorErrorEnvelope };

export class AppClientError extends Error {
  constructor(
    message: string,
    public readonly status: number,
    public readonly body: unknown
  ) {
    super(message);
    this.name = "AppClientError";
  }
}

/**
 * The connector failure a route answered with, or null.
 *
 * A route whose connector call failed answers with that connector's envelope,
 * `{ error: { category, message, connector, retryAfterMs, … } }`, which is
 * exactly what `ConnectorErrorState` renders:
 *
 *   const envelope = connectorErrorOf(err);
 *   if (envelope) return <ConnectorErrorState envelope={envelope} onRetry={retry} />;
 *
 * `useAppQuery` + `AsyncView` do this for you.
 */
export function connectorErrorOf(err: unknown): ConnectorErrorEnvelope | null {
  return err instanceof AppClientError && isConnectorErrorEnvelope(err.body)
    ? err.body
    : null;
}

/**
 * The message a failed response carries: `{ error: "…" }` from the route
 * pipeline, or the connector envelope's own `error.message`.
 */
function messageOf(body: unknown): string | null {
  const error = (body as { error?: unknown } | null)?.error;
  if (typeof error === "string") return error;
  return isConnectorErrorEnvelope(body) ? body.error.message : null;
}

function normalise(path: string): string {
  return path.startsWith("/") ? path.slice(1) : path;
}

function isFormData(value: unknown): value is FormData {
  return typeof FormData !== "undefined" && value instanceof FormData;
}

const BODY_METHODS = new Set(["POST", "PUT", "PATCH"]);
const CSRF_METHODS = new Set(["POST", "PUT", "PATCH", "DELETE"]);

let csrfTokenCache: string | null = null;

async function getCsrfToken(): Promise<string> {
  if (csrfTokenCache) return csrfTokenCache;
  const res = await fetch("/api/auth/csrf", { credentials: "same-origin" });
  if (!res.ok) throw new Error("Failed to fetch CSRF token");
  const data = await res.json();
  csrfTokenCache = data.csrfToken;
  return data.csrfToken;
}

async function request(
  base: string,
  method: string,
  path: string,
  body?: Record<string, unknown> | FormData,
): Promise<unknown> {
  const url = `/api/apps/${base}/${normalise(path)}`;
  // A form's Content-Type is left to fetch, which writes the multipart boundary.
  const headers: Record<string, string> = isFormData(body)
    ? {}
    : { "Content-Type": "application/json" };

  if (CSRF_METHODS.has(method)) {
    headers["X-CSRF-Token"] = await getCsrfToken();
  }

  const init: RequestInit = { method, headers };

  if (body !== undefined && method !== "GET") {
    init.body = isFormData(body) ? body : JSON.stringify(body);
  }

  let res = await fetch(url, init);

  // If we get a 403 with CSRF failure, refresh the token and retry once.
  if (res.status === 403 && CSRF_METHODS.has(method)) {
    csrfTokenCache = null;
    headers["X-CSRF-Token"] = await getCsrfToken();
    res = await fetch(url, { ...init, headers });
  }

  if (!res.ok) {
    const errorBody: unknown = await res.json().catch(() => null);
    throw new AppClientError(
      messageOf(errorBody) ?? `Request failed: ${method} ${url} (${res.status})`,
      res.status,
      errorBody
    );
  }

  if (res.status === 204) return undefined;

  return res.json();
}

/**
 * Build the request for a call.
 *
 * `"GET /items/[id]"` plus `{ id: 42, limit: 10 }` becomes
 * `/items/42?limit=10` — the path params are consumed by the pattern and only
 * what is left travels as a query string. For a body method the remainder is
 * the JSON body instead.
 *
 * A form follows the same rule: its fields fill the path params, and a copy of
 * the rest is the body, so the caller's form keeps every field it had. It goes
 * only with a body method, since a query string cannot carry a file.
 */
function buildCall(
  spec: string,
  input: Record<string, unknown> | FormData,
): { method: string; path: string; body?: Record<string, unknown> | FormData } {
  const [method, rawPath = ""] = spec.split(" ");
  const form = isFormData(input) ? input : null;
  if (form && !BODY_METHODS.has(method)) {
    throw new TypeError(
      `${spec}: a FormData body goes only with POST, PUT or PATCH.`,
    );
  }
  const rest: Record<string, unknown> = isFormData(input) ? {} : { ...input };
  const taken = new Set<string>();

  const path = rawPath
    .split("/")
    .map((segment) => {
      if (!segment.startsWith("[") || !segment.endsWith("]")) return segment;
      const name = segment.slice(1, -1).replace(/^\.\.\./, "");
      let value: unknown;
      if (form) {
        const field = form.get(name);
        value = typeof field === "string" ? field : undefined;
        taken.add(name);
      } else {
        value = rest[name];
        delete rest[name];
      }
      return encodeURIComponent(String(value ?? ""));
    })
    .join("/");

  if (form) {
    const body = new FormData();
    for (const [key, value] of form) {
      if (!taken.has(key)) body.append(key, value);
    }
    return { method, path, body };
  }

  if (BODY_METHODS.has(method)) {
    return { method, path, body: rest };
  }

  const query = new URLSearchParams();
  for (const [key, value] of Object.entries(rest)) {
    if (value === undefined) continue;
    if (Array.isArray(value)) {
      for (const v of value) query.append(key, String(v));
    } else {
      query.set(key, String(value));
    }
  }
  const qs = query.toString();
  return { method, path: qs ? `${path}?${qs}` : path };
}

export function createAppClient<S extends string = string>(
  appSlug: string,
): AppClient<S> {
  return {
    // Async, so a call that cannot be built rejects like one that failed.
    call: (async (spec: string, input?: Record<string, unknown> | FormData) => {
      const { method, path, body } = buildCall(spec, input ?? {});
      return request(appSlug, method, path, body);
    }) as TypedCall<S>,
  };
}

// ============================================================
// Telemetry — usage tracking capability (see docs/apps/telemetry.md)
// ============================================================

/**
 * Record a client-side telemetry event for the current app. Use this from a
 * widget or page for usage that only happens in the browser (a click, a view);
 * server-side usage should call `context.telemetry.track()` from an API route
 * instead.
 *
 * `eventName` must be one of the events the app declares in `app.json`
 * `telemetry` — an undeclared name is rejected server-side and dropped.
 * Fire-and-forget: this never throws and never blocks the UI.
 */
export async function track(
  appSlug: string,
  eventName: string,
  properties?: Record<string, unknown>,
): Promise<void> {
  try {
    await fetch("/api/analytics/track", {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ appSlug, event: eventName, properties: properties ?? {} }),
      keepalive: true,
    });
  } catch {
    // Telemetry is best-effort; never surface failures to the user.
  }
}

// ============================================================
// Web Push — platform notifications capability (see docs/apps/notifications.md)
// ============================================================

/** Result of an enablePushNotifications() attempt. */
export type PushEnableResult =
  | "subscribed"
  | "denied"
  | "unsupported"
  | "not-configured"
  | "error";

/** True only in a browser that supports service workers + Web Push. */
export function isPushSupported(): boolean {
  return (
    typeof window !== "undefined" &&
    "serviceWorker" in navigator &&
    "PushManager" in window &&
    "Notification" in window
  );
}

/** Current Notification permission, or null when unsupported. */
export function getPushPermission(): NotificationPermission | null {
  if (typeof Notification === "undefined") return null;
  return Notification.permission;
}

/**
 * Whether this browser currently holds an active Web Push subscription.
 * Permission being "granted" isn't enough — the subscription can be missing
 * (never enabled here, or cleared), so this checks the actual PushManager.
 */
export async function isPushSubscribed(): Promise<boolean> {
  if (!isPushSupported()) return false;
  try {
    const reg = await navigator.serviceWorker.getRegistration("/sw.js");
    const sub = await reg?.pushManager.getSubscription();
    return Boolean(sub);
  } catch {
    return false;
  }
}

// VAPID public keys are base64url; convert to the Uint8Array subscribe() wants.
function urlBase64ToUint8Array(base64: string): Uint8Array {
  const padding = "=".repeat((4 - (base64.length % 4)) % 4);
  const b64 = (base64 + padding).replace(/-/g, "+").replace(/_/g, "/");
  const raw = atob(b64);
  const out = new Uint8Array(raw.length);
  for (let i = 0; i < raw.length; i++) out[i] = raw.charCodeAt(i);
  return out;
}

async function postPush(path: string, body: unknown): Promise<Response> {
  return fetch(`/api/push/${path}`, {
    method: "POST",
    credentials: "same-origin",
    headers: {
      "Content-Type": "application/json",
      "X-CSRF-Token": await getCsrfToken(),
    },
    body: JSON.stringify(body),
  });
}

/**
 * Register the platform service worker, request notification permission, and
 * persist a Web Push subscription for the current user. Call this from a user
 * gesture (e.g. a button click). Apps should use this rather than touching the
 * Notification / ServiceWorker / PushManager APIs directly.
 */
export async function enablePushNotifications(): Promise<PushEnableResult> {
  if (!isPushSupported()) return "unsupported";

  try {
    const permission = await Notification.requestPermission();
    if (permission !== "granted") return "denied";

    const reg = await navigator.serviceWorker.register("/sw.js");
    await navigator.serviceWorker.ready;

    const keyRes = await fetch("/api/push/key", { credentials: "same-origin" });
    if (keyRes.status === 503) return "not-configured";
    if (!keyRes.ok) return "error";
    const { key } = (await keyRes.json()) as { key: string };

    const existing = await reg.pushManager.getSubscription();
    const sub =
      existing ??
      (await reg.pushManager.subscribe({
        userVisibleOnly: true,
        applicationServerKey: urlBase64ToUint8Array(key) as BufferSource,
      }));

    const res = await postPush("subscribe", sub.toJSON());
    return res.ok ? "subscribed" : "error";
  } catch {
    return "error";
  }
}

/** Unsubscribe this browser and tell the server to drop the row. */
export async function disablePushNotifications(): Promise<void> {
  if (!isPushSupported()) return;
  try {
    const reg = await navigator.serviceWorker.getRegistration("/sw.js");
    const sub = await reg?.pushManager.getSubscription();
    if (sub) {
      await postPush("unsubscribe", { endpoint: sub.endpoint }).catch(() => {});
      await sub.unsubscribe().catch(() => {});
    }
  } catch {
    // best-effort
  }
}
