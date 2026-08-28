/* This Source Code Form is subject to the terms of the Mozilla Public
 * License, v. 2.0. If a copy of the MPL was not distributed with this
 * file, You can obtain one at https://mozilla.org/MPL/2.0/. */

import { redirect } from "next/navigation";
import { requireReadOnlySession } from "@/lib/auth/session";
import LucideIcon from "@/components/lucide-icon";
import { consentableApps } from "@/lib/mcp/tools";
import { MCP_SCOPE, isRegisteredRedirectUri, isValidResource } from "@/lib/mcp/oauth";
import { getClient } from "@/lib/mcp/store";
import { approveAuthorization, denyAuthorization } from "./authorize-action";

/**
 * OAuth 2.1 authorization endpoint — the consent screen.
 *
 * A page rather than a route handler, because this step is the whole point of
 * the flow: it is where a human decides what a model may read. Everything up to
 * here (registration, discovery) grants nothing.
 *
 * Failure handling is deliberately asymmetric:
 *  - A bad `client_id`, unregistered `redirect_uri`, or missing PKCE renders an
 *    error ON MixOS. Redirecting an unvalidated URI is exactly the open-redirect
 *    an attacker is fishing for.
 *  - A valid request the user declines DOES redirect, with `access_denied`, so
 *    the client can fail cleanly instead of hanging.
 */
export const dynamic = "force-dynamic";

interface PageProps {
  searchParams: Promise<Record<string, string | string[] | undefined>>;
}

const ERROR_COPY: Record<string, string> = {
  unknown_client:
    "That application isn't registered with MixOS. Try removing and re-adding the connector in your MCP client.",
  bad_redirect_uri:
    "The application asked us to send you somewhere it hasn't registered. For your safety, we stopped here.",
  missing_pkce:
    "The application didn't include the required PKCE challenge. Update the client and try again.",
  bad_resource:
    "The application requested a different resource than this MCP server.",
  unsupported_response_type:
    "Only the authorization-code flow is supported. Update the client and try again.",
};

function one(v: string | string[] | undefined): string {
  return Array.isArray(v) ? (v[0] ?? "") : (v ?? "");
}

function ErrorScreen({ code }: { code: string }) {
  return (
    <div className="mx-auto max-w-lg py-16">
      <h1 className="text-xl font-semibold">Can&apos;t complete that request</h1>
      <p className="mt-3 text-sm text-muted-foreground">
        {ERROR_COPY[code] ?? "Something about that authorization request wasn't valid."}
      </p>
      <p className="mt-6 text-sm">
        <a className="underline" href="/account/mcp">
          Manage your MCP connections
        </a>
      </p>
    </div>
  );
}

export default async function AuthorizePage({ searchParams }: PageProps) {
  const params = await searchParams;

  // An error bounced here from the server action (which cannot render).
  const inboundError = one(params.error);
  if (inboundError) return <ErrorScreen code={inboundError} />;

  // Sign in first, then come back to this exact URL — otherwise the user logs
  // in and lands on the dashboard with the authorization silently abandoned.
  const session = await requireReadOnlySession().catch(() => null);
  if (!session) {
    const qs = new URLSearchParams();
    for (const [k, v] of Object.entries(params)) {
      if (typeof v === "string") qs.set(k, v);
    }
    redirect(`/login?callbackUrl=${encodeURIComponent(`/oauth/authorize?${qs}`)}`);
  }

  const clientId = one(params.client_id);
  const redirectUri = one(params.redirect_uri);
  const codeChallenge = one(params.code_challenge);
  const codeChallengeMethod = one(params.code_challenge_method);
  const responseType = one(params.response_type);
  const state = one(params.state);
  const resource = one(params.resource);

  if (responseType && responseType !== "code") {
    return <ErrorScreen code="unsupported_response_type" />;
  }
  if (!isValidResource(resource || null)) {
    return <ErrorScreen code="bad_resource" />;
  }

  const client = await getClient(clientId);
  if (!client) return <ErrorScreen code="unknown_client" />;
  if (!isRegisteredRedirectUri(redirectUri, client.redirectUris)) {
    return <ErrorScreen code="bad_redirect_uri" />;
  }
  // S256 only. OAuth 2.1 drops `plain`, and every MCP client can do S256.
  if (!codeChallenge || codeChallengeMethod !== "S256") {
    return <ErrorScreen code="missing_pkce" />;
  }

  const apps = await consentableApps(session.user.id);

  return (
    <div className="mx-auto max-w-2xl py-12">
      <h1 className="text-xl font-semibold">
        Allow <span className="text-primary">{client.clientName}</span>{" "}
        to read MixOS data?
      </h1>
      <p className="mt-2 text-sm text-muted-foreground">
        Signed in as {session.user.email}. Choose which apps this connection may
        read. It can <strong>only read</strong> — nothing it does can change data
        in MixOS. You can revoke this at any time from{" "}
        <a className="underline" href="/account/mcp">
          My MCP Connections
        </a>
        .
      </p>

      <form className="mt-8">
        <input type="hidden" name="client_id" value={clientId} />
        <input type="hidden" name="redirect_uri" value={redirectUri} />
        <input type="hidden" name="code_challenge" value={codeChallenge} />
        <input type="hidden" name="state" value={state} />

        {apps.length === 0 ? (
          <div className="rounded-lg border border-border bg-card px-4 py-6 text-sm text-muted-foreground">
            None of the apps you have access to expose data over MCP yet. You can
            still approve this connection — it just won&apos;t see anything until
            an app does.
          </div>
        ) : (
          <ul className="space-y-3">
            {apps.map((app) => (
              <li
                key={app.slug}
                className="rounded-lg border border-border bg-card px-4 py-3"
              >
                <label className="flex cursor-pointer items-start gap-3">
                  <input
                    type="checkbox"
                    name="apps"
                    value={app.slug}
                    defaultChecked
                    className="mt-1 h-4 w-4 shrink-0 accent-brand"
                  />
                  <span className="min-w-0">
                    <span className="flex items-center gap-2 font-medium">
                      <LucideIcon name={app.icon} className="h-4 w-4 shrink-0" />
                      {app.name}
                    </span>
                    <span className="mt-1 block text-sm text-muted-foreground">
                      {app.description}
                    </span>
                    <ul className="mt-2 space-y-0.5">
                      {app.mcp.map((t) => (
                        <li key={t.name} className="text-xs text-muted-foreground">
                          <code className="rounded bg-muted px-1 py-0.5">{t.name}</code>{" "}
                          — {t.description}
                        </li>
                      ))}
                    </ul>
                  </span>
                </label>
              </li>
            ))}
          </ul>
        )}

        <p className="mt-6 text-xs text-muted-foreground">
          Scope: <code className="rounded bg-muted px-1 py-0.5">{MCP_SCOPE}</code>.
          Access follows your permissions — this connection can never see an app
          you don&apos;t have, even if it&apos;s ticked here.
        </p>

        <div className="mt-6 flex gap-3">
          <button
            type="submit"
            formAction={approveAuthorization}
            className="rounded-md bg-brand px-4 py-2 text-sm font-medium text-brand-foreground hover:opacity-90"
          >
            Allow
          </button>
          <button
            type="submit"
            formAction={denyAuthorization}
            className="rounded-md border border-border px-4 py-2 text-sm font-medium hover:bg-accent/50"
          >
            Deny
          </button>
        </div>
      </form>
    </div>
  );
}
