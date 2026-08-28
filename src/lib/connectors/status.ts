/* This Source Code Form is subject to the terms of the Mozilla Public
 * License, v. 2.0. If a copy of the MPL was not distributed with this
 * file, You can obtain one at https://mozilla.org/MPL/2.0/. */

import { TOKEN_KEYS } from "./oauth";
import type { ConnectorAuthPolicy } from "./types";

/**
 * How ready a connector's stored credentials actually are.
 *
 * WHY THIS IS ITS OWN MODULE. This rule used to live only inside
 * `HttpConnector.configured`, and the admin page answered the same question a
 * second way — by asking whether a `connector_configs` row existed at all. The
 * two disagreed in the case that matters most: an admin who saves a client ID
 * and secret for a three-legged connector and never presses Connect had a row,
 * so the registry said **Configured**, while the runtime correctly reported
 * `configured: false` and refused every call. Invariant 12 says `configured`
 * must reflect reality; one exported function is what makes that checkable
 * instead of a thing two files each promise separately.
 *
 * `needs-authorization` exists for exactly that case, and only three-legged
 * OAuth can produce it — every other strategy is ready as soon as its declared
 * keys are non-empty.
 */
export type ConnectorConfigState =
  | "ready"
  | "needs-authorization"
  | "unconfigured";

export function connectorConfigState(
  auth: ConnectorAuthPolicy | undefined,
  credentials: Record<string, string> | null | undefined,
): ConnectorConfigState {
  const creds = credentials ?? {};
  const has = (...keys: string[]) =>
    keys.length > 0 && keys.every((k) => (creds[k] ?? "").length > 0);

  if (auth?.strategy === "oauth2_authorization_code") {
    const [idKey, secretKey] = auth.credentialKeys ?? ["clientId", "clientSecret"];
    if (!has(idKey, secretKey)) return "unconfigured";
    // The client credentials identify the app; only a grant lets it call.
    return has(TOKEN_KEYS.refresh) || has(TOKEN_KEYS.access)
      ? "ready"
      : "needs-authorization";
  }

  const keys = auth?.credentialKeys;
  if (keys && keys.length > 0) {
    return has(...keys) ? "ready" : "unconfigured";
  }

  // No declaration to go on: any credential at all counts as configured.
  return Object.values(creds).some((v) => (v ?? "").length > 0)
    ? "ready"
    : "unconfigured";
}
