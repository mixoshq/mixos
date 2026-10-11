/* This Source Code Form is subject to the terms of the Mozilla Public
 * License, v. 2.0. If a copy of the MPL was not distributed with this
 * file, You can obtain one at https://mozilla.org/MPL/2.0/. */

import type {
  AppContext,
  AppContextUser,
  ScopedClient,
  ServiceContext,
  ServicesClient,
  SystemAppContext,
} from "@/lib/hooks/types";
import { appRegistry } from "@/generated/app-registry";
import { connectorRegistry } from "@/generated/connector-registry";
import { hasAppGrant } from "./access";
import { checkAppGate } from "./app-gate";
import { readOnlyConnectors, refusalMessage } from "./read-only";
import { createReadOnlyScopedClient } from "./scoped-db";
import { recordServiceCall } from "./telemetry";
import { safeErrorMessage } from "@/lib/safe-error";

/**
 * App Services broker — governed app-to-app data requests.
 *
 * A consumer app reaches another app's data only through `context.services`,
 * built here and injected by `buildAppContext` / `buildSystemAppContext` when
 * the app declares `consumes`. The broker enforces every boundary the platform
 * can't get from the DB (there is no RLS): two-sided consent (default deny),
 * a provider the app gate lets run (active, and not being updated, whatever
 * the audience), re-authorizing the user in the *provider's* own terms,
 * provider-scoped execution, error isolation, a timeout, and a payload cap.
 * Provider handlers are leaves — the `ServiceContext` intentionally carries no
 * `services` client, so a handler cannot chain to another provider (no
 * cycles, no impersonation).
 * A request from an MCP tool runs the provider read-only, because the tool is.
 *
 * Keep this the ONLY cross-app data path: an ESLint rule blocks apps from
 * importing the raw DB client or this module directly.
 */

const REQUEST_TIMEOUT_MS = 10_000;
/** ~5 MB serialized — keeps one call from returning an unbounded blob. */
const MAX_PAYLOAD_CHARS = 5_000_000;

export type ServiceErrorCode =
  | "NOT_FOUND" // provider app doesn't exist
  | "NOT_EXPOSED" // provider doesn't provide this service
  | "NOT_DECLARED" // consumer didn't declare the dependency
  | "FORBIDDEN" // provider's consumers allowlist excludes the caller
  | "PROVIDER_INACTIVE" // an admin has switched the provider app off
  | "PROVIDER_UPDATING" // the provider's own migrations are behind this build
  | "NO_USER" // audience "user" but no acting user (job/public context)
  | "FORBIDDEN_USER" // user lacks access to the provider app
  | "NO_HANDLER" // handler file missing / no default export
  | "TIMEOUT"
  | "PAYLOAD_TOO_LARGE"
  | "PROVIDER_ERROR"; // handler threw

export class ServiceRequestError extends Error {
  code: ServiceErrorCode;
  constructor(code: ServiceErrorCode, message: string) {
    super(message);
    this.name = "ServiceRequestError";
    this.code = code;
  }
}

interface ServicesClientDeps {
  /** Slug of the consuming app (the one whose context this client is on). */
  callerSlug: string;
  /** Acting user — non-null in a request context, null in a job/public context. */
  actingUser: AppContextUser | null;
  /**
   * The caller is read-only: an MCP tool. The provider's handler then gets a
   * read-only `db` and connectors narrowed to their declared reads, so a tool
   * cannot write by asking another app to.
   */
  readOnly?: boolean;
}

export function createServicesClient(deps: ServicesClientDeps): ServicesClient {
  return {
    request<T = unknown>(
      providerSlug: string,
      serviceName: string,
      params?: unknown,
    ): Promise<T> {
      return runServiceRequest(
        deps,
        providerSlug,
        serviceName,
        params,
      ) as Promise<T>;
    },
  };
}

