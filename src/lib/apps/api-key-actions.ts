/* This Source Code Form is subject to the terms of the Mozilla Public
 * License, v. 2.0. If a copy of the MPL was not distributed with this
 * file, You can obtain one at https://mozilla.org/MPL/2.0/. */

"use server";

import { revalidatePath } from "next/cache";
import { z } from "zod";
import { appRegistry } from "@/generated/app-registry";
import { createServiceClient } from "@/lib/db/server";
import { requireReadOnlySession } from "@/lib/auth/session";
import { requireAdmin } from "@/lib/apps/access";
import { recordAdminAction } from "@/lib/apps/admin-audit";
import { keyScopes } from "@/lib/apps/access-surfaces";
import {
  listApiKeys,
  mintApiKey,
  revokeApiKey,
  type ApiKeySummary,
} from "@/lib/apps/api-keys";
import type { AppManifest } from "@/lib/apps/types";

/**
 * The admin side of the `key` auth tier: mint, list, revoke, on the app's
 * Access tab.
 *
 * Each export is a directly invocable POST endpoint, so each checks
 * `requireAdmin()` itself before it reads anything else, and each change is
 * audited. The key is never logged and never audited: it is returned exactly
 * once, from `mintAppApiKey`, and only its digest is stored
 * (./api-keys.ts). A refusal comes back as a value, since a thrown error
 * reaches the browser as an opaque digest in production.
 */

/** "Every route that accepts a key", the one scope that isn't a route. */
const EVERY_KEY_ROUTE = "*";
const LABEL_MAX = 80;

async function admin() {
  return requireAdmin(await requireReadOnlySession());
}

const Slug = z.string().min(1).max(100);

function manifestFor(slug: unknown): AppManifest | null {
  const parsed = Slug.safeParse(slug);
  return parsed.success ? (appRegistry.find((a) => a.slug === parsed.data) ?? null) : null;
}

/**
 * The slug of an app this database keeps, whether or not this build carries
 * it, or null. Listing and revoking keys work on an app that left the build:
 * its keys are refused while it's away, and would work again when it returns.
 * Minting doesn't: a key is scoped to routes only the manifest declares.
 */
async function knownSlug(slug: unknown): Promise<{ slug: string; inBuild: boolean } | null> {
  const app = manifestFor(slug);
  if (app) return { slug: app.slug, inBuild: true };
  const parsed = Slug.safeParse(slug);
  if (!parsed.success) return null;
  const { data } = await createServiceClient()
    .from("apps")
    .select("slug")
    .eq("slug", parsed.data)
    .maybeSingle();
  return data ? { slug: data.slug as string, inBuild: false } : null;
}

export interface AppApiKey extends ApiKeySummary {
  /** Display name of whoever minted it; null when unknown or gone. */
  createdByName: string | null;
}

/** Every key minted for the app, revoked ones included. Admin-only; not audited, as no read is. */
export async function listAppApiKeys(slug: string): Promise<AppApiKey[]> {
  await admin();
  const app = await knownSlug(slug);
  if (!app) throw new Error("App not found.");
  const keys = await listApiKeys(app.slug);

  const ids = [...new Set(keys.map((k) => k.createdBy).filter((id): id is string => !!id))];
  const names = new Map<string, string>();
  if (ids.length > 0) {
    const { data, error } = await createServiceClient()
      .from("users")
      .select("id, email, display_name")
      .in("id", ids);
    if (error) throw new Error("Could not list API keys.");
    for (const u of data as { id: string; email: string; display_name: string | null }[]) {
      names.set(u.id, u.display_name || u.email);
    }
  }

  return keys.map((k) => ({
    ...k,
    createdByName: k.createdBy ? (names.get(k.createdBy) ?? null) : null,
  }));
}

export interface MintRequest {
  label: string;
  /** Route scopes from `keyScopes()`, or exactly `["*"]` for every key route. */
  scopes: string[];
  /** 30, 90 or 365; null for a key that never expires. */
  expiresInDays: number | null;
}

