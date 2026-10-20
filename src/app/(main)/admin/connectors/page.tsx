/* This Source Code Form is subject to the terms of the Mozilla Public
 * License, v. 2.0. If a copy of the MPL was not distributed with this
 * file, You can obtain one at https://mozilla.org/MPL/2.0/. */

import { Suspense } from "react";
import Link from "next/link";
import { ExternalLink, Store } from "lucide-react";
import { revalidatePath } from "next/cache";
import { requireReadOnlySession } from "@/lib/auth/session";
import { docsUrl } from "@/lib/docs";
import { requireAdmin } from "@/lib/apps/access";
import { installEnabled } from "@/lib/repository/policy";
import { connectorRegistry } from "@/generated/connector-registry";
import {
  getConnectorVerification,
  getDecryptedConfig,
  recordConnectorVerified,
  saveConnectorConfig,
} from "@/lib/connectors/config";
import { registryConfigState } from "@/lib/connectors/status";
import { getUserTokens } from "@/lib/connectors/user-config";
import { getConnectorLog, grantedScopes } from "@/lib/connectors/access";
import { getScopeStatus } from "@/lib/connectors/scope-status";
import { getConnectorDependents } from "@/lib/connectors/dependents";
import { getConnectorsNotInBuild } from "@/lib/connectors/not-in-build";
import { getDisabledConnectors, getReplacedConnectors } from "@/lib/connectors/switch";
import { setConnectorEnabled } from "@/lib/connectors/switch-admin";
import { getWritableConnectors } from "@/lib/connectors/writable";
import { setConnectorChanges } from "@/lib/connectors/writable-admin";
import { TOKEN_KEYS, redirectUriFor } from "@/lib/connectors/oauth";
import { runConnectorTest } from "@/lib/connectors/test-connection";
import type { ConnectorTestOutcome } from "@/lib/connectors/test-connection";
import ConnectorRegistryList from "@/components/admin/connector-registry-list";
import ConnectorsNotInBuild from "@/components/admin/connectors-not-in-build";
import PendingInstalls from "@/components/admin/pending/pending-installs";
import ProposedPullRequests from "@/components/admin/github/proposed-pull-requests";
import { proposalTarget } from "@/lib/github/propose";
import RegistryNotices from "@/components/admin/registry-notices";
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
  disabled: {
    tone: "warn",
    text: "This connector is disabled. Enable it, then connect.",
  },
};

/**
 * The signed-in admin's own grant for a user-scoped connector, or null. A grant
 * that cannot be read is reported as absent: this page is a status view, and
 * one unreadable row must not take it down.
 */
async function ownGrant(
  userId: string,
  connectorName: string,
): Promise<Record<string, string> | null> {
  try {
    return await getUserTokens(userId, connectorName);
  } catch (err) {
    console.error(`[connectors] ${connectorName}: own grant unreadable:`, err);
    return null;
  }
}

