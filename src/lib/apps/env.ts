/* This Source Code Form is subject to the terms of the Mozilla Public
 * License, v. 2.0. If a copy of the MPL was not distributed with this
 * file, You can obtain one at https://mozilla.org/MPL/2.0/. */

import { createServiceClient } from "@/lib/db/supabase";
import { decrypt, encrypt } from "@/lib/connectors/encryption";
import type { AppEnvField } from "@/lib/apps/types";
import { platformKey } from "@/lib/env/keys";

/**
 * App-scoped settings, read as `context.env.<KEY>`.
 *
 * This exists so `process.env` can be banned outright in app code. An app that
 * reads the raw environment can read `CONNECTOR_ENCRYPTION_KEY` and
 * `SUPABASE_SERVICE_ROLE_KEY`; an app that reads `context.env` sees only the
 * keys it declared in its manifest, filled in by an admin.
 *
 * `password`-typed values are encrypted at rest on the same AES-256-GCM path
 * connector credentials use — one encryption story for the platform, not two.
 *
 * The client is a frozen plain object rather than a getter: values are resolved
 * once when the context is built, so a handler cannot observe a setting changing
 * mid-request, and nothing an app does can reach back into the store.
 */
export type AppEnv = Readonly<Record<string, string | undefined>>;

interface StoredSetting {
  key: string;
  value: string;
  encrypted: boolean;
}

export async function loadAppEnv(
  appSlug: string,
  declared: AppEnvField[],
): Promise<AppEnv> {
  if (declared.length === 0) return Object.freeze({});

  const supabase = createServiceClient();
  const { data } = await supabase
    .from("app_settings")
    .select("key, value, encrypted")
    .eq("app_slug", appSlug);

  const stored = new Map<string, StoredSetting>(
    ((data as StoredSetting[] | null) ?? []).map((row) => [row.key, row]),
  );

  const env: Record<string, string | undefined> = {};
  for (const field of declared) {
    const row = stored.get(field.key);
    if (!row) {
      env[field.key] = undefined;
      continue;
    }
    try {
      env[field.key] = row.encrypted
        ? decrypt(row.value, platformKey("appSettingsEncryption"))
        : row.value;
    } catch {
      // A value that will not decrypt is treated as unset rather than as an
      // error: an app guarding `if (!ctx.env.X)` already handles "not
      // configured", and a 500 here would take down every route in the app.
      console.error(`[app-env] ${appSlug}.${field.key} failed to decrypt`);
      env[field.key] = undefined;
    }
  }

  return Object.freeze(env);
}

/** Admin-side write. `password` fields are encrypted before they reach the DB. */
export async function setAppSetting(
  appSlug: string,
  field: AppEnvField,
  value: string,
): Promise<void> {
  const supabase = createServiceClient();
  const shouldEncrypt = field.type === "password";
  await supabase.from("app_settings").upsert(
    {
      app_slug: appSlug,
      key: field.key,
      value: shouldEncrypt
        ? encrypt(value, platformKey("appSettingsEncryption"))
        : value,
      encrypted: shouldEncrypt,
      updated_at: new Date().toISOString(),
    },
    { onConflict: "app_slug,key" },
  );
}
