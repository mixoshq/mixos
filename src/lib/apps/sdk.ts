/**
 * Client-side SDK for apps and widgets to communicate with the
 * secure edge gateway at /api/apps/[...slug].
 *
 * All database and connector access MUST go through this SDK
 * rather than importing DB or connector modules directly.
 */

export interface AppClient {
  get<T = unknown>(path: string, options?: RequestOptions): Promise<T>;
  post<T = unknown>(path: string, options?: RequestOptions): Promise<T>;
  put<T = unknown>(path: string, options?: RequestOptions): Promise<T>;
  patch<T = unknown>(path: string, options?: RequestOptions): Promise<T>;
  delete<T = unknown>(path: string, options?: RequestOptions): Promise<T>;
}

export interface RequestOptions {
  body?: unknown;
  headers?: Record<string, string>;
  signal?: AbortSignal;
}

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

function normalise(path: string): string {
  return path.startsWith("/") ? path.slice(1) : path;
}

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

async function request<T>(
  base: string,
  method: string,
  path: string,
  options?: RequestOptions
): Promise<T> {
  const url = `/api/apps/${base}/${normalise(path)}`;
  const isFormData =
    typeof FormData !== "undefined" && options?.body instanceof FormData;
  const headers: Record<string, string> = isFormData
    ? { ...options?.headers }
    : { "Content-Type": "application/json", ...options?.headers };

  if (CSRF_METHODS.has(method)) {
    headers["X-CSRF-Token"] = await getCsrfToken();
  }

  const init: RequestInit = {
    method,
    headers,
    signal: options?.signal,
  };

  if (options?.body !== undefined && method !== "GET") {
    init.body = isFormData
      ? (options.body as FormData)
      : JSON.stringify(options.body);
  }

  let res = await fetch(url, init);

  // If we get a 403 with CSRF failure, refresh the token and retry once.
  if (res.status === 403 && CSRF_METHODS.has(method)) {
    csrfTokenCache = null;
    headers["X-CSRF-Token"] = await getCsrfToken();
    res = await fetch(url, { ...init, headers });
  }

  if (!res.ok) {
    const body = await res.json().catch(() => null);
    throw new AppClientError(
      body?.error ?? `Request failed: ${method} ${url} (${res.status})`,
      res.status,
      body
    );
  }

  if (res.status === 204) return undefined as T;

  return res.json() as Promise<T>;
}

export function createAppClient(appSlug: string): AppClient {
  return {
    get: <T = unknown>(path: string, opts?: RequestOptions) =>
      request<T>(appSlug, "GET", path, opts),
    post: <T = unknown>(path: string, opts?: RequestOptions) =>
      request<T>(appSlug, "POST", path, opts),
    put: <T = unknown>(path: string, opts?: RequestOptions) =>
      request<T>(appSlug, "PUT", path, opts),
    patch: <T = unknown>(path: string, opts?: RequestOptions) =>
      request<T>(appSlug, "PATCH", path, opts),
    delete: <T = unknown>(path: string, opts?: RequestOptions) =>
      request<T>(appSlug, "DELETE", path, opts),
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