export default async function ConnectorsAdminPage({
  searchParams,
}: {
  searchParams: Promise<Record<string, string | string[] | undefined>>;
}) {
  const session = await requireReadOnlySession();
  const adminUser = await requireAdmin(session);
  // On a built deployment with the GitHub App linked, Remove offers a pull
  // request instead; from what is stored, without asking GitHub on every render.
  const proposal = await proposalTarget("connector");

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

  // Which connectors an admin has turned off, and when: one read for the grid.
  const disabled = await getDisabledConnectors(
    connectorRegistry.map((c) => c.name),
  );
  // Which of them the release step turned off because a different connector
  // took the name. Enabling one needs its name typed.
  const replaced = await getReplacedConnectors(
    connectorRegistry.map((c) => c.name),
  );
  // Which connectors an admin has allowed to change data: one read for the grid.
  const writable = await getWritableConnectors(
    connectorRegistry.map((c) => c.name),
  );
  // Connectors this database keeps credentials or connections for that this
  // build doesn't carry, each with Delete data.
  const notInBuild = await getConnectorsNotInBuild(
    connectorRegistry.map((c) => c.name),
  );

  const statuses = await Promise.all(
    connectorRegistry.map(async (c) => {
      // Read once, derive everything from it. registryConfigState() applies the
      // rule HttpConnector.configured uses, so this page and the runtime agree.
      // "A row exists" is not that rule: a three-legged connector whose admin
      // saved a client ID and never pressed Connect would read as Configured
      // while the runtime refused every call.
      const credentials = await getDecryptedConfig(c.name);
      const state = registryConfigState(c, credentials);
      // The grant this page reports on. A user-scoped connector's tenant row
      // never holds one — each person's is their own — so the grant an admin
      // can connect, test with and inspect here is their own.
      const grant = c.userScoped
        ? await ownGrant(adminUser.id, c.name)
        : credentials;
      // Whether Test Connection has ever actually succeeded. A separate fact
      // from `state`, which only knows what is stored: a connector can hold a
      // complete, valid-looking credential set that the upstream rejects.
      const verification = await getConnectorVerification(c.name);
      // Three separate facts, kept separate: what the provider granted, and
      // what has actually run. Neither is the other's evidence.
      const access = {
        ...grantedScopes(grant),
        log: await getConnectorLog(c.name),
      };
      // Cached, never fetched during render: a page load must not depend on a
      // third party's docs site being up. The admin refreshes it explicitly.
      const scopeStatus = await getScopeStatus(
        c.name,
        c.userScoped ? adminUser.id : null,
      );
      // Static, from the manifests — no query, and it counts apps that are
      // shipped rather than only those an admin has switched on.
      const dependents = getConnectorDependents(c.name);
      const disabledAt = disabled.get(c.name) ?? null;
      const replacement = replaced.get(c.name) ?? null;
      const changesAllowed = writable.has(c.name);

      if (c.auth?.strategy !== "oauth2_authorization_code") {
        return {
          ...c,
          state,
          verification,
          access,
          scopeStatus,
          dependents,
          disabledAt,
          replacement,
          changesAllowed,
          oauth: null,
        };
      }

      // Only booleans, an expiry timestamp and the declared scopes leave the
      // server — never a token, and never the client secret.
      const expiresRaw = Number(grant?.[TOKEN_KEYS.expiresAt] ?? 0);
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
        disabledAt,
        replacement,
        changesAllowed,
        oauth: {
          connected: Boolean(
            grant?.[TOKEN_KEYS.refresh] || grant?.[TOKEN_KEYS.access],
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
    return registryConfigState(connector, stored) !== "unconfigured";
  }

  async function testConnector(
    connectorName: string,
  ): Promise<ConnectorTestOutcome> {
    "use server";
    // Re-checked inside the action: a server action is a public endpoint, and
    // the page-level check above does not protect it.
    const session = await requireReadOnlySession();
    const tester = await requireAdmin(session);
    // A user-scoped connector is tested with the tester's own grant.
    const outcome = await runConnectorTest(connectorName, {
      userId: tester.id,
    });
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

  /**
   * Disable or Enable. Takes effect on the next request everywhere: the app
   * context, webhooks, OAuth and Test Connection read the switch per request.
   * Credentials are not touched either way. Enabling a connector that replaces
   * a different one needs its name typed, `typedName`.
   */
  async function switchConnector(
    connectorName: string,
    enabled: boolean,
    typedName?: string,
  ): Promise<void> {
    "use server";
    const session = await requireReadOnlySession();
    const admin = await requireAdmin(session);
    await setConnectorEnabled(
      connectorName,
      enabled,
      { id: admin.id, email: admin.email },
      typedName,
    );
    // My Connections lists user-scoped connectors and says when one is off.
    revalidatePath("/admin/connectors");
    revalidatePath("/account/connections");
  }

  /**
   * Allow changes, or make the connector read-only again. Takes effect on the
   * next request: the app context reads it per request. Allowing changes on
   * an OAuth connector asks for its write scopes from the next Connect on;
   * the grant it holds now keeps the scopes it was given until then.
   */
  async function changesConnector(
    connectorName: string,
    allowed: boolean,
  ): Promise<void> {
    "use server";
    const session = await requireReadOnlySession();
    const admin = await requireAdmin(session);
    await setConnectorChanges(connectorName, allowed, {
      id: admin.id,
      email: admin.email,
    });
    // Apps' readiness depends on it, as well as this page.
    revalidatePath("/admin/connectors");
    revalidatePath("/admin/apps");
  }

  return (
    <div>
      <div className="mb-6 flex flex-col gap-4 lg:flex-row lg:items-start lg:justify-between lg:gap-0">
        <div>
          <h1 className="text-2xl font-bold text-foreground">Connectors</h1>
          <p className="mt-1 text-sm text-muted-foreground">
            Configure the shared credentials apps use to reach outside services
            — each connector is set up once here and used by every app that
            declares it.
          </p>
        </div>
        {/*
          Two actions, and the order is the point: Browse reaches the mixos.org
          repository, which is where an admin who wants a connector they do not
          have goes first. The docs are for the case where nobody has built it
          yet, so they keep the brand fill and the second position rather than
          competing with the action most visits to this page want. They open on
          mixos.org in a new tab, where the guides are published.

          Browse is absent when installing this kind is turned off
          (lib/repository/policy.ts); the page it leads to is a 404 then anyway.
        */}
        <div className="flex shrink-0 flex-wrap items-center gap-2">
          {installEnabled("connector") && (
            <Link
              href="/admin/connectors/browse"
              className="inline-flex items-center gap-2 rounded-lg border border-border px-4 py-2 text-sm font-medium text-foreground shadow-sm hover:bg-muted"
            >
              <Store className="h-4 w-4" aria-hidden />
              Browse Connectors
            </Link>
          )}
          <a
            href={docsUrl("extending/connectors")}
            target="_blank"
            rel="noreferrer noopener"
            className="inline-flex items-center gap-2 rounded-lg bg-brand px-4 py-2 text-sm font-medium text-brand-foreground shadow-sm hover:bg-brand/90"
          >
            How to create a connector
            <ExternalLink className="h-4 w-4" aria-hidden />
            <span className="sr-only"> (opens in a new tab)</span>
          </a>
        </div>
      </div>
      <RegistryNotices kind="connector" />
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
      <PendingInstalls kind="connector" />
      {/* Read from GitHub: the rest of the page doesn't wait for it. */}
      <Suspense fallback={null}>
        <ProposedPullRequests kind="connector" />
      </Suspense>
      <ConnectorRegistryList
        connectors={statuses}
        proposal={proposal}
        initialOpen={openConnector}
        configureAction={configureConnector}
        testAction={testConnector}
        switchAction={switchConnector}
        changesAction={changesConnector}
      />
      <ConnectorsNotInBuild connectors={notInBuild} />
    </div>
  );
}
