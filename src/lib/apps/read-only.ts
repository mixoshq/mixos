/* This Source Code Form is subject to the terms of the Mozilla Public
 * License, v. 2.0. If a copy of the MPL was not distributed with this
 * file, You can obtain one at https://mozilla.org/MPL/2.0/. */

import { ConnectorDisabledError } from "@/lib/connectors/switch";
import { ConnectorChangesNotAllowedError } from "@/lib/connectors/write-policy";
import type {
  BaseConnector,
  ConnectorManifest,
  ConnectorTelemetryDefinition,
} from "@/lib/connectors/types";
import { narrowConnector } from "./connector-reach";

/**
 * Read-only connectors, for the MCP path.
 *
 * An MCP tool answers a question; it does not act. Its `ctx.db` has been
 * read-only from the start (`createReadOnlyScopedClient` in ./scoped-db). This
 * is the same rule for connectors, applied in two places: the tool's own
 * `ctx.connectors`, and the provider's connectors when a tool reaches another
 * app through `ctx.services` (src/lib/apps/services.ts), so a tool cannot
 * write by asking another app to.
 *
 * Kept free of the generated registry so it can be tested on its own: callers
 * pass the connector manifests in.
 */

/**
 * Thrown when a read-only caller reaches for something that writes. The message
 * is written for the model that drove the call, and the MCP broker hands it back
 * as the tool's error instead of a generic failure.
 */
export class ReadOnlyError extends Error {
  constructor(message: string) {
    super(message);
    this.name = "ReadOnlyError";
  }
}

/**
 * The message to hand back for a failure the platform itself refused, or null
 * for anything else.
 *
 * Both brokers flatten a handler's error to a generic line in production,
 * since it may name internals. These were written to be read: a write refused
 * here, a call to a connector an admin has disabled, and a write to one an
 * admin hasn't allowed to change data. Passing them on tells the model, or the
 * calling app, why the call failed.
 */
export function refusalMessage(err: unknown): string | null {
  if (err instanceof ReadOnlyError) return err.message;
  if (err instanceof ConnectorDisabledError) return err.userMessage;
  if (err instanceof ConnectorChangesNotAllowedError) return err.userMessage;
  return null;
}

/**
 * A connector narrowed to the methods its manifest declares as reads.
 *
 * Plain properties (`name`, `configured`) pass through. Of everything callable,
 * only a method in the connector's `telemetry` list that is not marked
 * `mutates` can be called. Anything else throws when called:
 *
 *   - a method declared `mutates: true`;
 *   - anything the manifest does not declare — notably the base class's
 *     `request()`, which is protected to the compiler but reachable with
 *     `as any` at runtime, and sends whatever verb it is handed. Also
 *     `paginate()`, `initialize()` and `handleWebhook()`.
 *
 * Refusing what is undeclared costs a tool nothing it could legitimately call:
 * the build fails a connector whose public methods are not all declared
 * (scripts/connector-checks.ts). And it keeps the guard from guessing — the
 * declaration decides, never a method's name.
 *
 * A declared read runs bound to the connector itself, so its own calls to
 * `this.request()` are untouched. This narrows what the caller can reach; what
 * a read does inside is the connector's declaration to keep honest.
 */
export function readOnlyConnector(
  name: string,
  connector: BaseConnector,
  declared: readonly ConnectorTelemetryDefinition[],
): BaseConnector {
  // A connector an admin turned off is handed on as it is (./connector-reach.ts):
  // narrowing it would answer a write or an undeclared method with a read-only
  // refusal, which names the wrong reason.
  return narrowConnector(connector, declared, {
    writes: false,
    refuseWrite: (method) =>
      new ReadOnlyError(
        `"${name}.${method}" changes data upstream and cannot be called from an MCP tool. Tools answer questions; they do not act.`,
      ),
    refuseUndeclared: (method) =>
      new ReadOnlyError(
        `"${name}.${method}" is not one of the reads "${name}" declares, so an MCP tool cannot call it.`,
      ),
  });
}

/**
 * Every connector in a context, each narrowed against its own manifest. A
 * connector missing from `registry` declares no reads, so nothing on it can be
 * called.
 */
export function readOnlyConnectors(
  connectors: Record<string, BaseConnector>,
  registry: readonly Pick<ConnectorManifest, "name" | "telemetry">[],
): Record<string, BaseConnector> {
  const narrowed: Record<string, BaseConnector> = {};
  for (const [name, connector] of Object.entries(connectors)) {
    const declared = registry.find((c) => c.name === name)?.telemetry ?? [];
    narrowed[name] = readOnlyConnector(name, connector, declared);
  }
  return narrowed;
}
