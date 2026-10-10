/* This Source Code Form is subject to the terms of the Mozilla Public
 * License, v. 2.0. If a copy of the MPL was not distributed with this
 * file, You can obtain one at https://mozilla.org/MPL/2.0/. */

import type { AppManifest } from "@/lib/apps/types";
import type { BaseConnector } from "@/lib/connectors/types";
import type { NotificationsClient } from "@/lib/apps/notifications";
import type { ReadOnlyScopedClient, ScopedClient } from "@/lib/apps/scoped-db";

export type { ScopedClient, ReadOnlyScopedClient };
import type { TelemetryClient } from "@/lib/apps/telemetry";
import type { AppEnv } from "@/lib/apps/env";
import type { AppHttpClient } from "@/lib/apps/http";
import type { BrandLogo, BrandLogoFilterResult } from "@/lib/branding/types";

// ============================================================
// AppContext — the runtime bag passed to apps, widgets, and hooks
// ============================================================

export interface AppContextUser {
  id: string;
  email: string;
  displayName: string;
  isAdmin: boolean;
  /**
   * The user's effective role keys for this app (currently at most one). Drawn
   * from the manifest's declared `roles`; empty when the app declares no roles
   * or the user has none. Role meaning is app-specific.
   */
  roles: string[];
  /**
   * Returns true if the user holds any of the given role keys for this app.
   * Pure — it does not consider `isAdmin`. An app that wants admins to bypass
   * role checks should write `user.isAdmin || user.hasRole([...])`.
   */
  hasRole: (roles: string[]) => boolean;
}

/**
 * Client for requesting data from *other* apps (App Services). Non-null only
 * when the app declares one or more `consumes` dependencies. The platform
 * brokers each call — verifying two-sided consent, re-authorizing the user in
 * the provider's own terms, and running the provider's handler with the
 * provider's scoped context. See `docs/apps/app-services.md`.
 */
export interface ServicesClient {
  /**
   * Request data from another app's declared service. Rejects with a
   * `ServiceRequestError` when the dependency isn't declared, the provider
   * doesn't allow this consumer, the user lacks access (audience `"user"`), or
   * the provider handler fails.
   */
  request<T = unknown>(
    providerSlug: string,
    serviceName: string,
    params?: unknown,
  ): Promise<T>;
}

/** Identity of the app that initiated a cross-app service request. */
export interface ServiceCaller {
  appSlug: string;
}

/**
 * Context passed to a provider's service handler
 * (`apps/<slug>/services/<name>.ts`). Provider-scoped: `db`/`connectors` are the
 * *provider's*, never the caller's. `user` is the acting user for `audience:
 * "user"` services (the platform has already verified they can access this app)
 * and `null` for `audience: "app"`. `caller` names the requesting app so the
 * provider can apply finer-grained policy.
 */
export interface ServiceContext {
  user: AppContextUser | null;
  connectors: Record<string, BaseConnector>;
  db: ScopedClient | null;
  telemetry: TelemetryClient | null;
  manifest: AppManifest;
  caller: ServiceCaller;
}

/** Identity of the MCP client that initiated a tool call. */
export interface McpCaller {
  kind: "mcp";
  /** The registered OAuth client id. */
  clientId: string;
  /** Self-reported client name from dynamic registration — display only. */
  clientName: string;
}

/**
 * Context passed to an MCP tool handler (`apps/<slug>/mcp/<name>.ts`), invoked
 * by the MixOS MCP server on behalf of a connecting user.
 *
 * Shaped by what a tool is *for* — answering a question:
 *
 *   - `user` is always present (never null). The MCP server runs as the real
 *     connecting user, with this app's roles resolved, and has already verified
 *     they hold a grant for it. Re-authorize in your own terms anyway, exactly
 *     as an API route would; the platform enforces no role policy.
 *   - `db` is READ-ONLY — the mutating verbs are absent from the type and throw
 *     at runtime. A tool reads; it does not act.
 *   - No `notifications` and no `hooks`, for the same reason.
 *   - `services` IS present when the app declares `consumes`: the broker
 *     re-authorizes the user in the provider's own terms, so a tool can reach
 *     another app's data on exactly the same footing as one of this app's own
 *     API routes — no wider.
 *
 * See `docs/apps/mcp.md`.
 */
export interface McpToolContext {
  user: AppContextUser;
  connectors: Record<string, BaseConnector>;
  db: ReadOnlyScopedClient | null;
  /** Usage tracking; non-null only when the app declares `telemetry` events. */
  telemetry: TelemetryClient | null;
  /** Cross-app data requests; non-null only when the app declares `consumes`. */
  services: ServicesClient | null;
  manifest: AppManifest;
  caller: McpCaller;
}

