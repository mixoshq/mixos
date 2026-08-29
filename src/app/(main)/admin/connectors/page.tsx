/* This Source Code Form is subject to the terms of the Mozilla Public
 * License, v. 2.0. If a copy of the MPL was not distributed with this
 * file, You can obtain one at https://mozilla.org/MPL/2.0/. */

import Link from "next/link";
import { revalidatePath } from "next/cache";
import { requireReadOnlySession } from "@/lib/auth/session";
import { requireAdmin } from "@/lib/apps/access";
import { connectorRegistry } from "@/generated/connector-registry";
import {
  getConnectorVerification,
  getDecryptedConfig,
  recordConnectorVerified,
  saveConnectorConfig,
} from "@/lib/connectors/config";
import { connectorConfigState } from "@/lib/connectors/status";
import { getConnectorLog, grantedScopes } from "@/lib/connectors/access";
import { getScopeStatus } from "@/lib/connectors/scope-status";
import { getConnectorDependents } from "@/lib/connectors/dependents";
import { TOKEN_KEYS, redirectUriFor } from "@/lib/connectors/oauth";
import { runConnectorTest } from "@/lib/connectors/test-connection";
import type { ConnectorTestOutcome } from "@/lib/connectors/test-connection";
import ConnectorRegistryList from "@/components/admin/connector-registry-list";
import { recordAdminAction, redactedKeys } from "@/lib/apps/admin-audit";

/**
 * Outcome of an OAuth round trip, reported as a coarse status by the callback
 * route. Deliberately never the provider's own error text.
 */
const OAUTH_MESSAGES: Record<string, { tone: "ok" | "warn"; text: string }> = {
  connected: { tone: "ok", text: "Connected successfully." },
  denied: { tone: "warn", text: "Authorization was declined at the provider." },
  expired: {
    tone: "warn",
    text: "That authorization link expired before it was used. Start again.",
  },
  state: {
    tone: "warn",
    text: "The authorization response did not match the request. Start again.",
  },
  "exchange-failed": {
    tone: "warn",
    text: "The provider rejected the authorization. Check the client ID and secret, then reconnect.",
  },
  "missing-client": {
    tone: "warn",
    text: "Save the client ID and secret first, then connect.",
  },
  unsupported: { tone: "warn", text: "This connector does not use OAuth." },
};

