/* This Source Code Form is subject to the terms of the Mozilla Public
 * License, v. 2.0. If a copy of the MPL was not distributed with this
 * file, You can obtain one at https://mozilla.org/MPL/2.0/. */

import { connectorLoaders } from "@/generated/connector-loaders";
import { loadFromMap } from "@/lib/apps/module-map";
import { connectorLoaderKey } from "./connector-modules";
import type { BaseConnector } from "./types";

/**
 * Constructing a connector from its module: the one place the platform loads
 * connector code, for the app context (src/lib/apps/context.ts), Verify
 * connection (./test-connection.ts) and the webhook route
 * (src/app/api/webhooks/[name]/route.ts).
 *
 * Through the generated map of explicit imports (src/generated/connector-loaders.ts)
 * rather than a template import, so a connector added under `next dev` loads
 * once `npm run registry` has run (scripts/connector-loaders.ts says why).
 *
 * Each caller keeps its own `try` around this, so a connector that won't load
 * lands where an import that failed did. What changes is that the error says
 * which way it failed (src/lib/apps/module-map.ts): missing from the map, which
 * `npm run registry` fixes, or a module that threw at load, whose own error is
 * the thing to read.
 */

export type ConnectorLoadReason = "missing" | "failed";

export class ConnectorLoadError extends Error {
  readonly connector: string;
  readonly reason: ConnectorLoadReason;

  constructor(
    connector: string,
    reason: ConnectorLoadReason,
    message: string,
    options?: { cause?: unknown },
  ) {
    super(message, options);
    this.name = "ConnectorLoadError";
    this.connector = connector;
    this.reason = reason;
  }
}

type ConnectorClass = new () => BaseConnector;

/**
 * A new, uninitialised instance of the named connector's class: the module's
 * default export, or else its first exported function, as the callers have
 * always picked it. A module with neither throws a TypeError at `new`, as it
 * did before.
 *
 * Throws a `ConnectorLoadError` when the connector has no loader in the map, or
 * when its module throws while loading (the module's error is the `cause`).
 */
export async function constructConnector(name: string): Promise<BaseConnector> {
  const load = await loadFromMap(connectorLoaders, connectorLoaderKey(name));
  if (load.kind === "missing") {
    throw new ConnectorLoadError(
      name,
      "missing",
      `${load.key} is not in the generated connector map. Run \`npm run registry\`.`,
    );
  }
  if (load.kind === "failed") {
    throw new ConnectorLoadError(name, "failed", `${load.key} failed to load`, {
      cause: load.error,
    });
  }

  const mod = load.module;
  const Class = (mod.default ??
    mod[Object.keys(mod).find((k) => typeof mod[k] === "function")!]) as ConnectorClass;
  return new Class();
}
