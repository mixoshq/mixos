/* This Source Code Form is subject to the terms of the Mozilla Public
 * License, v. 2.0. If a copy of the MPL was not distributed with this
 * file, You can obtain one at https://mozilla.org/MPL/2.0/. */

import { connectorRegistry } from "@/generated/connector-registry";
import {
  AppCredentialsError,
  appCredentialTarget,
  getDecryptedAppConfig,
  refreshAppConnectorTokens,
} from "./app-config";
import { getDecryptedConfig } from "./config";
import { HttpConnector, TOKEN_SKEW_MS } from "./http-connector";
import { ConnectorLoadError, constructConnector } from "./loader";
import { connectorErrorEnvelope } from "./response";
import type { EnvelopeCategory } from "./response";
import { isConnectorDisabled } from "./switch";
import { initializeWithUserGrant } from "./user-grant";
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
      category: EnvelopeCategory | "unsupported" | "disabled";
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
  opts: {
    /**
     * Who is running the test. A user-scoped connector has no deployment-wide
     * grant to test with, so it is tested with this person's own.
     */
    userId?: string;
    /**
     * Test one app's own credentials (./app-config.ts) rather than the shared
     * ones. Never falls back to the shared row: an app with none fails.
     */
    appSlug?: string;
  } = {},
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
    // Turned off by an admin (./switch.ts): not constructed, so not tested.
    // Inside the try, so a switch that cannot be read fails the test rather
    // than running it.
    if (await isConnectorDisabled(connectorName)) {
      return {
        ok: false,
        category: "disabled",
        message: `${manifest.displayName} is disabled. Enable it to test the connection.`,
        adminHint: null,
        upstreamRequestId: null,
      };
    }

    const instance: BaseConnector = await constructConnector(connectorName);

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

    if (opts.appSlug !== undefined) {
      appCredentialTarget(connectorName, opts.appSlug);
      const own = await getDecryptedAppConfig(connectorName, opts.appSlug);
      if (!own) {
        return {
          ok: false,
          category: "unconfigured",
          message: `This app has no ${manifest.displayName} credentials of its own. Save them first.`,
          adminHint: null,
          upstreamRequestId: null,
        };
      }
      const appSlug = opts.appSlug;
      HttpConnector.bindAppGrant(instance, (rejected?: string) =>
        refreshAppConnectorTokens({
          connectorName,
          appSlug,
          subject: manifest.displayName,
          policy: manifest.auth ?? { strategy: "none" },
          skewMs: TOKEN_SKEW_MS,
          rejected,
        }),
      );
      await instance.initialize(own);
      const result = await instance.testConnection();
      return { ok: true, detail: result.detail ?? null };
    }

    const credentials = await getDecryptedConfig(connectorName);
    if (manifest.userScoped) {
      // The tenant row holds the application, never a grant, so testing it
      // alone could only ever fail. The admin's own grant — from Connect in
      // the Authorize step — proves the registration works end to end.
      const connected = opts.userId
        ? await initializeWithUserGrant(instance, {
            userId: opts.userId,
            manifest,
            tenantCredentials: credentials,
          })
        : false;
      if (!connected) {
        return {
          ok: false,
          category: "unconfigured",
          message: `Connect your own ${manifest.displayName} account in the step before this one, or reconnect it if its access has lapsed. Each person signs in with their own account, so the test runs with yours.`,
          adminHint: null,
          upstreamRequestId: null,
        };
      }
    } else if (credentials) {
      await instance.initialize(credentials);
    }

    const result = await instance.testConnection();
    return { ok: true, detail: result.detail ?? null };
  } catch (err) {
    if (err instanceof AppCredentialsError) {
      return { ok: false, category: "unsupported", message: err.message, adminHint: null, upstreamRequestId: null };
    }
    if (err instanceof ConnectorLoadError) {
      // The log below names only a category, which for this would be
      // `internal_error`: say what actually happened, and why.
      console.error(`[connector-test] ${err.message}`, err.cause ?? "");
      // Registered but not in the map this server was built from: the same
      // answer as for a connector missing from the registry, above. A module
      // that throws at load is a bug in it, and keeps the general answer.
      if (err.reason === "missing") {
        return {
          ok: false,
          category: "unsupported",
          message: `${manifest.displayName} isn't in this server's connector map.`,
          adminHint: "Regenerate the registry (npm run registry) and reload.",
          upstreamRequestId: null,
        };
      }
    }
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
