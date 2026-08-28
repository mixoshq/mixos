/* This Source Code Form is subject to the terms of the Mozilla Public
 * License, v. 2.0. If a copy of the MPL was not distributed with this
 * file, You can obtain one at https://mozilla.org/MPL/2.0/. */

import { connectorRegistry } from "@/generated/connector-registry";
import { getDecryptedConfig } from "./config";
import { connectorErrorEnvelope } from "./response";
import type { EnvelopeCategory } from "./response";
import type { BaseConnector, ConnectorTestResult } from "./types";

/**
 * Prove a connector's credentials actually work, with one cheap upstream call.
 *
 * This is what turns "Configured" from a claim into a fact. `configured` only
 * says the required fields are non-empty; an admin who pastes a key with a
 * trailing space, or points at the wrong environment, has a connector that
 * reports Configured and fails on first use. This is how they find out now
 * rather than through a broken widget later.
 *
 * Admin-only — callers must have gone through `requireAdmin()` first.
 */

export type ConnectorTestOutcome =
  | { ok: true; detail: string | null }
  | {
      ok: false;
      category: EnvelopeCategory | "unsupported";
      message: string;
      adminHint: string | null;
      upstreamRequestId: string | null;
    };

interface TestableConnector extends BaseConnector {
  testConnection(): Promise<ConnectorTestResult>;
}

function supportsTesting(instance: BaseConnector): instance is TestableConnector {
  return typeof (instance as TestableConnector).testConnection === "function";
}

export async function runConnectorTest(
  connectorName: string,
): Promise<ConnectorTestOutcome> {
  const manifest = connectorRegistry.find((c) => c.name === connectorName);
  if (!manifest) {
    return {
      ok: false,
      category: "unsupported",
      message: `No connector named "${connectorName}" is registered.`,
      adminHint: "Regenerate the registry (npm run registry) and reload.",
      upstreamRequestId: null,
    };
  }

  try {
    const mod = await import(`@connectors/${connectorName}/index`);
    const ConnectorClass =
      mod.default ??
      mod[Object.keys(mod).find((k) => typeof mod[k] === "function")!];
    const instance: BaseConnector = new ConnectorClass();

    if (!supportsTesting(instance)) {
      return {
        ok: false,
        category: "unsupported",
        message: `${manifest.displayName} doesn't support connection testing yet.`,
        adminHint:
          "Extend HttpConnector and implement testConnection() — see docs/connectors/implementation.md.",
        upstreamRequestId: null,
      };
    }

    const credentials = await getDecryptedConfig(connectorName);
    if (credentials) await instance.initialize(credentials);

    const result = await instance.testConnection();
    return { ok: true, detail: result.detail ?? null };
  } catch (err) {
    // Admin-only surface, so admin-only detail is appropriate here — but it
    // still comes from our own classification, never an upstream body.
    const { body } = connectorErrorEnvelope(err, { isAdmin: true });
    console.error(
      `[connector-test] ${connectorName} failed:`,
      body.error.category,
      body.error.status ?? "",
    );
    return {
      ok: false,
      category: body.error.category,
      message: body.error.message,
      adminHint: body.error.adminHint ?? null,
      upstreamRequestId: body.error.upstreamRequestId ?? null,
    };
  }
}
