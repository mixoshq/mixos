/* This Source Code Form is subject to the terms of the Mozilla Public
 * License, v. 2.0. If a copy of the MPL was not distributed with this
 * file, You can obtain one at https://mozilla.org/MPL/2.0/. */

import { createHmac, randomBytes, timingSafeEqual } from "node:crypto";
import { createServiceClient } from "@/lib/db/supabase";
import { platformKey } from "@/lib/env/keys";

/**
 * Per-app scoped API keys — the `key` auth tier.
 *
 * Machine-to-machine access without a session and without handing out an app
 * password. Before this, an integrator's only options were "share the app's
 * shared password" or "make the route fully public", which is why the tier was
 * reserved from the start.
 *
 * WHAT IS STORED. An HMAC-SHA256 digest, never the key. The key material is
 * returned once at mint time and is unrecoverable afterwards, so a database leak
 * alone yields nothing replayable. The HMAC key is derived from the platform's
 * existing secret with a distinct label — the same PRF-separation the MCP token
 * store uses — so this introduces **no new environment secret** and cannot be
 * used to recover the base key.
 *
 * WHY NOT BCRYPT. These are 256-bit random values with nothing to brute-force,
 * and lookup must be by exact digest. App *passwords* stay on bcrypt precisely
 * because those are low-entropy and human-chosen.
 */

const PREFIX = "mosk_";

/**
 * The HMAC key for API-key digests: its own environment variable
 * (`APP_API_KEY_SECRET`).
 *
 * DELIBERATELY NOT the unlock key. An operator rotating the app-password secret
 * has no reason to expect every integration's API key to stop working at the
 * same moment, and the reverse is equally true. Rotating this one invalidates
 * app API keys and nothing else. See `src/lib/env/keys.ts`.
 */
function signingKey(): Buffer {
  return platformKey("appApiKey");
}

function digestOf(key: string): string {
  return createHmac("sha256", signingKey()).update(key).digest("hex");
}

export interface MintedKey {
  id: string;
  /** Shown ONCE. Never stored, never recoverable. */
  key: string;
  hint: string;
}

export async function mintApiKey(opts: {
  appSlug: string;
  label: string;
  scopes: string[];
  createdBy: string | null;
  expiresAt?: Date | null;
}): Promise<MintedKey> {
  const key = `${PREFIX}${randomBytes(32).toString("base64url")}`;
  const supabase = createServiceClient();
  const { data, error } = await supabase
    .from("app_api_keys")
    .insert({
      app_slug: opts.appSlug,
      label: opts.label,
      digest: digestOf(key),
      hint: key.slice(0, PREFIX.length + 6),
      // Default-deny: an empty scope list authorizes nothing at all.
      scopes: opts.scopes,
      created_by: opts.createdBy,
      expires_at: opts.expiresAt?.toISOString() ?? null,
    })
    .select("id, hint")
    .single();

  if (error || !data) throw new Error("Could not mint an API key.");
  return { id: data.id as string, key, hint: data.hint as string };
}

export interface ResolvedApiKey {
  id: string;
  appSlug: string;
  scopes: string[];
}

/**
 * Resolve a presented key, or `null`.
 *
 * Every check is live — expiry and revocation take effect on the next request,
 * which is worth one indexed lookup per call and is the same trade the MCP token
 * store makes.
 */
export async function resolveApiKey(
  presented: string | null,
  appSlug: string,
): Promise<ResolvedApiKey | null> {
  if (!presented || !presented.startsWith(PREFIX)) return null;

  const supabase = createServiceClient();
  const { data } = await supabase
    .from("app_api_keys")
    .select("id, app_slug, scopes, expires_at, revoked_at, digest")
    .eq("digest", digestOf(presented))
    .maybeSingle();

  if (!data) return null;

  // The lookup was already by exact digest, so this comparison is belt-and-
  // braces — but it is constant-time, which the SQL equality is not.
  const a = Buffer.from(data.digest as string);
  const b = Buffer.from(digestOf(presented));
  if (a.length !== b.length || !timingSafeEqual(a, b)) return null;

  // A key is bound to ONE app. Presenting a valid key for app A on app B's
  // route must not authenticate, or a key becomes a platform-wide credential.
  if (data.app_slug !== appSlug) return null;
  if (data.revoked_at) return null;
  if (data.expires_at && Date.parse(data.expires_at as string) < Date.now()) {
    return null;
  }

  // Best-effort: never blocks the request.
  void supabase
    .from("app_api_keys")
    .update({ last_used_at: new Date().toISOString() })
    .eq("id", data.id)
    .then(() => undefined);

  return {
    id: data.id as string,
    appSlug: data.app_slug as string,
    scopes: (data.scopes as string[]) ?? [],
  };
}

/** `["*"]` covers every route; otherwise the exact `"<METHOD> /<pattern>"`. */
export function keyAllows(
  scopes: string[],
  method: string,
  pattern: string,
): boolean {
  if (scopes.includes("*")) return true;
  return scopes.includes(`${method} /${pattern}`);
}

/** Read the key from the request. Header only — never a query string, which
 *  ends up in access logs, browser history and referrer headers. */
export function presentedApiKey(request: Request): string | null {
  const auth = request.headers.get("authorization");
  if (auth?.startsWith("Bearer ")) return auth.slice(7).trim();
  return request.headers.get("x-api-key");
}
