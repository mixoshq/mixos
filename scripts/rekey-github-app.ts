/* This Source Code Form is subject to the terms of the Mozilla Public
 * License, v. 2.0. If a copy of the MPL was not distributed with this
 * file, You can obtain one at https://mozilla.org/MPL/2.0/. */

// `npm run keys:rotate-github-app` — re-encrypt the GitHub App's stored private
// key from the old GITHUB_APP_ENCRYPTION_KEY to a new one, in one command:
//
//   GITHUB_APP_ENCRYPTION_KEY_OLD=<old key> \
//   GITHUB_APP_ENCRYPTION_KEY_NEW=<new key> \
//   DATABASE_URL=<the instance's database> npm run keys:rotate-github-app
//
// In the Docker image it is `node ops/rekey-github-app.cjs`. Then set
// GITHUB_APP_ENCRYPTION_KEY to the new key where the instance runs, and restart
// it. Until both are done, the GitHub page says the key doesn't decrypt.
//
// WHAT IT READS. Its own environment, and nothing else, as the release step
// does (scripts/release.ts): a development checkout's .env files would pair the
// production database with development settings. The keys come from the
// environment rather than the command line, which would put them in the
// process list.
//
// It holds the `github.app` lock, so no admin changes the link meanwhile, and
// records `github.app.key.reencrypt` in the audit log as
// `cli:<os user>@<hostname>`, with the key's fingerprint. Never a key.

import os from "node:os";
import { parseKeyValue } from "../src/lib/env/keys";
import { databaseNamed } from "../src/lib/db/pg-options";

const USAGE =
  "Usage:\n" +
  "  GITHUB_APP_ENCRYPTION_KEY_OLD=<old key> GITHUB_APP_ENCRYPTION_KEY_NEW=<new key> \\\n" +
  "  DATABASE_URL=<database> npm run keys:rotate-github-app";

async function main(): Promise<number> {
  if (!databaseNamed()) {
    console.error(`No database to re-encrypt in: DATABASE_URL is not set.\n\n${USAGE}`);
    return 1;
  }
  const oldRaw = process.env.GITHUB_APP_ENCRYPTION_KEY_OLD ?? "";
  const newRaw = process.env.GITHUB_APP_ENCRYPTION_KEY_NEW ?? "";
  if (!oldRaw || !newRaw) {
    console.error(`Set both the old and the new key.\n\n${USAGE}`);
    return 1;
  }
  const oldKey = parseKeyValue(oldRaw);
  const newKey = parseKeyValue(newRaw);
  if (!oldKey || !newKey) {
    console.error(
      `${!oldKey ? "GITHUB_APP_ENCRYPTION_KEY_OLD" : "GITHUB_APP_ENCRYPTION_KEY_NEW"} isn't 32 bytes, ` +
        "as 64 hex characters or as base64. `npm run keys:generate -- --github-app` prints a new key.",
    );
    return 1;
  }

  const { LockUnavailableError, withPlatformLock } = await import("../src/lib/platform/lock");
  const { RekeyError, rekeyStoredKey } = await import("../src/lib/github/rekey");
  const { recordAdminAction } = await import("../src/lib/apps/admin-audit");
  const { cliActorName } = await import("../src/lib/apps/audit-actors");

  try {
    const result = await withPlatformLock("github.app", () => rekeyStoredKey(oldKey, newKey), { ttlSeconds: 120 });
    if (result.outcome === "nothing-stored") {
      console.log("No GitHub App key is stored here, so there is nothing to re-encrypt.");
      return 0;
    }
    if (result.outcome === "already") {
      console.log("The stored GitHub App key already decrypts with the new key. Nothing changed.");
      return 0;
    }
    await recordAdminAction(
      { id: null, email: cliActorName(os.userInfo().username, os.hostname()) },
      {
        action: "github.app.key.reencrypt",
        targetType: "github-app",
        targetId: result.app ? String(result.app.id) : undefined,
        details: { appSlug: result.app?.slug ?? null, fingerprint: result.fingerprint, via: "cli" },
      },
    );
    console.log(
      `Re-encrypted the GitHub App's private key (${result.fingerprint}) under the new key.\n` +
        "Now set GITHUB_APP_ENCRYPTION_KEY to the new key where the instance runs, and restart it.",
    );
    return 0;
  } catch (err) {
    if (err instanceof LockUnavailableError) {
      console.error("An administrator is changing the GitHub link. Try again in a moment.");
      return 1;
    }
    if (err instanceof RekeyError) {
      console.error(err.message);
      return 1;
    }
    // Name and message only: a database error carries its query's parameters.
    console.error(`Re-encrypting failed: ${err instanceof Error ? `${err.name}: ${err.message}` : "unknown"}`);
    return 1;
  } finally {
    const pool = (globalThis as { __pg?: { end(o?: { timeout?: number }): Promise<void> } }).__pg;
    await pool?.end({ timeout: 5 }).catch(() => {});
  }
}

main().then((code) => {
  process.exitCode = code;
});
