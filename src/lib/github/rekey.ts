/* This Source Code Form is subject to the terms of the Mozilla Public
 * License, v. 2.0. If a copy of the MPL was not distributed with this
 * file, You can obtain one at https://mozilla.org/MPL/2.0/. */

/**
 * Re-encrypt the stored App key from the old GITHUB_APP_ENCRYPTION_KEY to a
 * new one: the work of `npm run keys:rotate-github-app`
 * (scripts/rekey-github-app.ts).
 *
 * Rotating the key without this would leave the App's private key unreadable,
 * and an admin's way out would be to unlink and link again, which leaves the
 * old App behind on GitHub. So the stored key is decrypted with the old key and
 * encrypted with the new one, in one transaction, with the row locked, and the
 * new ciphertext checked before it is written.
 *
 * Run twice, it says the key is already under the new one, so it is safe to
 * repeat. The plaintext key is a local variable here and is never printed.
 */

import type { Sql } from "postgres";
import { decrypt, encrypt } from "@/lib/connectors/encryption";
import { sql } from "@/lib/db/client";
import { keyFingerprint, parsePrivateKey } from "./jwt";
import { AppRecordSchema, SETTING, type AppRecord } from "./store";

export class RekeyError extends Error {
  constructor(message: string) {
    super(message);
    this.name = "RekeyError";
  }
}

export type RekeyResult =
  /** No App key is stored, so there is nothing to re-encrypt. */
  | { outcome: "nothing-stored" }
  /** The stored key already decrypts with the new key. */
  | { outcome: "already"; app: AppRecord | null }
  | { outcome: "reencrypted"; app: AppRecord | null; fingerprint: string };

function appFrom(value: string | undefined): AppRecord | null {
  if (!value) return null;
  try {
    const parsed = AppRecordSchema.safeParse(JSON.parse(value));
    return parsed.success ? parsed.data : null;
  } catch {
    return null;
  }
}

export async function rekeyStoredKey(oldKey: Buffer, newKey: Buffer, db: Sql = sql): Promise<RekeyResult> {
  if (oldKey.equals(newKey)) throw new RekeyError("The old and the new key are the same.");
  return db.begin(async (tx) => {
    const rows = (await tx`
      select key, value from public.platform_settings
      where key = any(${[SETTING.key, SETTING.app]})
      for update
    `) as unknown as { key: string; value: string }[];
    const stored = rows.find((r) => r.key === SETTING.key)?.value;
    if (!stored) return { outcome: "nothing-stored" } as RekeyResult;
    const app = appFrom(rows.find((r) => r.key === SETTING.app)?.value);

    let pem: string;
    try {
      pem = decrypt(stored, oldKey);
    } catch {
      try {
        decrypt(stored, newKey);
      } catch {
        throw new RekeyError(
          "Neither key decrypts the stored App key. Check which GITHUB_APP_ENCRYPTION_KEY the instance runs with.",
        );
      }
      return { outcome: "already", app } as RekeyResult;
    }

    let fingerprint: string;
    try {
      fingerprint = keyFingerprint(parsePrivateKey(pem));
    } catch {
      throw new RekeyError("The stored App key decrypts, but isn't a private key. Replace it on Developers > GitHub App.");
    }
    const sealed = encrypt(pem, newKey);
    if (decrypt(sealed, newKey) !== pem) throw new RekeyError("The re-encrypted key didn't decrypt. Nothing changed.");
    await tx`
      update public.platform_settings set value = ${sealed}, updated_at = now() where key = ${SETTING.key}
    `;
    return { outcome: "reencrypted", app, fingerprint } as RekeyResult;
  });
}
