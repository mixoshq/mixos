import Link from "next/link";
import { revalidatePath } from "next/cache";
import { requireReadOnlySession } from "@/lib/auth/session";
import { requireAdmin } from "@/lib/apps/access";
import { connectorRegistry } from "@/generated/connector-registry";
import {
  getDecryptedConfig,
  isConnectorConfigured,
  saveConnectorConfig,
} from "@/lib/connectors/config";
import { TOKEN_KEYS, redirectUriFor } from "@/lib/connectors/oauth";
import { runConnectorTest } from "@/lib/connectors/test-connection";
import type { ConnectorTestOutcome } from "@/lib/connectors/test-connection";
import ConnectorRegistryList from "@/components/admin/connector-registry-list";

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

  const statuses = await Promise.all(
    connectorRegistry.map(async (c) => {
      const configured = await isConnectorConfigured(c.name);
      if (c.auth?.strategy !== "oauth2_authorization_code") {
        return { ...c, configured, oauth: null };
      }

      // Only booleans and an expiry timestamp leave the server — never a token.
      const credentials = await getDecryptedConfig(c.name);
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
        configured,
        oauth: {
          connected: Boolean(credentials?.[TOKEN_KEYS.refresh] || credentials?.[TOKEN_KEYS.access]),
          expiresAt: Number.isFinite(expiresRaw) && expiresRaw > 0 ? expiresRaw : null,
          redirectUri,
        },
      };
    })
  );

  async function configureConnector(formData: FormData) {
    "use server";
    const connectorName = formData.get("connectorName") as string;
    const connector = connectorRegistry.find((c) => c.name === connectorName);
    if (!connector) return;

    const credentials: Record<string, string> = {};
    for (const field of connector.credentialFields) {
      const value = formData.get(field.key) as string;
      if (value) credentials[field.key] = value;
    }

    const session = await requireReadOnlySession();
    await requireAdmin(session);
    await saveConnectorConfig(connectorName, credentials, adminUser.id);
    revalidatePath("/admin/connectors");
  }

  async function testConnector(connectorName: string): Promise<ConnectorTestOutcome> {
    "use server";
    // Re-checked inside the action: a server action is a public endpoint, and
    // the page-level check above does not protect it.
    const session = await requireReadOnlySession();
    await requireAdmin(session);
    return runConnectorTest(connectorName);
  }

  return (
    <div>
      <div className="mb-6 flex items-start justify-between">
        <div>
          <p className="text-xs font-semibold uppercase tracking-widest text-muted-foreground">Administration</p>
          <h1 className="mt-1 text-2xl font-bold text-foreground">Connectors</h1>
          <p className="mt-1 text-sm text-muted-foreground">
            Configure credentials for third-party service integrations.
          </p>
        </div>
        <Link
          href="/connectors/guide"
          className="shrink-0 inline-flex items-center gap-2 rounded-lg bg-mixnavy px-4 py-2 text-sm font-medium text-white shadow-sm hover:bg-mixnavy/90"
        >
          How to create a connector
        </Link>
      </div>
      {notice && (
        <div
          className={`mb-4 rounded-lg border px-4 py-3 text-sm ${
            notice.tone === "ok"
              ? "border-green-200 bg-green-50 text-green-900"
              : "border-yellow-200 bg-yellow-50 text-yellow-900"
          }`}
        >
          {notice.text}
        </div>
      )}
      <ConnectorRegistryList
        connectors={statuses}
        configureAction={configureConnector}
        testAction={testConnector}
      />
    </div>
  );
}
