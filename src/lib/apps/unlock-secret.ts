/* This Source Code Form is subject to the terms of the Mozilla Public
 * License, v. 2.0. If a copy of the MPL was not distributed with this
 * file, You can obtain one at https://mozilla.org/MPL/2.0/. */

/**
 * Signing key for the public passcode-unlock cookies used by app public pages
 * (the platform password-unlock in public-access.ts, plus any per-app variant an
 * app builds on top of it).
 *
 * Resolution order:
 *  1. `APP_UNLOCK_SECRET` if explicitly set (≥32 chars) — lets an operator pin
 *     a dedicated secret when they want independent rotation.
 *  2. Otherwise derive a 32-byte key from `CONNECTOR_ENCRYPTION_KEY`, which is
 *     already provisioned (an env secret, never committed). This avoids
 *     managing a second secret in the deployment environment.
 *
 * We derive via HMAC with a fixed label rather than using `CONNECTOR_ENCRYPTION_KEY`
 * raw: HMAC is a PRF, so the derived key is cryptographically separated from the
 * AES-GCM credential-encryption use of the base key — leaking this cookie-signing
 * key cannot be used to recover `CONNECTOR_ENCRYPTION_KEY` or decrypt connector
 * credentials. Bump the label if you ever need to invalidate all unlock cookies
 * without touching the base key (visitors just re-enter their passcode).
 */
import { createHmac } from "node:crypto";

const DERIVE_LABEL = "mixapp-unlock-secret-v1";

export function getUnlockSigningKey(): Buffer {
  const explicit = process.env.APP_UNLOCK_SECRET;
  if (explicit && explicit.length >= 32) {
    return Buffer.from(explicit, "utf-8");
  }

  const enc = process.env.CONNECTOR_ENCRYPTION_KEY;
  if (enc && enc.length >= 32) {
    // CONNECTOR_ENCRYPTION_KEY is a 32-byte hex string (see connectors/encryption.ts).
    return createHmac("sha256", Buffer.from(enc, "hex")).update(DERIVE_LABEL).digest();
  }

  throw new Error(
    "Cannot sign unlock cookies: set APP_UNLOCK_SECRET (≥32 chars) or " +
      "CONNECTOR_ENCRYPTION_KEY (the unlock key is derived from it).",
  );
}
