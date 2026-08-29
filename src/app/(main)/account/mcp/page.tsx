/* This Source Code Form is subject to the terms of the Mozilla Public
 * License, v. 2.0. If a copy of the MPL was not distributed with this
 * file, You can obtain one at https://mozilla.org/MPL/2.0/. */

import { redirect } from "next/navigation";
import { requireReadOnlySession } from "@/lib/auth/session";
import { appRegistry } from "@/generated/app-registry";
import { getAppOrigin } from "@/lib/env/origin";
import { consentableApps } from "@/lib/mcp/tools";
import { listAuthorizedClients } from "@/lib/mcp/store";
import { formatLastUpdated } from "@/lib/apps/display";
import LucideIcon from "@/components/lucide-icon";
import { Card } from "@/components/ui/card";
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
      <h1 className="text-2xl font-bold text-foreground">My MCP Connections</h1>
      <p className="mt-1 text-sm text-muted-foreground">
        Connect Claude to MixOS so it can answer questions using data from your
        apps. Connections are <strong>read-only</strong> — they can never change
        anything — and only ever see apps you have access to.
      </p>

      <Card className="mt-6 p-4 shadow-sm">
        <p className="text-sm font-medium">Connect a client</p>
        <p className="mt-1 text-sm text-muted-foreground">
          In Claude, add a custom connector with this URL. You&apos;ll be sent
          back here to sign in and choose which apps it may read.
        </p>
        <code className="mt-3 block overflow-x-auto rounded bg-muted px-3 py-2 text-xs">
          {mcpUrl}
        </code>
      </Card>

      <h2 className="mt-8 text-sm font-semibold">Connected clients</h2>
      <div className="mt-3 space-y-3">
        {clients.length === 0 ? (
          <Card className="px-6 py-8 text-center text-sm text-muted-foreground shadow-sm">
            Nothing is connected yet.
          </Card>
        ) : (
          clients.map((c) => (
            <Card key={c.clientId} className="p-4 shadow-sm">
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
                    className="rounded-md border border-border px-3 py-1.5 text-sm hover:bg-destructive hover:text-destructive-foreground"
                  >
                    Disconnect
                  </button>
                </form>
              </div>
            </Card>
          ))
        )}
      </div>

      <h2 className="mt-8 text-sm font-semibold">Apps you can share</h2>
      <p className="mt-1 text-sm text-muted-foreground">
        These apps expose read-only tools over MCP. You choose which ones each
        client gets when you connect it.
      </p>
      <div className="mt-3 space-y-3">
        {available.length === 0 ? (
          <Card className="px-6 py-8 text-center text-sm text-muted-foreground shadow-sm">
            None of your apps expose data over MCP yet.
          </Card>
        ) : (
          available.map((app) => (
            <Card key={app.slug} className="p-4 shadow-sm">
              <p className="flex items-center gap-2 font-medium">
                <LucideIcon name={app.icon} className="h-4 w-4 shrink-0" />
                {app.name}
              </p>
              <ul className="mt-2 space-y-0.5">
                {app.mcp.map((t) => (
                  <li key={t.name} className="text-xs text-muted-foreground">
                    <code className="rounded bg-muted px-1 py-0.5">
                      {t.name}
                    </code>{" "}
                    — {t.description}
                  </li>
                ))}
              </ul>
            </Card>
          ))
        )}
      </div>
    </section>
  );
}
