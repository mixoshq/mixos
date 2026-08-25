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
import { createScopedClient } from "./scoped-db";
import { createNotificationsClient } from "./notifications";
import { createServicesClient } from "./services";
import { createTelemetryClient, instrumentConnector } from "./telemetry";
import { getUserAppRole } from "./access";
import { hooks } from "@/lib/hooks";

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

  for (const connName of manifest.connectors) {
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
      } else {
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
  };
}