export interface AppContext {
  user: AppContextUser;
  connectors: Record<string, BaseConnector>;
  db: ScopedClient | null;
  notifications: NotificationsClient | null;
  /** Usage tracking; non-null only when the app declares `telemetry` events. */
  telemetry: TelemetryClient | null;
  /** Cross-app data requests; non-null only when the app declares `consumes`. */
  services: ServicesClient | null;
  /**
   * App-scoped settings declared in the manifest under `env` and filled in by an
   * admin. Empty when the app declares none.
   *
   * This is why `process.env` is lint-banned in app code: the raw environment
   * carries the platform's own secrets, and this carries only what the app asked
   * for. `password` values are decrypted here and nowhere else.
   */
  env: AppEnv;
  /**
   * Outbound HTTP, bounded by the manifest's `egress` hostname allowlist and
   * guarded against SSRF — the hostname is checked, then resolved, then every
   * returned address re-checked, with redirects followed manually so each hop
   * repeats both. `null` when the app declares no `egress`.
   *
   * Raw `fetch` is lint-banned in app code so this is the only door. Anything
   * with fixed, admin-configured hosts belongs in a connector instead.
   */
  http: AppHttpClient | null;
  manifest: AppManifest;
  hooks: HookRegistrar;
}

/**
 * Context passed to app API routes served on the public surface
 * (`/api/p/<slug>/...`) — i.e. routes whose manifest declares
 * `visibility: "public"` or `"password"`. There is no user. Connectors load
 * normally — every connector is tenant-scoped, so its credentials are
 * deployment-global and do not depend on a visitor identity. App routes
 * intended to be reachable publicly must declare
 * their handler with `{ context: PublicAppContext }` and not assume a
 * user identity; reading `context.user` is a type error.
 */
export interface PublicAppContext {
  user: null;
  connectors: Record<string, BaseConnector>;
  db: ScopedClient | null;
  /** Always null on the public surface — push requires a logged-in sender context. */
  notifications: null;
  /** Usage tracking; non-null only when the app declares `telemetry` events. Records with no user. */
  telemetry: TelemetryClient | null;
  /**
   * Cross-app data requests. Non-null only when the app declares `consumes`.
   * User-less on the public surface, so only `audience: "app"` services are
   * reachable — a public consumer route must do its own authorization before
   * calling one.
   */
  services: ServicesClient | null;
  /**
   * App-scoped settings declared in the manifest under `env` and filled in by an
   * admin. Empty when the app declares none.
   *
   * This is why `process.env` is lint-banned in app code: the raw environment
   * carries the platform's own secrets, and this carries only what the app asked
   * for. `password` values are decrypted here and nowhere else.
   */
  env: AppEnv;
  /**
   * Outbound HTTP, bounded by the manifest's `egress` hostname allowlist and
   * guarded against SSRF — the hostname is checked, then resolved, then every
   * returned address re-checked, with redirects followed manually so each hop
   * repeats both. `null` when the app declares no `egress`.
   *
   * Raw `fetch` is lint-banned in app code so this is the only door. Anything
   * with fixed, admin-configured hosts belongs in a connector instead.
   */
  http: AppHttpClient | null;
  manifest: AppManifest;
  hooks: HookRegistrar;
}

/**
 * Context passed to scheduled job handlers (`apps/<slug>/jobs/<name>.ts`), run
 * by the platform cron scheduler. Like the public context there is no user
 * (`user: null`) and only tenant-scoped connectors are loaded — but unlike the
 * public surface, a job is a trusted server context, so it keeps a real
 * `notifications` client when the app declares the capability.
 */
export interface SystemAppContext {
  user: null;
  connectors: Record<string, BaseConnector>;
  db: ScopedClient | null;
  /**
   * Aborted when the platform gives up on this run (the ~4-minute job timeout).
   * The scheduler records the run as `timeout` and stops waiting either way, so a
   * handler that ignores this keeps burning API quota and writing rows after it's
   * been abandoned — while the next tick starts a second copy alongside it. Any
   * job that loops over external calls should pass it to `fetch`, and check
   * `signal.aborted` between iterations, so abandonment actually ends the work.
   * Always present; for non-scheduler callers it's a signal that never aborts.
   */
  signal: AbortSignal;
  notifications: NotificationsClient | null;
  /** Usage tracking; non-null only when the app declares `telemetry` events. Records with no user. */
  telemetry: TelemetryClient | null;
  /**
   * Cross-app data requests; non-null only when the app declares `consumes`.
   * User-less, so only `audience: "app"` services are reachable from a job.
   */
  services: ServicesClient | null;
  /**
   * App-scoped settings declared in the manifest under `env` and filled in by an
   * admin. Empty when the app declares none.
   *
   * This is why `process.env` is lint-banned in app code: the raw environment
   * carries the platform's own secrets, and this carries only what the app asked
   * for. `password` values are decrypted here and nowhere else.
   */
  env: AppEnv;
  /**
   * Outbound HTTP, bounded by the manifest's `egress` hostname allowlist and
   * guarded against SSRF — the hostname is checked, then resolved, then every
   * returned address re-checked, with redirects followed manually so each hop
   * repeats both. `null` when the app declares no `egress`.
   *
   * Raw `fetch` is lint-banned in app code so this is the only door. Anything
   * with fixed, admin-configured hosts belongs in a connector instead.
   */
  http: AppHttpClient | null;
  manifest: AppManifest;
  hooks: HookRegistrar;
}

