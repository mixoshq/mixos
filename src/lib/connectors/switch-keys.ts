/* This Source Code Form is subject to the terms of the Mozilla Public
 * License, v. 2.0. If a copy of the MPL was not distributed with this
 * file, You can obtain one at https://mozilla.org/MPL/2.0/. */

/**
 * The `platform_settings` keys the server (./switch.ts) and the release step
 * (scripts/sync-identities.ts) share for a connector: its switch, the mark the
 * release step sets when a different connector takes its name, and the mark it
 * sets when a build lacks a connector this database holds credentials for.
 * Delete data (src/lib/repository/delete-data.ts) deletes all of them.
 *
 * No imports: the release step is bundled without the server's modules.
 */

/** `connector.disabled.<name>`: the switch. Its value is when it was turned off. */
export const SWITCH_KEY_PREFIX = "connector.disabled.";

/**
 * `connector.replaced.<name>`: set by the release step when a different
 * connector took the name, with the identity it replaced as its value. Enable
 * needs the name typed while it is set, and clears it.
 */
export const REPLACED_KEY_PREFIX = "connector.replaced.";

/**
 * `connector.missing.<name>`: set by a release step whose build lacks a
 * connector this database holds credentials or connections for, with when as
 * its value. Cleared when a build carries it again. Delete data needs it.
 */
export const MISSING_KEY_PREFIX = "connector.missing.";

/** The key that holds one connector's switch. */
export function connectorSwitchKey(connectorName: string): string {
  return `${SWITCH_KEY_PREFIX}${connectorName}`;
}

/** The key that says a different connector took this one's name. */
export function connectorReplacedKey(connectorName: string): string {
  return `${REPLACED_KEY_PREFIX}${connectorName}`;
}

/** The key that says a release step ran without this connector. */
export function connectorMissingKey(connectorName: string): string {
  return `${MISSING_KEY_PREFIX}${connectorName}`;
}
