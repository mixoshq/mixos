/* This Source Code Form is subject to the terms of the Mozilla Public
 * License, v. 2.0. If a copy of the MPL was not distributed with this
 * file, You can obtain one at https://mozilla.org/MPL/2.0/. */

/**
 * Signing key for the app password-unlock cookies (`src/lib/apps/public-access.ts`).
 *
 * `APP_UNLOCK_SECRET` is a required key of its own. Deriving it from another
 * key would be cryptographically sound — HMAC is a PRF, so it could not be
 * worked back to the base — but it would tie the two lifecycles together: the
 * base key could not be rotated without logging every visitor out of every
 * password-protected app at the same moment. See `src/lib/env/keys.ts`.
 *
 * Rotating this key logs unlocked visitors out and nothing else. They re-enter
 * the password.
 */
import { platformKey } from "@/lib/env/keys";

export function getUnlockSigningKey(): Buffer {
  return platformKey("appUnlock");
}
