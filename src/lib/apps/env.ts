/* This Source Code Form is subject to the terms of the Mozilla Public
 * License, v. 2.0. If a copy of the MPL was not distributed with this
 * file, You can obtain one at https://mozilla.org/MPL/2.0/. */

import { createServiceClient } from "@/lib/db/server";
import { decrypt, encrypt } from "@/lib/connectors/encryption";
import type { AppEnvField } from "@/lib/apps/types";
import { platformKey } from "@/lib/env/keys";

/**
 * App-scoped settings, read as `context.env.<KEY>`.
 *
 * This exists so `process.env` can be banned outright in app code. An app that
 * reads the raw environment can read `CONNECTOR_ENCRYPTION_KEY` and
 * `DATABASE_URL`; an app that reads `context.env` sees only the
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

/**
 * The stored form of one value: a `password` field is encrypted, under its own
 * key, before it reaches the database. Nothing else ever writes the plaintext.
 */
export function encodeAppSetting(
  field: AppEnvField,
  value: string,
): { value: string; encrypted: boolean } {
  return field.type === "password"
    ? { value: encrypt(value, platformKey("appSettingsEncryption")), encrypted: true }
    : { value, encrypted: false };
}

/** Admin-side write. `password` fields are encrypted before they reach the DB. */
export async function setAppSetting(
  appSlug: string,
  field: AppEnvField,
  value: string,
): Promise<void> {
  const supabase = createServiceClient();
  const { error } = await supabase.from("app_settings").upsert(
    {
      app_slug: appSlug,
      key: field.key,
      ...encodeAppSetting(field, value),
      updated_at: new Date().toISOString(),
    },
    { onConflict: "app_slug,key" },
  );
  if (error) throw new Error(`Failed to save ${appSlug}.${field.key}: ${error.message}`);
}

/** Admin-side removal. The app reads the key as unset from its next request. */
export async function clearAppSetting(appSlug: string, key: string): Promise<void> {
  const supabase = createServiceClient();
  const { error } = await supabase
    .from("app_settings")
    .delete()
    .eq("app_slug", appSlug)
    .eq("key", key);
  if (error) throw new Error(`Failed to clear ${appSlug}.${key}: ${error.message}`);
}

/** One declared setting as the admin form shows it. */
export interface AppSettingStatus {
  key: string;
  label: string;
  type: AppEnvField["type"];
  required: boolean;
  /** True when a value is stored. */
  set: boolean;
  /**
   * The stored value of a `text` setting, so the form can show it. Always
   * `null` for a `password` setting: once saved, it is never read back out.
   */
  value: string | null;
  /** When the value was last saved. ISO-8601, or null when unset. */
  updatedAt: string | null;
}

interface StoredSettingRow extends StoredSetting {
  updated_at: string | Date;
}

/**
 * What an admin may see of an app's settings: one entry per declared field,
 * and a value only for a `text` field stored in plain text. A row stored
 * encrypted, or a field now declared `password`, shows as set and nothing more.
 * Rows for keys the manifest no longer declares are not shown.
 */
export function describeAppSettings(
  declared: readonly AppEnvField[],
  rows: readonly StoredSettingRow[],
): AppSettingStatus[] {
  const stored = new Map(rows.map((row) => [row.key, row]));
  return declared.map((field) => {
    const row = stored.get(field.key);
    return {
      key: field.key,
      label: field.label,
      type: field.type,
      required: field.required ?? false,
      set: !!row,
      value:
        row && field.type === "text" && !row.encrypted ? row.value : null,
      updatedAt: row ? new Date(row.updated_at).toISOString() : null,
    };
  });
}

/** An app's declared settings with what is stored for each. For the admin UI. */
export async function readAppSettings(
  appSlug: string,
  declared: readonly AppEnvField[],
): Promise<AppSettingStatus[]> {
  if (declared.length === 0) return [];
  const supabase = createServiceClient();
  const { data, error } = await supabase
    .from("app_settings")
    .select("key, value, encrypted, updated_at")
    .eq("app_slug", appSlug);
  if (error) throw new Error(`Failed to read ${appSlug} settings: ${error.message}`);
  return describeAppSettings(declared, (data as StoredSettingRow[] | null) ?? []);
}
