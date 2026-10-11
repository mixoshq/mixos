/* This Source Code Form is subject to the terms of the Mozilla Public
 * License, v. 2.0. If a copy of the MPL was not distributed with this
 * file, You can obtain one at https://mozilla.org/MPL/2.0/. */

/**
 * The `platform_settings` keys behind a connector's switch, shared by the
 * server (./switch.ts) and the release step (scripts/sync-identities.ts),
 * which turns a connector off when a different one takes its name.
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

/** The key that holds one connector's switch. */
export function connectorSwitchKey(connectorName: string): string {
  return `${SWITCH_KEY_PREFIX}${connectorName}`;
}

/** The key that says a different connector took this one's name. */
export function connectorReplacedKey(connectorName: string): string {
  return `${REPLACED_KEY_PREFIX}${connectorName}`;
}
