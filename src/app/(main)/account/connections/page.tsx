/* This Source Code Form is subject to the terms of the Mozilla Public
 * License, v. 2.0. If a copy of the MPL was not distributed with this
 * file, You can obtain one at https://mozilla.org/MPL/2.0/. */

import { revalidatePath } from "next/cache";
import { requireReadOnlySession } from "@/lib/auth/session";
import { connectorRegistry } from "@/generated/connector-registry";
import { getDecryptedConfig } from "@/lib/connectors/config";
import { connectorConfigState } from "@/lib/connectors/status";
import {
  deleteUserTokens,
  listUserConnections,
} from "@/lib/connectors/user-config";
import UserConnectionList from "@/components/account/user-connection-list";

/**
 * The connectors each person signs into themselves.
 *
 * Only connectors declaring `userScoped` appear. Everything else in the product
 * is tenant-scoped — one account an admin connected, shared by everyone — and
 * has no personal state to show here.
 */
export default async function ConnectionsPage() {
  const session = await requireReadOnlySession();
  const userId = session.user.id;

  const userScoped = connectorRegistry.filter((c) => c.userScoped);
  const connections = await listUserConnections(userId);
  const byName = new Map(connections.map((c) => [c.connectorName, c]));

  const items = await Promise.all(
    userScoped.map(async (connector) => {
      /*
        Whether the ADMIN has registered the application. A person cannot
        connect their own account until the client id and secret exist, and
        "Connect" that silently fails is worse than a button that explains
        itself — so the page says which of the two is missing.
      */
      const tenantCreds = await getDecryptedConfig(connector.name);
      const appRegistered =
        connectorConfigState(connector.auth, tenantCreds) !== "unconfigured" ||
        Boolean(tenantCreds && Object.keys(tenantCreds).length > 0);

      const mine = byName.get(connector.name);
      return {
        name: connector.name,
        displayName: connector.displayName,
        description: connector.description,
        icon: connector.icon ?? null,
        appRegistered,
        connectedAt: mine?.connectedAt ?? null,
        expiresAt: mine?.expiresAt ?? null,
      };
    }),
  );

  async function disconnect(connectorName: string) {
    "use server";
    // Re-checked inside the action: a server action is a public endpoint, and
    // the page-level check above does not protect it. The user id comes from
    // the session, never from the caller — otherwise this would revoke anyone.
    const inner = await requireReadOnlySession();
    await deleteUserTokens(inner.user.id, connectorName);
    revalidatePath("/account/connections");
  }

  return (
    <div>
      <h1 className="text-2xl font-bold text-foreground">My Connections</h1>
      <p className="mt-1 text-sm text-muted-foreground">
        Sign in to the services that act as you, rather than through the shared
        account an admin connects.
      </p>
      <div className="mt-6">
        <UserConnectionList items={items} disconnectAction={disconnect} />
      </div>
    </div>
  );
}
