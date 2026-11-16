/* This Source Code Form is subject to the terms of the Mozilla Public
 * License, v. 2.0. If a copy of the MPL was not distributed with this
 * file, You can obtain one at https://mozilla.org/MPL/2.0/. */

import { ConnectorError } from "./errors";
import type {
  ConnectorAuthPolicy,
  ConnectorManifest,
  ConnectorScope,
  ConnectorTelemetryDefinition,
} from "./types";

/**
 * What a connector's manifest says about changing data, read the same way by
 * the server and by the admin screens. Pure, and safe on the client.
 *
 * A connector changes data through the methods it declares `mutates`. On an
 * install, those run only once an admin has allowed changes (./writable.ts),
 * and only for an app whose entry asks for `"access": "write"`. A scope the
 * connector requests with `"write"` is asked for only once changes are
 * allowed, so a read-only install never holds it.
 */

/** The methods that change data upstream, in declared order. */
export function writeMethods(
  manifest: Pick<ConnectorManifest, "telemetry"> | undefined,
): ConnectorTelemetryDefinition[] {
  return (manifest?.telemetry ?? []).filter((t) => t.mutates === true);
}

/** Does the connector have anything for Allow changes to allow? */
export function declaresWrites(manifest: Pick<ConnectorManifest, "telemetry"> | undefined): boolean {
  return writeMethods(manifest).length > 0;
}

/** Is a scope asked for, on an install that does or doesn't allow changes? */
export function isScopeRequested(scope: Pick<ConnectorScope, "requested">, writes: boolean): boolean {
  return scope.requested === true || (writes && scope.requested === "write");
}

/** The scopes asked for only once changes are allowed. */
export function writeScopes(policy: Pick<ConnectorAuthPolicy, "scopes"> | undefined): string[] {
  return (policy?.scopes ?? []).filter((s) => s.requested === "write").map((s) => s.scope);
}

/**
 * What a write fails with on an install whose admin hasn't allowed changes,
 * for an app that asked for them.
 *
 * `forbidden`, the category for "valid, but not allowed this": its envelope
 * offers no Retry, which is right for a refusal that stands until an admin
 * acts, and the hint says where.
 */
export class ConnectorChangesNotAllowedError extends ConnectorError {
  constructor(connectorName: string, subject: string = connectorName) {
    super({
      category: "forbidden",
      connectorName,
      subject,
      userMessage: `${subject} is read-only here, so this change can't be made. An administrator can allow changes.`,
      adminHint:
        "Open Administration → Connectors and allow this connector to change data. If it signs in with OAuth, connect it again afterwards, so the provider grants the write access too.",
    });
  }
}

/**
 * The scopes a grant holds: each one it names, and each one those include,
 * followed through (`includes` on an `auth.scopes` entry).
 *
 * A provider can grant a broad scope in place of the narrower ones it covers
 * and name only the broad one: asked for `data:read` and `data:read_write`,
 * Todoist answers `data:read_write`, which it documents as including
 * `data:read`. Read by name alone, a connector holding every scope it needs
 * would show one of them refused. The including scope needs only to be in the
 * grant, whether or not this connector asked for it.
 */
export function heldScopes(
  scopes: readonly Pick<ConnectorScope, "scope" | "includes">[] | undefined,
  granted: readonly string[],
): Set<string> {
  const includes = new Map((scopes ?? []).map((s) => [s.scope, s.includes ?? []]));
  const held = new Set<string>();
  const pending = [...granted];
  for (let scope = pending.pop(); scope !== undefined; scope = pending.pop()) {
    if (held.has(scope)) continue;
    held.add(scope);
    pending.push(...(includes.get(scope) ?? []));
  }
  return held;
}

/**
 * Whether a grant holds the scopes asked for once changes are allowed: true or
 * false when the grant's scopes are known, null when they aren't. A connector
 * that requests none holds them trivially.
 */
export function grantHoldsWriteScopes(
  policy: Pick<ConnectorAuthPolicy, "scopes"> | undefined,
  granted: readonly string[],
  grantedKnown: boolean,
): boolean | null {
  const needed = writeScopes(policy);
  if (needed.length === 0) return true;
  if (!grantedKnown) return null;
  const held = heldScopes(policy?.scopes, granted);
  return needed.every((s) => held.has(s));
}
