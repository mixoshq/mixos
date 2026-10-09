/* This Source Code Form is subject to the terms of the Mozilla Public
 * License, v. 2.0. If a copy of the MPL was not distributed with this
 * file, You can obtain one at https://mozilla.org/MPL/2.0/. */

import type {
  AppContext,
  AppContextUser,
  PublicAppContext,
  SystemAppContext,
} from "@/lib/hooks/types";
import type { AppManifest } from "@/lib/apps/types";
import type { BaseConnector } from "@/lib/connectors/types";
import { appRegistry } from "@/generated/app-registry";
import { connectorRegistry } from "@/generated/connector-registry";
import { getDecryptedConfig } from "@/lib/connectors/config";
import { initializeWithUserGrant } from "@/lib/connectors/user-grant";
import { createScopedClient } from "./scoped-db";
import { createNotificationsClient } from "./notifications";
import { createServicesClient } from "./services";
import { createTelemetryClient, instrumentConnector } from "./telemetry";
import { getUserAppRole } from "./access";
import { loadAppEnv } from "./env";
import { createHttpClient } from "./http";
import { hooks } from "@/lib/hooks";

/** One connector's manifest, or undefined if it is not in the registry. */
function connectorManifest(name: string) {
  return connectorRegistry.find((c) => c.name === name);
}

/** Declared telemetry method names for a connector, from the generated registry. */
function connectorTelemetryMethods(connName: string): Set<string> {
  const manifest = connectorRegistry.find((c) => c.name === connName);
  return new Set((manifest?.telemetry ?? []).map((t) => t.method));
}

/** Per-app telemetry client, or null when the app declares no telemetry events. */
function telemetryClientFor(manifest: AppManifest, userId: string | null) {
  if (manifest.telemetry.length === 0) return null;
  return createTelemetryClient(manifest.slug, {
    declaredEvents: new Set(manifest.telemetry.map((t) => t.name)),
    userId,
  });
}

/**
 * The containment pair every context gets, resolved the same way in all three
 * builders so they cannot drift: settings the app declared, and an HTTP client
 * bounded by the hosts it declared. Both are `[]`/`null` by default — an app
 * that asked for neither can reach neither.
 */
async function buildContainment(manifest: AppManifest) {
  return {
    env: await loadAppEnv(manifest.slug, manifest.env ?? []),
    http:
      (manifest.egress ?? []).length > 0
        ? createHttpClient(manifest.slug, manifest.egress)
        : null,
  };
}

export async function buildAppContext(
  appSlug: string,
  dbUser: { id: string; email: string; display_name: string; is_admin: boolean }
): Promise<AppContext> {
  const manifest = appRegistry.find((a) => a.slug === appSlug)!;

  // Effective role for this app (assigned role, falling back to defaultRole).
  const effectiveRole = await getUserAppRole(dbUser.id, appSlug);
  const roles = effectiveRole ? [effectiveRole] : [];

  const user: AppContextUser = {
    id: dbUser.id,
    email: dbUser.email,
    displayName: dbUser.display_name,
    isAdmin: dbUser.is_admin,
    roles,
    hasRole: (wanted: string[]) => wanted.some((r) => roles.includes(r)),
  };

  const registrar = hooks.createRegistrar(manifest.slug);
  const containment = await buildContainment(manifest);

  // Initialize declared connectors. Every connector is tenant-scoped: one
  // admin-configured credential set in `connector_configs`, shared by every
  // user. Apps declare names only; the platform resolves credentials.
  const connectors = await loadTenantConnectors(
    manifest,
    "buildAppContext",
    dbUser.id,
  );

  // Create scoped DB if app declares database support
  const db = manifest.database ? createScopedClient(appSlug) : null;

  // Web Push sender if the app declares the notifications capability.
  const notifications = manifest.notifications
    ? createNotificationsClient(appSlug)
    : null;

  // Cross-app data requests, only when the app declares dependencies.
  const services =
    manifest.consumes.length > 0
      ? createServicesClient({ callerSlug: appSlug, actingUser: user })
      : null;

  const context: AppContext = {
    user,
    connectors,
    db,
    notifications,
    telemetry: telemetryClientFor(manifest, dbUser.id),
    services,
    manifest,
    hooks: registrar,
    ...containment,
  };

  return context;
}

/**
 * Build the runtime context for an app API route served on the public
 * surface (`/api/p/<slug>/...`) — i.e. routes declared with
 * `visibility: "public"` or `"password"` in the manifest. There is no
 * logged-in user, so:
 *
 *   - `context.user` is `null` (routes must not read it).
 *
 * Connectors load normally — every connector is tenant-scoped, so its
 * credentials are global to the deployment and don't depend on a visitor
 * identity.
 */
export async function buildPublicAppContext(
  appSlug: string,
): Promise<PublicAppContext> {
  const manifest = appRegistry.find((a) => a.slug === appSlug)!;
  const registrar = hooks.createRegistrar(manifest.slug);
  const containment = await buildContainment(manifest);
  const connectors = await loadTenantConnectors(
    manifest,
    "buildPublicAppContext",
    null,
  );
  const db = manifest.database ? createScopedClient(appSlug) : null;
  // Cross-app requests on the public surface: user-less, so the broker permits
  // only `audience: "app"` services (a public route must do its own auth first).
  const services =
    manifest.consumes.length > 0
      ? createServicesClient({ callerSlug: appSlug, actingUser: null })
      : null;

  return {
    user: null,
    connectors,
    db,
    notifications: null,
    telemetry: telemetryClientFor(manifest, null),
    services,
    manifest,
    hooks: registrar,
    ...containment,
  };
}

