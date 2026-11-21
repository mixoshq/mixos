/* This Source Code Form is subject to the terms of the Mozilla Public
 * License, v. 2.0. If a copy of the MPL was not distributed with this
 * file, You can obtain one at https://mozilla.org/MPL/2.0/. */

import { connectorRegistry } from "@/generated/connector-registry";
import type { AppContextUser, ServicesClient } from "@/lib/hooks/types";
import type { BaseConnector } from "@/lib/connectors/types";
import { readOnlyConnectors } from "./read-only";
import { createReadOnlyScopedClient, type ReadOnlyScopedClient } from "./scoped-db";
import { createServicesClient } from "./services";
import type { TelemetryClient } from "./telemetry";
import type { AppManifest } from "./types";

/** The read-only half of an app's context: what an MCP tool and a search handler share. */
export interface ReadOnlyAppContext {
  user: AppContextUser;
  connectors: Record<string, BaseConnector>;
  db: ReadOnlyScopedClient | null;
  telemetry: TelemetryClient | null;
  services: ServicesClient | null;
  manifest: AppManifest;
}

/**
 * Build the app's own context for this person, then narrow it so nothing in it
 * can write: the scoped DB swapped for a read-only one, connectors narrowed to
 * their declared reads, App Services calls made read-only for the provider too,
 * and no `notifications` or `hooks`.
 *
 * Reusing `buildAppContext` is the point — a caller gets exactly the
 * connectors, roles and scoped DB the app's own API routes get for this user,
 * so there is no second, subtly different authorization surface to keep in
 * step. One function, used by the MCP broker (src/lib/mcp/broker.ts) and the
 * search broker (src/lib/search/broker.ts), so the two cannot drift.
 */
export async function buildReadOnlyAppContext(
  slug: string,
  dbUser: { id: string; email: string; display_name: string; is_admin: boolean },
): Promise<ReadOnlyAppContext> {
  // Dynamic import, as services.ts does: keeps a static cycle from forming
  // with the context builder.
  const { buildAppContext } = await import("./context");
  const appCtx = await buildAppContext(slug, dbUser);
  return {
    user: appCtx.user,
    connectors: readOnlyConnectors(appCtx.connectors, connectorRegistry),
    db: appCtx.manifest.database ? createReadOnlyScopedClient(slug) : null,
    telemetry: appCtx.telemetry,
    // Not `appCtx.services`: that client runs the provider's handler with a
    // writable db and connectors, and a read-only caller must not be able to
    // write by asking another app to. This one runs it read-only.
    services:
      appCtx.manifest.consumes.length > 0
        ? createServicesClient({
            callerSlug: slug,
            actingUser: appCtx.user,
            readOnly: true,
          })
        : null,
    manifest: appCtx.manifest,
  };
}
