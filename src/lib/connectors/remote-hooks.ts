/* This Source Code Form is subject to the terms of the Mozilla Public
 * License, v. 2.0. If a copy of the MPL was not distributed with this
 * file, You can obtain one at https://mozilla.org/MPL/2.0/. */

/**
 * How HttpConnector's platform-only statics (`bindUserGrant`, `bindAppGrant`,
 * `allowWrites`) reach a connector that runs in a runner
 * (src/lib/runners/remote-connector.ts), without importing it: the platform
 * calls them on whatever `constructConnector` returned, in process or not.
 */

export const REMOTE_CONNECTOR = Symbol.for("mixos.remoteConnector");

export interface RemoteConnectorHooks {
  bindGrant(refresh: (rejected?: string) => Promise<Record<string, string>>): void;
  allowWrites(): void;
}

export function remoteHooks(connector: unknown): RemoteConnectorHooks | undefined {
  if (!connector || typeof connector !== "object") return undefined;
  const hooks = (connector as Record<symbol, unknown>)[REMOTE_CONNECTOR];
  return hooks && typeof hooks === "object" ? (hooks as RemoteConnectorHooks) : undefined;
}