async function runServiceRequest(
  deps: ServicesClientDeps,
  providerSlug: string,
  serviceName: string,
  params: unknown,
): Promise<unknown> {
  const { callerSlug, actingUser } = deps;

  const provider = appRegistry.find((a) => a.slug === providerSlug);
  if (!provider) {
    throw new ServiceRequestError("NOT_FOUND", `No app "${providerSlug}".`);
  }

  const service = provider.provides.find((s) => s.name === serviceName);
  if (!service) {
    throw new ServiceRequestError(
      "NOT_EXPOSED",
      `"${providerSlug}" does not provide a service "${serviceName}".`,
    );
  }

  // Consumer must have declared the dependency (also enforced at build time;
  // re-checked here as defense-in-depth against a stale/forged registry).
  const consumer = appRegistry.find((a) => a.slug === callerSlug);
  const declared = !!consumer?.consumes.some(
    (d) => d.app === providerSlug && d.service === serviceName,
  );
  if (!declared) {
    throw new ServiceRequestError(
      "NOT_DECLARED",
      `"${callerSlug}" has not declared consuming "${providerSlug}:${serviceName}".`,
    );
  }

  // Provider's allowlist must include the caller.
  const allowed =
    service.consumers === "*" || service.consumers.includes(callerSlug);
  if (!allowed) {
    throw new ServiceRequestError(
      "FORBIDDEN",
      `"${providerSlug}:${serviceName}" is not available to "${callerSlug}".`,
    );
  }

  // The app gate, for every audience, before the provider's context is built
  // or its handler imported. An `audience: "app"` service consults no grant,
  // so this is what keeps a switched-off provider from answering a job or a
  // public route. After the consent checks, so only a consumer the provider
  // allows learns that it is off, or being updated.
  //
  // Two codes rather than one, because the consumer's remedy differs: an app
  // an admin switched off stays off until an admin acts, so the consumer
  // degrades, while an update is over once the release step has run, so it
  // can say so and retry. Both are a 503 if the consumer lets them escape.
  const gate = await checkAppGate(providerSlug);
  if (!gate.open) {
    throw gate.reason === "updating"
      ? new ServiceRequestError(
          "PROVIDER_UPDATING",
          `"${providerSlug}" is being updated. Try again shortly.`,
        )
      : new ServiceRequestError(
          "PROVIDER_INACTIVE",
          `"${providerSlug}" is not active.`,
        );
  }

  const audience = service.audience ?? "user";

  // Build the PROVIDER's context (never the caller's). Dynamic import avoids a
  // static import cycle with context.ts (which imports this module).
  const { buildAppContext, buildSystemAppContext } = await import("./context");

  let providerCtx: AppContext | SystemAppContext;

  if (audience === "user") {
    if (!actingUser) {
      throw new ServiceRequestError(
        "NO_USER",
        `"${providerSlug}:${serviceName}" requires a user context.`,
      );
    }
    // Re-authorize the user in the PROVIDER's own terms — never trust that the
    // caller checked. Roles are app-local, so the provider handler re-resolves
    // any role policy itself against `ctx.user`.
    const granted = await hasAppGrant(actingUser.id, providerSlug);
    if (!granted) {
      throw new ServiceRequestError(
        "FORBIDDEN_USER",
        `You don't have access to "${providerSlug}".`,
      );
    }
    providerCtx = await buildAppContext(providerSlug, {
      id: actingUser.id,
      email: actingUser.email,
      display_name: actingUser.displayName,
      is_admin: actingUser.isAdmin,
    });
  } else {
    // audience "app": service-account — no user required.
    providerCtx = await buildSystemAppContext(providerSlug);
  }

  // From an MCP tool, the provider runs read-only like the tool itself. `db`
  // keeps its full-access type, which is what every other caller gets; here it
  // is the read-only client at runtime, so a write throws ReadOnlyError, and
  // `caller.readOnly` lets the handler skip a write rather than fail on it.
  const readOnly = deps.readOnly === true;
  const serviceCtx: ServiceContext = {
    user: providerCtx.user,
    connectors: readOnly
      ? readOnlyConnectors(providerCtx.connectors, connectorRegistry)
      : providerCtx.connectors,
    db:
      readOnly && providerCtx.db
        ? (createReadOnlyScopedClient(providerSlug) as unknown as ScopedClient)
        : providerCtx.db,
    telemetry: providerCtx.telemetry,
    manifest: providerCtx.manifest,
    caller: { appSlug: callerSlug, readOnly },
  };

  const handler = await loadServiceHandler(providerSlug, serviceName);

  // Best-effort attribution (never blocks the call).
  void recordServiceCall({
    providerSlug,
    serviceName,
    callerAppSlug: callerSlug,
    userId: actingUser?.id ?? null,
  });

  let result: unknown;
  try {
    result = await withTimeout(
      Promise.resolve(handler(serviceCtx, params)),
      REQUEST_TIMEOUT_MS,
    );
  } catch (err) {
    if (err instanceof ServiceRequestError) throw err;
    throw new ServiceRequestError(
      "PROVIDER_ERROR",
      // A refused write, or a call to a connector an admin has disabled, is the
      // platform's own message and names no internals.
      refusalMessage(err) ??
        safeErrorMessage(err, `"${providerSlug}:${serviceName}" failed.`),
    );
  }

  // Streaming services return a `Response` (e.g. a file/blob). Pass it through
  // untouched — the JSON payload guard below is meaningless for a stream, and
  // the timeout above only bounded the handler resolving (opening the stream),
  // not its consumption.
  if (result instanceof Response) return result;

  // Payload guard — reject oversized or non-serializable results rather than
  // hand the consumer something unbounded/unstructured.
  if (result !== undefined) {
    let serialized: string;
    try {
      serialized = JSON.stringify(result);
    } catch {
      throw new ServiceRequestError(
        "PROVIDER_ERROR",
        `"${providerSlug}:${serviceName}" returned a non-serializable result.`,
      );
    }
    if (serialized != null && serialized.length > MAX_PAYLOAD_CHARS) {
      throw new ServiceRequestError(
        "PAYLOAD_TOO_LARGE",
        `"${providerSlug}:${serviceName}" returned too much data.`,
      );
    }
  }

  return result;
}

type ServiceHandler = (
  ctx: ServiceContext,
  params: unknown,
) => unknown | Promise<unknown>;

async function loadServiceHandler(
  providerSlug: string,
  serviceName: string,
): Promise<ServiceHandler> {
  let mod: { default?: unknown };
  try {
    mod = await import(`@apps/${providerSlug}/services/${serviceName}`);
  } catch {
    throw new ServiceRequestError(
      "NO_HANDLER",
      `"${providerSlug}:${serviceName}" has no handler on disk.`,
    );
  }
  if (typeof mod.default !== "function") {
    throw new ServiceRequestError(
      "NO_HANDLER",
      `"${providerSlug}:${serviceName}" handler has no default export.`,
    );
  }
  return mod.default as ServiceHandler;
}

function withTimeout<T>(p: Promise<T>, ms: number): Promise<T> {
  return new Promise<T>((resolve, reject) => {
    const timer = setTimeout(
      () =>
        reject(new ServiceRequestError("TIMEOUT", "Service request timed out.")),
      ms,
    );
    p.then(
      (v) => {
        clearTimeout(timer);
        resolve(v);
      },
      (e) => {
        clearTimeout(timer);
        reject(e);
      },
    );
  });
}