export interface MintedAppKey {
  id: string;
  /** Shown once. The only copy that will ever exist outside the caller. */
  key: string;
  hint: string;
}

export type MintResult = { ok: true; minted: MintedAppKey } | { ok: false; message: string };
export type RevokeKeyResult = { ok: true } | { ok: false; message: string };

const MintInput = z.object({
  label: z
    .string()
    .trim()
    .min(1, "Give the key a label, so it can be told apart later.")
    .max(LABEL_MAX, `Keep the label to ${LABEL_MAX} characters.`)
    // No control characters, line or paragraph separators, or invisible
    // formatting such as a direction override: what an admin reads in the
    // list is what the label says.
    .regex(/^[^\p{Cc}\p{Cf}\p{Zl}\p{Zp}]*$/u, "A label is plain text on one line, with no hidden characters."),
  scopes: z
    .array(z.string().min(1).max(300))
    .min(1, "Pick at least one route for the key.")
    .max(500),
  expiresInDays: z
    .union([z.literal(30), z.literal(90), z.literal(365)], {
      error: "Expiry must be 30, 90 or 365 days, or never.",
    })
    .nullable(),
});

export async function mintAppApiKey(slug: string, req: MintRequest): Promise<MintResult> {
  const actor = await admin();
  const app = manifestFor(slug);
  if (!app) return { ok: false, message: "That app isn't in this build." };

  const offered = keyScopes(app);
  if (offered.length === 0) {
    return { ok: false, message: `${app.name} has no route that accepts an API key.` };
  }

  const input = MintInput.safeParse(req);
  if (!input.success) {
    return { ok: false, message: input.error.issues[0]?.message ?? "That request isn't valid." };
  }
  const { label, expiresInDays } = input.data;

  // Default-deny is the table's rule (an empty scope list authorizes nothing),
  // so an empty request is a mistake to report, not a key to mint. "Every key
  // route" stands alone: beside a route it would make the route meaningless.
  const scopes = [...new Set(input.data.scopes)];
  const everything = scopes.includes(EVERY_KEY_ROUTE);
  if (everything && scopes.length > 1) {
    return { ok: false, message: "Choose every key route, or particular routes, not both." };
  }
  if (!everything && scopes.some((s) => !offered.includes(s))) {
    return { ok: false, message: "A scope names a route that doesn't accept an API key." };
  }

  const expiresAt =
    expiresInDays === null ? null : new Date(Date.now() + expiresInDays * 24 * 60 * 60 * 1000);
  const minted = await mintApiKey({
    appSlug: app.slug,
    label,
    scopes,
    createdBy: actor.id,
    expiresAt,
  });

  // What was minted and for what: never the key.
  await recordAdminAction(
    { id: actor.id, email: actor.email },
    {
      action: "app.apikey.create",
      targetType: "app",
      targetId: app.slug,
      details: {
        keyId: minted.id,
        label,
        scopes,
        expiresAt: expiresAt?.toISOString() ?? null,
      },
    },
  );
  revalidatePath("/admin/apps");
  return { ok: true, minted };
}

export async function revokeAppApiKey(slug: string, id: string): Promise<RevokeKeyResult> {
  const actor = await admin();
  const app = await knownSlug(slug);
  if (!app) return { ok: false, message: "That app isn't known here." };
  const keyId = z.guid().safeParse(id);
  if (!keyId.success) return { ok: false, message: "That request isn't valid." };

  // Scoped by app as well as id, so a key of another app can't be revoked
  // through this one's screen.
  const revoked = await revokeApiKey(app.slug, keyId.data);
  if (!revoked) {
    return { ok: false, message: "That key is already revoked, or isn't one of this app's." };
  }

  await recordAdminAction(
    { id: actor.id, email: actor.email },
    {
      action: "app.apikey.revoke",
      targetType: "app",
      targetId: app.slug,
      details: { keyId: keyId.data, ...(app.inBuild ? {} : { notInBuild: true }) },
    },
  );
  revalidatePath("/admin/apps");
  return { ok: true };
}