/**
 * Load and initialize the connectors an app declares.
 *
 * The single loader for every surface: the authenticated context, the public
 * surface, and the scheduler's system context. Connector credentials are
 * deployment-global, so the only thing that varies is who to attribute a call
 * to — `userId` is null on the surfaces that have no logged-in user.
 */
async function loadTenantConnectors(
  manifest: AppManifest,
  logTag: string,
  userId: string | null,
): Promise<Record<string, BaseConnector>> {
  const connectors: Record<string, BaseConnector> = {};

  /*
    Optional connectors are built alongside required ones: "optional" describes
    whether the APP can run without it, not whether the connector is reachable
    when configured. A sub-component that declares one still needs it present in
    `context.connectors` on the deployments that have it set up.
  */
  for (const connName of [
    ...manifest.connectors,
    ...(manifest.optionalConnectors ?? []),
  ]) {
    try {
      const mod = await import(`@connectors/${connName}/index`);
      const ConnectorClass =
        mod.default ??
        mod[Object.keys(mod).find((k) => typeof mod[k] === "function")!];
      const instance: BaseConnector = new ConnectorClass();

      let tenantCreds: Record<string, string> | null = null;
      try {
        tenantCreds = await getDecryptedConfig(connName);
      } catch (err) {
        console.error(`[${logTag}] getDecryptedConfig failed for "${connName}":`, err);
        tenantCreds = null;
      }

      /*
        A user-scoped connector resolves against the CALLER's grant.

        The client id and secret still come from the tenant row — the
        application is registered once — and only the tokens are the person's
        own. An access token that has expired is renewed here, before the
        handler runs, so `configured` describes the grant as it is now. Three
        ways this legitimately produces nothing:

          · no user in this context (a scheduled job, a public page). The build
            guard rejects a job declaring one, so reaching here means a surface
            that genuinely has no caller.
          · the user has never connected.
          · the provider will no longer renew their grant (revoked, expired, or
            never issued a refresh token). They connect again.

        Each way the connector is OMITTED rather than handed over unusable.
        An app already checks `context.connectors.x` for presence; a connector
        that is present and throws on first use is a worse contract than one
        that is absent, and the absence is the same shape the app must already
        handle for a connector an admin has not configured.
      */
      const declared = connectorManifest(connName);
      if (declared?.userScoped) {
        if (!userId) {
          console.warn(
            `[${logTag}] "${connName}" is user-scoped and this context has no user — omitted`,
          );
          continue;
        }
        try {
          const connected = await initializeWithUserGrant(instance, {
            userId,
            manifest: declared,
            tenantCredentials: tenantCreds,
          });
          if (!connected) continue; // no usable grant — nothing to hand over
        } catch (err) {
          console.error(
            `[${logTag}] "${connName}": the user's grant could not be loaded:`,
            err,
          );
          continue;
        }

        connectors[connName] = instrumentConnector(instance, {
          connectorSlug: connName,
          methods: connectorTelemetryMethods(connName),
          callerAppSlug: manifest.slug,
          userId,
        });
        continue;
      }

      if (tenantCreds) {
        try {
          // Awaited: an auth strategy may need I/O to mint or refresh a token
          // before the connector is usable. A synchronous initialize() is still
          // valid — awaiting a void return is a no-op.
          await instance.initialize(tenantCreds);
        } catch (err) {
          // Invariant 11: a connector that failed to initialize is excluded
          // entirely rather than handed over half-configured.
          console.error(`[${logTag}] ${connName}.initialize() threw:`, err);
          continue;
        }
      } else if (declared?.credentialFields.length !== 0) {
        // A connector declaring no credential fields needs none, so having no
        // row is its normal state rather than something to warn about.
        console.warn(
          `[${logTag}] no decrypted credentials for "${connName}" — connector will report as unconfigured`,
        );
      }

      connectors[connName] = instrumentConnector(instance, {
        connectorSlug: connName,
        methods: connectorTelemetryMethods(connName),
        callerAppSlug: manifest.slug,
        userId,
      });
    } catch (err) {
      console.error(`[${logTag}] connector "${connName}" failed to load:`, err);
    }
  }

  return connectors;
}

/**
 * Build the runtime context for a scheduled job handler
 * (`apps/<slug>/jobs/<name>.ts`), run by the platform cron scheduler. Like the
 * public context there's no user and only tenant-scoped connectors — but a job
 * is a trusted server context, so it keeps a real notifications client when the
 * app declares the capability.
 */
export async function buildSystemAppContext(
  appSlug: string,
  /**
   * Cancellation for this run, supplied by the scheduler so a handler can stop
   * when the job timeout fires. Callers outside the scheduler (the services
   * broker, backfill scripts) omit it and get a signal that never aborts.
   */
  signal?: AbortSignal,
): Promise<SystemAppContext> {
  const manifest = appRegistry.find((a) => a.slug === appSlug)!;
  const registrar = hooks.createRegistrar(manifest.slug);
  const containment = await buildContainment(manifest);
  const connectors = await loadTenantConnectors(
    manifest,
    "buildSystemAppContext",
    null,
  );
  const db = manifest.database ? createScopedClient(appSlug) : null;
  const notifications = manifest.notifications
    ? createNotificationsClient(appSlug)
    : null;
  // User-less: only `audience: "app"` services are reachable from a job.
  const services =
    manifest.consumes.length > 0
      ? createServicesClient({ callerSlug: appSlug, actingUser: null })
      : null;

  return {
    user: null,
    connectors,
    db,
    signal: signal ?? new AbortController().signal,
    notifications,
    telemetry: telemetryClientFor(manifest, null),
    services,
    manifest,
    hooks: registrar,
    ...containment,
  };
}
