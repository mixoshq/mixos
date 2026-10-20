/* This Source Code Form is subject to the terms of the Mozilla Public
 * License, v. 2.0. If a copy of the MPL was not distributed with this
 * file, You can obtain one at https://mozilla.org/MPL/2.0/. */

import { isDisabledConnector } from "@/lib/connectors/switch";
import type { ConnectorRequirement } from "@/lib/connectors/requirements";
import type { BaseConnector, ConnectorTelemetryDefinition } from "@/lib/connectors/types";
import { ConnectorChangesNotAllowedError } from "@/lib/connectors/write-policy";

/**
 * What a caller can reach on a connector: its declared methods, and nothing
 * else.
 *
 * A connector's manifest lists every public method in `telemetry`, each read
 * or `mutates`, and the build holds the class to that list
 * (scripts/connector-checks.ts). This holds the caller to it. An app gets its
 * connectors through here (src/lib/apps/context.ts), and an MCP tool through
 * the read-only rules in ./read-only.ts.
 *
 *   - A declared read can always be called.
 *   - A declared write can be called when the rules say so: for an app, when
 *     its entry asks for `"access": "write"` and the connector's admin has
 *     allowed changes; for an MCP tool, never.
 *   - Anything else callable is refused. Notably the base class's `request()`,
 *     which is protected to the compiler but reachable with `as any` at
 *     runtime, and sends any verb to any path with the connector's credential.
 *     Also `paginate()`, `initialize()`, `testConnection()` and
 *     `handleWebhook()`, which only the platform calls.
 *
 * Plain values (`name`, `configured`) pass through. A connector an admin
 * turned off arrives as the context builder's stand-in and is handed on as it
 * is: every call on it already fails with the reason that matters.
 *
 * Kept free of the generated registry so it can be tested on its own: callers
 * pass the declarations in.
 */

export interface ReachRules {
  /** May the caller run a method declared `mutates`? */
  writes: boolean;
  /** The error for a declared write the caller may not run. */
  refuseWrite: (method: string) => Error;
  /** The error for anything callable the manifest doesn't declare. */
  refuseUndeclared: (member: string) => Error;
}

export function narrowConnector(
  connector: BaseConnector,
  declared: readonly ConnectorTelemetryDefinition[],
  rules: ReachRules,
): BaseConnector {
  if (isDisabledConnector(connector)) return connector;

  const reads = new Set(declared.filter((m) => !m.mutates).map((m) => m.method));
  const writes = new Set(declared.filter((m) => m.mutates).map((m) => m.method));

  return new Proxy(connector, {
    get(target, prop) {
      // `target` as the receiver, not the proxy: a connector's getters read
      // their own private fields, and routing `this` back through the proxy
      // turns a working getter into a runtime error.
      const value: unknown = Reflect.get(target, prop, target);
      if (typeof value !== "function") return value;
      // `toString`, `hasOwnProperty` and the like are Object's, not the
      // connector's, and string interpolation reaches for them.
      if (value === Reflect.get(Object.prototype, prop)) return value;

      if (typeof prop === "string" && (reads.has(prop) || (rules.writes && writes.has(prop)))) {
        return (...args: unknown[]) => (value as (...a: unknown[]) => unknown).apply(target, args);
      }
      const member = String(prop);
      return () => {
        throw writes.has(member) ? rules.refuseWrite(member) : rules.refuseUndeclared(member);
      };
    },
  });
}

/**
 * Thrown when an app calls something its own manifest doesn't allow it: a
 * write its entry didn't ask for, or a member the connector doesn't declare.
 * A bug in the app, for its developer, so it is not a ConnectorError: the
 * route pipeline answers it as an internal error, and the message goes to the
 * server log, where the smoke test's failure points.
 */
export class ConnectorUseError extends Error {
  constructor(message: string) {
    super(message);
    this.name = "ConnectorUseError";
  }
}

/**
 * The rules for one app and one of its connectors. A write runs only with
 * both keys: the app's entry asks for "write", and the admin allowed changes.
 * Which key is missing decides the refusal, because each is someone else's to
 * turn: the app's developer, or the connector's admin.
 */
export function appReachRules(opts: {
  appSlug: string;
  connectorName: string;
  subject: string;
  need: Pick<ConnectorRequirement, "access"> | undefined;
  /** Whether the connector's admin allowed changes (src/lib/connectors/writable.ts). */
  writable: boolean;
}): ReachRules {
  const { appSlug, connectorName, subject, need, writable } = opts;
  const asked = need?.access === "write";
  return {
    writes: asked && writable,
    refuseWrite: (method) =>
      asked
        ? new ConnectorChangesNotAllowedError(connectorName, subject)
        : new ConnectorUseError(
            `apps/${appSlug} called ${connectorName}.${method}(), which changes data, but its app.json entry ` +
              `for ${connectorName} doesn't ask for "access": "write".`,
          ),
    refuseUndeclared: (member) =>
      new ConnectorUseError(
        `apps/${appSlug} called ${connectorName}.${member}(), which connectors/${connectorName}/connector.json ` +
          `doesn't declare. An app calls only a connector's declared methods.`,
      ),
  };
}
