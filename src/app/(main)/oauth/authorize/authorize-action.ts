/* This Source Code Form is subject to the terms of the Mozilla Public
 * License, v. 2.0. If a copy of the MPL was not distributed with this
 * file, You can obtain one at https://mozilla.org/MPL/2.0/. */

"use server";

import { redirect } from "next/navigation";
import { requireReadOnlySession } from "@/lib/auth/session";
import { hasAppGrant } from "@/lib/apps/access";
import { appsWithEnabledMcpTools } from "@/lib/mcp/tools";
import { isRegisteredRedirectUri } from "@/lib/mcp/oauth";
import { createAuthorizationCode, getClient } from "@/lib/mcp/store";

/**
 * Mint an authorization code for the consent the user just gave, and bounce
 * back to the client's redirect_uri.
 *
 * Everything the page validated is re-validated here. A server action is a
 * public endpoint: the form fields arriving here are attacker-controlled, and
 * "the page already checked" is not a security property.
 */
export async function approveAuthorization(formData: FormData): Promise<void> {
  const session = await requireReadOnlySession().catch(() => null);
  if (!session) redirect("/login");

  const clientId = String(formData.get("client_id") ?? "");
  const redirectUri = String(formData.get("redirect_uri") ?? "");
  const codeChallenge = String(formData.get("code_challenge") ?? "");
  const state = String(formData.get("state") ?? "");
  const selected = formData.getAll("apps").map(String);

  const client = await getClient(clientId);
  if (!client) redirect("/oauth/authorize?error=unknown_client");

  // Exact-match against the registered set. If this fails we must NOT redirect
  // to the supplied URI — that is precisely the open-redirect an attacker wants.
  if (!isRegisteredRedirectUri(redirectUri, client.redirectUris)) {
    redirect("/oauth/authorize?error=bad_redirect_uri");
  }
  if (!codeChallenge) {
    redirect("/oauth/authorize?error=missing_pkce");
  }

  // Re-verify every ticked app: the checkbox values came from the browser, so
  // a crafted POST could name an app the user was never offered. Intersect with
  // "has a tool an admin enabled" AND "this user holds a grant" — the same two
  // tests that decided what the screen offered.
  const declaring = new Set(
    (await appsWithEnabledMcpTools()).map((a) => a.slug),
  );
  const candidates = selected.filter((slug) => declaring.has(slug));
  const grants = await Promise.all(
    candidates.map((slug) => hasAppGrant(session.user.id, slug)),
  );
  const grantedApps = candidates.filter((_, i) => grants[i]);

  const code = await createAuthorizationCode({
    clientId,
    userId: session.user.id,
    redirectUri,
    codeChallenge,
    grantedApps,
  });

  const target = new URL(redirectUri);
  target.searchParams.set("code", code);
  if (state) target.searchParams.set("state", state);
  redirect(target.toString());
}

/**
 * User pressed Deny. Per OAuth 2.1 we redirect back with `access_denied` so the
 * client can show a clean message instead of hanging. Still exact-match the
 * redirect_uri first — a denial is not a reason to relax that.
 */
export async function denyAuthorization(formData: FormData): Promise<void> {
  const clientId = String(formData.get("client_id") ?? "");
  const redirectUri = String(formData.get("redirect_uri") ?? "");
  const state = String(formData.get("state") ?? "");

  const client = await getClient(clientId);
  if (!client || !isRegisteredRedirectUri(redirectUri, client.redirectUris)) {
    redirect("/oauth/authorize?error=bad_redirect_uri");
  }

  const target = new URL(redirectUri);
  target.searchParams.set("error", "access_denied");
  target.searchParams.set(
    "error_description",
    "The user declined the authorization request.",
  );
  if (state) target.searchParams.set("state", state);
  redirect(target.toString());
}
