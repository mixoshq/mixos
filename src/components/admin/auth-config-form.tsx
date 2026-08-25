"use client";

import { useActionState, useEffect, useState } from "react";
import { saveSsoConfig, toggleSso } from "@/lib/admin/auth-actions";
import {
  INITIAL_SSO_CONFIG_STATE,
  type SsoConfigState,
} from "@/lib/admin/auth-actions-types";

interface Props {
  ssoEnabled: boolean;
  issuerUrl: string | null;
  clientId: string | null;
  hasClientSecret: boolean;
  adminClaimName: string | null;
  adminClaimValues: string[];
}

function Banner({ state }: { state: SsoConfigState }) {
  if (state.error) {
    return (
      <p className="mt-2 rounded-md bg-rose-500/15 px-3 py-2 text-sm text-rose-700 dark:text-rose-400">
        {state.error}
      </p>
    );
  }
  if (state.success) {
    return (
      <p className="mt-2 rounded-md bg-emerald-500/15 px-3 py-2 text-sm font-semibold text-emerald-700 dark:text-emerald-400">
        {state.success}
      </p>
    );
  }
  return null;
}

export default function AuthConfigForm({
  ssoEnabled,
  issuerUrl,
  clientId,
  hasClientSecret,
  adminClaimName,
  adminClaimValues,
}: Props) {
  const [configState, configAction, configPending] = useActionState(
    saveSsoConfig,
    INITIAL_SSO_CONFIG_STATE
  );
  const [toggleState, toggleAction, togglePending] = useActionState(
    toggleSso,
    INITIAL_SSO_CONFIG_STATE
  );

  const [redirectUri, setRedirectUri] = useState("");
  useEffect(() => {
    setRedirectUri(`${window.location.origin}/api/auth/callback/oidc`);
  }, []);

  return (
    <div className="space-y-8">
      <section className="rounded-lg border border-border bg-card p-6">
        <h2 className="text-lg font-semibold">SSO (OpenID Connect)</h2>
        <p className="mt-1 text-sm text-muted-foreground">
          Configure a generic OIDC identity provider. When SSO is enabled, the
          login page will hide the email/password form and show only a
          &ldquo;Login with SSO&rdquo; button.
        </p>

        <details className="mt-4 rounded-md border border-border bg-background/50 px-4 py-3 text-sm">
          <summary className="cursor-pointer font-medium text-foreground">
            Where to find these values
          </summary>
          <ol className="mt-3 list-decimal space-y-2 pl-5 text-muted-foreground">
            <li>
              In your identity provider, register a new{" "}
              <strong>web application</strong> (sometimes called an app
              registration, OIDC client, or confidential client).
            </li>
            <li>
              Set its <strong>redirect URI</strong> to the callback URL shown
              below. It must match exactly, including scheme and trailing path.
            </li>
            <li>
              Copy the provider&rsquo;s{" "}
              <strong>issuer URL</strong> — the base URL whose{" "}
              <code className="rounded bg-muted px-1.5 py-0.5 text-xs">
                /.well-known/openid-configuration
              </code>{" "}
              document describes the provider. Paste it into{" "}
              <em>Issuer URL</em>.
            </li>
            <li>
              Copy the <strong>client ID</strong> and generate a{" "}
              <strong>client secret</strong>, then paste both below. The secret
              is encrypted before it is stored.
            </li>
            <li>
              Make sure the provider returns the{" "}
              <code className="rounded bg-muted px-1.5 py-0.5 text-xs">
                openid
              </code>
              ,{" "}
              <code className="rounded bg-muted px-1.5 py-0.5 text-xs">
                email
              </code>
              , and{" "}
              <code className="rounded bg-muted px-1.5 py-0.5 text-xs">
                profile
              </code>{" "}
              scopes — those are what the platform requests.
            </li>
          </ol>
        </details>

        <div className="mt-4 rounded-md border border-border bg-muted/40 px-4 py-3 text-sm">
          <p className="font-medium text-foreground">Redirect URI</p>
          <p className="mt-1 text-xs text-muted-foreground">
            Register this exact URL with your provider. It must match
            character-for-character.
          </p>
          <code className="mt-2 block break-all rounded bg-muted px-2 py-1 text-xs text-foreground">
            {redirectUri || "\u2026"}
          </code>
        </div>

        <form action={configAction} className="mt-6 space-y-4">
          <div>
            <label
              htmlFor="issuerUrl"
              className="block text-sm font-medium text-foreground"
            >
              Issuer URL
            </label>
            <input
              id="issuerUrl"
              name="issuerUrl"
              type="url"
              required
              defaultValue={issuerUrl ?? ""}
              placeholder="https://idp.example.com/"
              className="mt-1 w-full rounded-md border border-border bg-background px-3 py-2 text-sm text-foreground focus:border-mixcharcoal focus:outline-none"
            />
            <p className="mt-1 text-xs text-muted-foreground">
              The base URL whose{" "}
              <code className="rounded bg-muted px-1 py-0.5 text-[11px]">
                /.well-known/openid-configuration
              </code>{" "}
              document describes the provider.
            </p>
          </div>

          <div>
            <label
              htmlFor="clientId"
              className="block text-sm font-medium text-foreground"
            >
              Client ID
            </label>
            <input
              id="clientId"
              name="clientId"
              type="text"
              required
              defaultValue={clientId ?? ""}
              className="mt-1 w-full rounded-md border border-border bg-background px-3 py-2 text-sm text-foreground focus:border-mixcharcoal focus:outline-none"
            />
          </div>

          <div>
            <label
              htmlFor="clientSecret"
              className="block text-sm font-medium text-foreground"
            >
              Client secret
            </label>
            <input
              id="clientSecret"
              name="clientSecret"
              type="password"
              autoComplete="new-password"
              placeholder={hasClientSecret ? "•••••••• (leave blank to keep)" : ""}
              className="mt-1 w-full rounded-md border border-border bg-background px-3 py-2 text-sm text-foreground focus:border-mixcharcoal focus:outline-none"
            />
            <p className="mt-1 text-xs text-muted-foreground">
              Stored encrypted (AES-256-GCM). Leave blank to keep the existing
              value.
            </p>
          </div>

          <div className="border-t border-border pt-4">
            <h3 className="text-sm font-semibold text-foreground">
              Admin role mapping (optional)
            </h3>
            <p className="mt-1 text-xs text-muted-foreground">
              Map an OIDC ID-token claim to the local admin flag. When both
              fields are set, an SSO user&apos;s admin status is recomputed from
              their claims on every login. Leave blank to manage admin access
              manually in the database.
            </p>

            <details className="mt-3 rounded-md border border-border bg-background/50 px-3 py-2 text-xs">
              <summary className="cursor-pointer font-medium text-foreground">
                How claim mapping works
              </summary>
              <ol className="mt-2 list-decimal space-y-1 pl-5 text-muted-foreground">
                <li>
                  In your identity provider, define a role or group that should
                  confer admin, and assign the relevant users to it.
                </li>
                <li>
                  Configure the provider to include that role or group in the{" "}
                  <strong>ID token</strong>. Providers differ in whether this is
                  on by default — a claim the provider does not emit cannot be
                  matched here.
                </li>
                <li>
                  Set <em>Admin claim name</em> to the claim key (commonly{" "}
                  <code>roles</code> or <code>groups</code>) and{" "}
                  <em>Admin claim values</em> to the value(s) that should grant
                  admin. A user is an admin when the claim contains any listed
                  value.
                </li>
              </ol>
              <p className="mt-2 text-muted-foreground">
                Matching is case-insensitive and works on either a single string
                or an array. If your provider emits opaque identifiers rather
                than names, use the identifier as the value.
              </p>
            </details>

            <div className="mt-4">
              <label
                htmlFor="adminClaimName"
                className="block text-sm font-medium text-foreground"
              >
                Admin claim name
              </label>
              <input
                id="adminClaimName"
                name="adminClaimName"
                type="text"
                defaultValue={adminClaimName ?? ""}
                placeholder="roles"
                className="mt-1 w-full rounded-md border border-border bg-background px-3 py-2 text-sm text-foreground focus:border-mixcharcoal focus:outline-none"
              />
            </div>

            <div className="mt-4">
              <label
                htmlFor="adminClaimValues"
                className="block text-sm font-medium text-foreground"
              >
                Admin claim values
              </label>
              <input
                id="adminClaimValues"
                name="adminClaimValues"
                type="text"
                defaultValue={adminClaimValues.join(", ")}
                placeholder="admin, mixadmin"
                className="mt-1 w-full rounded-md border border-border bg-background px-3 py-2 text-sm text-foreground focus:border-mixcharcoal focus:outline-none"
              />
              <p className="mt-1 text-xs text-muted-foreground">
                Comma-separated list. A user is granted admin if any value in
                the claim matches any value here (case-insensitive).
              </p>
            </div>
          </div>

          <button
            type="submit"
            disabled={configPending}
            className="rounded-md bg-mixcharcoal px-4 py-2 text-sm font-medium text-white transition-colors hover:bg-mixcharcoal/90 disabled:opacity-60"
          >
            {configPending ? "Saving…" : "Save configuration"}
          </button>
          <Banner state={configState} />
        </form>
      </section>

      <section className="rounded-lg border border-border bg-card p-6">
        <h2 className="text-lg font-semibold">Enable SSO</h2>
        <p className="mt-1 text-sm text-muted-foreground">
          When enabled, users must sign in through the configured identity
          provider. Existing password credentials become unusable until SSO is
          disabled again.
        </p>

        {ssoEnabled && (() => {
          const missing: string[] = [];
          if (!issuerUrl) missing.push("Issuer URL");
          if (!clientId) missing.push("Client ID");
          if (!hasClientSecret) missing.push("Client secret");
          if (missing.length === 0) return null;
          return (
            <div className="mt-4 rounded-md border border-amber-300 bg-amber-50 px-3 py-2.5 text-sm text-amber-900 dark:border-amber-500/40 dark:bg-amber-500/10 dark:text-amber-300">
              <p className="font-semibold">SSO is enabled but not fully configured</p>
              <p className="mt-1">
                The login page is still showing the email/password form because{" "}
                {missing.length === 1 ? "this field is" : "these fields are"}{" "}
                missing in the OIDC section above:{" "}
                <strong>{missing.join(", ")}</strong>. Save a complete
                configuration before users can sign in via SSO.
              </p>
            </div>
          );
        })()}

        <form action={toggleAction} className="mt-4 flex items-center gap-3">
          <label className="inline-flex items-center gap-2 text-sm text-foreground">
            <input
              type="checkbox"
              name="enabled"
              defaultChecked={ssoEnabled}
              className="h-4 w-4 rounded border-border"
            />
            SSO enabled
          </label>
          <button
            type="submit"
            disabled={togglePending}
            className="rounded-md bg-mixcharcoal px-4 py-2 text-sm font-medium text-white transition-colors hover:bg-mixcharcoal/90 disabled:opacity-60"
          >
            {togglePending ? "Applying…" : "Apply"}
          </button>
        </form>
        <Banner state={toggleState} />
      </section>
    </div>
  );
}
