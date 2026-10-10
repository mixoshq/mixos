/* This Source Code Form is subject to the terms of the Mozilla Public
 * License, v. 2.0. If a copy of the MPL was not distributed with this
 * file, You can obtain one at https://mozilla.org/MPL/2.0/. */

"use server";

import { appRegistry } from "@/generated/app-registry";
import { requireReadOnlySession } from "@/lib/auth/session";
import { requireAdmin } from "@/lib/apps/access";
import { recordAdminAction } from "@/lib/apps/admin-audit";
import {
  clearAppSetting,
  readAppSettings,
  setAppSetting,
  type AppSettingStatus,
} from "@/lib/apps/env";
import type { AppEnvField } from "@/lib/apps/types";

/**
 * The admin side of `context.env`: an app declares settings under `env` in its
 * manifest, and an admin fills them in here, from the Settings tab of the app's
 * details dialog.
 *
 * Each action is a directly-invocable POST endpoint, so each checks
 * `requireAdmin()` itself. Only keys the manifest declares can be written, and
 * a `password` value is encrypted before it is stored and never read back.
 * The audit trail records which key changed, never its value.
 */

/** The declared field, or an error naming what was asked for. */
function declaredField(slug: string, key: string): AppEnvField {
  const manifest = appRegistry.find((a) => a.slug === slug);
  if (!manifest) throw new Error("App not found in registry");
  const field = manifest.env.find((f) => f.key === key);
  if (!field) {
    throw new Error(`${slug} declares no setting "${key}" under \`env\` in its app.json.`);
  }
  return field;
}

export async function getAppSettings(slug: string): Promise<AppSettingStatus[]> {
  const session = await requireReadOnlySession();
  await requireAdmin(session);

  const manifest = appRegistry.find((a) => a.slug === slug);
  if (!manifest) throw new Error("App not found in registry");
  return readAppSettings(slug, manifest.env);
}

/**
 * Save one setting. An empty value is refused rather than stored: an app reads
 * an unset key as `undefined`, and clearing is its own action.
 */
export async function setAppSettingAction(
  slug: string,
  key: string,
  value: string,
): Promise<void> {
  const session = await requireReadOnlySession();
  const admin = await requireAdmin(session);

  const field = declaredField(slug, key);
  if (typeof value !== "string" || value === "") {
    throw new Error("Enter a value, or clear the setting.");
  }

  await setAppSetting(slug, field, value);
  await recordAdminAction(
    { id: admin.id, email: admin.email },
    {
      action: "app.setting.set",
      targetType: "app",
      targetId: slug,
      details: { key },
    },
  );
}

export async function clearAppSettingAction(
  slug: string,
  key: string,
): Promise<void> {
  const session = await requireReadOnlySession();
  const admin = await requireAdmin(session);

  declaredField(slug, key);
  await clearAppSetting(slug, key);
  await recordAdminAction(
    { id: admin.id, email: admin.email },
    {
      action: "app.setting.clear",
      targetType: "app",
      targetId: slug,
      details: { key },
    },
  );
}