// ============================================================
// Widget types
// ============================================================

export interface WidgetProps<
  TConfig extends Record<string, unknown> = Record<string, unknown>,
> {
  appSlug: string;
  config: TConfig;
  size: { w: number; h: number };
}

export interface ResolvedConfig {
  [fieldKey: string]: {
    options?: { label: string; value: string }[];
    default?: unknown;
    /**
     * When `false`, the config modal hides this field entirely (the value
     * persists as its default). Use this when a field is irrelevant given
     * current state — e.g. "group by category" when no categories exist.
     */
    visible?: boolean;
  };
}

export interface SidebarItem {
  label: string;
  href: string;
  icon: string;
  order: number;
}

// ============================================================
// Platform hook signatures
// ============================================================

export interface ActionHookMap {
  "init": () => Promise<void> | void;
  // `user-login` and `user-sync` are declared but NOT currently dispatched.
  // Their trigger was the SSO sign-in callback; SSO was removed and no
  // equivalent hook was added to the credentials path. Listening to either is
  // legal and will simply never fire — wire them up or drop them, but do not
  // leave a reader believing they are live.
  "user-login": (user: { id: string; email: string }) => Promise<void> | void;
  "user-sync": (user: { id: string; email: string; name: string }) => Promise<void> | void;
}

export interface FilterHookMap {
  "user-display-name": (displayName: string, user: { id: string; email: string }) => Promise<string> | string;
  // The brand hooks are BOUNDED: the platform re-validates every result and
  // keeps the previous value when one is not acceptable. They count only when
  // registered from the app's `hooks.ts` and declared under `branding.hooks`
  // in app.json, and never run for a slot the active theme claims. See
  // `src/lib/branding/types.ts` and docs/apps/hooks.md.
  /** The product name on the menu bar, the sign-in page, the tab title and the PWA. Plain text, at most 40 characters. */
  "brand-name": (name: string) => Promise<string> | string;
  /** The mark beside the name in the menu bar. */
  "menu-bar-logo": (logo: BrandLogo | null) => Promise<BrandLogoFilterResult> | BrandLogoFilterResult;
  /** The mark above the name on the sign-in page. */
  "login-logo": (logo: BrandLogo | null) => Promise<BrandLogoFilterResult> | BrandLogoFilterResult;
}

// ============================================================
// Hook callback types
// ============================================================

export type ActionCallback = (...args: unknown[]) => void | Promise<void>;
export type FilterCallback = (value: unknown, ...args: unknown[]) => unknown | Promise<unknown>;

// ============================================================
// HookRegistrar — interface given to apps (actions and filters)
// ============================================================

export interface HookRegistrar {
  /** Register a callback for an action hook */
  addAction<K extends keyof ActionHookMap>(
    hookName: K,
    callback: ActionHookMap[K],
    priority?: number
  ): void;
  addAction(
    hookName: string,
    callback: ActionCallback,
    priority?: number
  ): void;

  /** Register a callback for a filter hook */
  addFilter<K extends keyof FilterHookMap>(
    hookName: K,
    callback: FilterHookMap[K],
    priority?: number
  ): void;
  addFilter(
    hookName: string,
    callback: FilterCallback,
    priority?: number
  ): void;

  /** Fire an action — execute all registered callbacks */
  doAction<K extends keyof ActionHookMap>(
    hookName: K,
    ...args: Parameters<ActionHookMap[K]>
  ): Promise<void>;
  doAction(hookName: string, ...args: unknown[]): Promise<void>;

  /** Apply filters — pipe a value through all registered callbacks */
  applyFilters<K extends keyof FilterHookMap>(
    hookName: K,
    value: Parameters<FilterHookMap[K]>[0],
    ...args: unknown[]
  ): Promise<ReturnType<FilterHookMap[K]>>;
  applyFilters<T>(hookName: string, value: T, ...args: unknown[]): Promise<T>;
}
