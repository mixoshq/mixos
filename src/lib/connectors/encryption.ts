/* This Source Code Form is subject to the terms of the Mozilla Public
 * License, v. 2.0. If a copy of the MPL was not distributed with this
 * file, You can obtain one at https://mozilla.org/MPL/2.0/. */

import { createCipheriv, createDecipheriv, randomBytes } from "crypto";

const ALGORITHM = "aes-256-gcm";

/**
 * The key is a PARAMETER, not an ambient read.
 *
 * Tenant credentials and per-user OAuth grants are encrypted under different
 * keys (`CONNECTOR_ENCRYPTION_KEY` and `USER_OAUTH_ENCRYPTION_KEY`), so that
 * rotating one does not force every person to reconnect their own account, and
 * a leak of one does not open the other. Both call sites therefore have to say
 * which key they mean — see `src/lib/env/keys.ts` for the inventory.
 */

export function encrypt(plaintext: string, key: Buffer): string {
  const iv = randomBytes(12);
  const cipher = createCipheriv(ALGORITHM, key, iv);
  const encrypted = Buffer.concat([
    cipher.update(plaintext, "utf8"),
    cipher.final(),
  ]);
  const tag = cipher.getAuthTag();
  return [iv, tag, encrypted].map((b) => b.toString("base64")).join(":");
}

export function decrypt(stored: string, key: Buffer): string {
  const [ivB64, tagB64, dataB64] = stored.split(":");
  const decipher = createDecipheriv(
    ALGORITHM,
    key,
    Buffer.from(ivB64, "base64"),
  );
  decipher.setAuthTag(Buffer.from(tagB64, "base64"));
  const decrypted = Buffer.concat([
    decipher.update(Buffer.from(dataB64, "base64")),
    decipher.final(),
  ]);
  return decrypted.toString("utf8");
}
