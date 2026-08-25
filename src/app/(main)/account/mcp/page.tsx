import { redirect } from "next/navigation";
import { requireReadOnlySession } from "@/lib/auth/session";
import { appRegistry } from "@/generated/app-registry";
import { getAppOrigin } from "@/lib/env/origin";
import { consentableApps } from "@/lib/mcp/tools";
import { listAuthorizedClients } from "@/lib/mcp/store";
import { formatLastUpdated } from "@/lib/apps/display";
import LucideIcon from "@/components/lucide-icon";
import { revokeMcpClient } from "./revoke-action";

/**
 * My MCP Connections — the user-facing side of the MCP server.
 *
 * Two jobs: show what is currently connected (and let the user cut it off), and
 * tell them how to connect in the first place.
 */
export const dynamic = "force-dynamic";

export default async function McpConnectionsPage() {
  const session = await requireReadOnlySession().catch(() => null);
  if (!session) redirect("/login");

  const [clients, available] = await Promise.all([
    listAuthorizedClients(session.user.id),
    consentableApps(session.user.id),
  ]);

  let mcpUrl: string;
  try {
    mcpUrl = `${getAppOrigin()}/api/mcp`;
  } catch {
    // NEXTAUTH_URL isn't set (local dev without a full .env.local). Show the
    // shape of the URL rather than crashing the page.
    mcpUrl = "<your MixOS URL>/api/mcp";
  }

  const appName = (slug: string) =>
    appRegistry.find((a) => a.slug === slug)?.name ?? slug;

  return (
    <section>
      <h2 className="text-lg font-semibold">My MCP Connections</h2>
      <p className="mt-1 text-sm text-muted-foreground">
        Connect Claude to MixOS so it can answer questions using data from
        your apps. Connections are <strong>read-only</strong> — they can never
        change anything — and only ever see apps you have access to.
      </p>

      <div className="mt-6 rounded-lg border border-border bg-card px-4 py-4">
        <p className="text-sm font-medium">Connect a client</p>
        <p className="mt-1 text-sm text-muted-foreground">
          In Claude, add a custom connector with this URL. You&apos;ll be sent
          back here to sign in and choose which apps it may read.
        </p>
        <code className="mt-3 block overflow-x-auto rounded bg-muted px-3 py-2 text-xs">
          {mcpUrl}
        </code>
      </div>

      <h3 className="mt-8 text-sm font-semibold">Connected clients</h3>
      <div className="mt-3 space-y-3">
        {clients.length === 0 ? (
          <div className="rounded-lg border border-border bg-card px-4 py-6 text-sm text-muted-foreground">
            Nothing is connected yet.
          </div>
        ) : (
          clients.map((c) => (
            <div
              key={c.clientId}
              className="rounded-lg border border-border bg-card px-4 py-3"
            >
              <div className="flex flex-wrap items-start justify-between gap-3">
                <div className="min-w-0">
                  <p className="font-medium">{c.clientName}</p>
                  <p className="mt-0.5 text-xs text-muted-foreground">
                    Connected {formatLastUpdated(c.createdAt.getTime())}
                    {c.lastUsedAt
                      ? ` · last used ${formatLastUpdated(c.lastUsedAt.getTime())}`
                      : " · never used"}
                  </p>
                  <p className="mt-2 text-sm text-muted-foreground">
                    {c.grantedApps.length === 0 ? (
                      <>Can&apos;t read any apps.</>
                    ) : (
                      <>Can read: {c.grantedApps.map(appName).join(", ")}</>
                    )}
                  </p>
                </div>
                <form action={revokeMcpClient}>
                  <input type="hidden" name="client_id" value={c.clientId} />
                  <button
                    type="submit"
                    className="rounded-md border border-border px-3 py-1.5 text-sm hover:bg-rose-500/10 hover:text-rose-600 dark:hover:text-rose-400"
                  >
                    Disconnect
                  </button>
                </form>
              </div>
            </div>
          ))
        )}
      </div>

      <h3 className="mt-8 text-sm font-semibold">Apps you can share</h3>
      <p className="mt-1 text-sm text-muted-foreground">
        These apps expose read-only tools over MCP. You choose which ones each
        client gets when you connect it.
      </p>
      <div className="mt-3 space-y-3">
        {available.length === 0 ? (
          <div className="rounded-lg border border-border bg-card px-4 py-6 text-sm text-muted-foreground">
            None of your apps expose data over MCP yet.
          </div>
        ) : (
          available.map((app) => (
            <div
              key={app.slug}
              className="rounded-lg border border-border bg-card px-4 py-3"
            >
              <p className="flex items-center gap-2 font-medium">
                <LucideIcon name={app.icon} className="h-4 w-4 shrink-0" />
                {app.name}
              </p>
              <ul className="mt-2 space-y-0.5">
                {app.mcp.map((t) => (
                  <li key={t.name} className="text-xs text-muted-foreground">
                    <code className="rounded bg-muted px-1 py-0.5">{t.name}</code> —{" "}
                    {t.description}
                  </li>
                ))}
              </ul>
            </div>
          ))
        )}
      </div>
    </section>
  );
}