export default async function ConnectorsAdminPage({
  searchParams,
}: {
  searchParams: Promise<Record<string, string | string[] | undefined>>;
}) {
  const session = await requireReadOnlySession();
  const adminUser = await requireAdmin(session);

  const params = await searchParams;
  const oauthStatus = typeof params.oauth === "string" ? params.oauth : null;
  const notice = oauthStatus ? OAUTH_MESSAGES[oauthStatus] : undefined;
  // Set by the OAuth round trip's return URL, so the admin lands back inside
  // the dialog they left rather than in front of a closed grid.
  const openConnector =
    typeof params.connector === "string" &&
    connectorRegistry.some((c) => c.name === params.connector)
      ? params.connector
      : null;

  const statuses = await Promise.all(
    connectorRegistry.map(async (c) => {
      // Read once, derive everything from it. This used to ask
      // isConnectorConfigured(), which answers "does a row exist" — so a
      // three-legged connector whose admin saved a client ID and never pressed
      // Connect rendered as Configured while the runtime refused every call.
      // connectorConfigState() is the same function HttpConnector.configured
      // uses, which is what keeps the two from disagreeing again.
      const credentials = await getDecryptedConfig(c.name);
      const state = connectorConfigState(c.auth, credentials);
      // Whether Test Connection has ever actually succeeded. A separate fact
      // from `state`, which only knows what is stored: a connector can hold a
      // complete, valid-looking credential set that the upstream rejects.
      const verification = await getConnectorVerification(c.name);
      // Three separate facts, kept separate: what the provider granted, and
      // what has actually run. Neither is the other's evidence.
      const access = {
        ...grantedScopes(credentials),
        log: await getConnectorLog(c.name),
      };
      // Cached, never fetched during render: a page load must not depend on a
      // third party's docs site being up. The admin refreshes it explicitly.
      const scopeStatus = await getScopeStatus(c.name);
      // Static, from the manifests — no query, and it counts apps that are
      // shipped rather than only those an admin has switched on.
      const dependents = getConnectorDependents(c.name);

      if (c.auth?.strategy !== "oauth2_authorization_code") {
        return {
          ...c,
          state,
          verification,
          access,
          scopeStatus,
          dependents,
          oauth: null,
        };
      }

      // Only booleans, an expiry timestamp and the declared scopes leave the
      // server — never a token, and never the client secret.
      const expiresRaw = Number(credentials?.[TOKEN_KEYS.expiresAt] ?? 0);
      let redirectUri: string | null = null;
      try {
        redirectUri = redirectUriFor(c.name);
      } catch {
        // No configured origin (common in local dev). The admin sees guidance
        // instead of a crashed page.
        redirectUri = null;
      }

      return {
        ...c,
        state,
        verification,
        access,
        scopeStatus,
        dependents,
        oauth: {
          connected: Boolean(
            credentials?.[TOKEN_KEYS.refresh] ||
            credentials?.[TOKEN_KEYS.access],
          ),
          expiresAt:
            Number.isFinite(expiresRaw) && expiresRaw > 0 ? expiresRaw : null,
          redirectUri,
          scopes: c.auth.scopes ?? [],
        },
      };
    }),
  );

  /**
   * Save credentials and report whether the connector now HAS a usable set.
   *
   * The boolean is what lets the wizard advance only when the step actually
   * completed. Returning void meant the dialog had to guess: advance blindly
   * (and skip past a save that stored nothing) or re-derive from props that
   * have not been revalidated yet (and snap backwards). Neither is knowable on
   * the client; the server just did the write, so it answers.
   */
  async function configureConnector(formData: FormData): Promise<boolean> {
    "use server";
    const connectorName = formData.get("connectorName") as string;
    const connector = connectorRegistry.find((c) => c.name === connectorName);
    if (!connector) return false;

    const credentials: Record<string, string> = {};
    for (const field of connector.credentialFields) {
      const value = formData.get(field.key) as string;
      if (value) credentials[field.key] = value;
    }

    const session = await requireReadOnlySession();
    await requireAdmin(session);
    await saveConnectorConfig(connectorName, credentials, adminUser.id);
    // Which credential KEYS were supplied, never their values.
    await recordAdminAction(
      { id: adminUser.id, email: adminUser.email },
      {
        action: "connector.configure",
        targetType: "connector",
        targetId: connectorName,
        details: { fields: redactedKeys(credentials) },
      },
    );
    revalidatePath("/admin/connectors");

    // Read back what is actually stored rather than trusting the submission:
    // blank fields are skipped above, so an empty form is a legal no-op that
    // must not read as success.
    const stored = await getDecryptedConfig(connectorName);
    return connectorConfigState(connector.auth, stored) !== "unconfigured";
  }

  async function testConnector(
    connectorName: string,
  ): Promise<ConnectorTestOutcome> {
    "use server";
    // Re-checked inside the action: a server action is a public endpoint, and
    // the page-level check above does not protect it.
    const session = await requireReadOnlySession();
    const tester = await requireAdmin(session);
    const outcome = await runConnectorTest(connectorName);
    await recordAdminAction(
      { id: tester.id, email: tester.email },
      {
        action: "connector.test",
        targetType: "connector",
        targetId: connectorName,
        details: { ok: outcome.ok },
      },
    );
    // Only a success is recorded. A failure leaves the previous timestamp
    // alone: "it worked on Tuesday" stays true and stays useful, and the
    // failure itself is on screen right now.
    if (outcome.ok) {
      await recordConnectorVerified(connectorName, outcome.detail);
      revalidatePath("/admin/connectors");
    }
    return outcome;
  }

  return (
    <div>
      <div className="mb-6 flex items-start justify-between">
        <div>
          <h1 className="text-2xl font-bold text-foreground">Connectors</h1>
          <p className="mt-1 text-sm text-muted-foreground">
            Configure the shared credentials apps use to reach outside services
            — each connector is set up once here and used by every app that
            declares it.
          </p>
        </div>
        <Link
          href="/connectors/guide"
          className="shrink-0 inline-flex items-center gap-2 rounded-lg bg-brand px-4 py-2 text-sm font-medium text-brand-foreground shadow-sm hover:bg-brand/90"
        >
          How to create a connector
        </Link>
      </div>
      {notice && (
        <div
          className={`mb-4 rounded-lg border px-4 py-3 text-sm ${
            notice.tone === "ok"
              ? "border-success/40 bg-success/10 text-foreground"
              : "border-warning/40 bg-warning/10 text-foreground"
          }`}
        >
          {notice.text}
        </div>
      )}
      <ConnectorRegistryList
        connectors={statuses}
        initialOpen={openConnector}
        configureAction={configureConnector}
        testAction={testConnector}
      />
    </div>
  );
}
