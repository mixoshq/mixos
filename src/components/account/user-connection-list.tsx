/* This Source Code Form is subject to the terms of the Mozilla Public
 * License, v. 2.0. If a copy of the MPL was not distributed with this
 * file, You can obtain one at https://mozilla.org/MPL/2.0/. */

"use client";

import { useTransition } from "react";
import Image from "next/image";
import { Link2, Plug, UserRound } from "lucide-react";
import { Button } from "@/components/ui/button";
import { Card, CARD_SHELL } from "@/components/ui/card";
import { StatusPill } from "@/components/ui/status";
import { useClientValue } from "@/lib/use-client-value";

export interface UserConnectionItem {
  name: string;
  displayName: string;
  description: string;
  icon: string | null;
  /** Whether an admin has registered the application this signs into. */
  appRegistered: boolean;
  /** An admin disabled this connector; connecting is refused until it is enabled. */
  disabled: boolean;
  connectedAt: number | null;
  expiresAt: number | null;
}

function relative(epochMs: number): string {
  const deltaMin = Math.round((epochMs - Date.now()) / 60000);
  const abs = Math.abs(deltaMin);
  const unit =
    abs < 60
      ? `${abs} min`
      : abs < 1440
        ? `${Math.round(abs / 60)} hr`
        : `${Math.round(abs / 1440)} days`;
  return deltaMin >= 0 ? `in ${unit}` : `${unit} ago`;
}

/** Client-only: relative time depends on the reader's clock, not the server's. */
function When({ at, prefix }: { at: number; prefix: string }) {
  const text = useClientValue(() => relative(at), null);
  return text ? (
    <>
      {prefix} {text}
    </>
  ) : null;
}

export default function UserConnectionList({
  items,
  disconnectAction,
}: {
  items: UserConnectionItem[];
  disconnectAction: (connectorName: string) => Promise<void>;
}) {
  const [pending, startTransition] = useTransition();

  if (items.length === 0) {
    return (
      // Same empty-state shell as the connector registry's: px-6 py-8, centred.
      <Card className="px-6 py-8 text-center shadow-sm">
        <UserRound
          className="mx-auto h-8 w-8 text-muted-foreground"
          aria-hidden
        />
        <p className="mt-3 font-medium text-foreground">
          No personal connections
        </p>
        {/*
          Says what would put something here, rather than only that nothing is.
          This is the expected state: almost every connector is tenant-scoped,
          and those are an administrator's to configure, not yours.
        */}
        <p className="mx-auto mt-1 max-w-md text-sm text-muted-foreground">
          Some connectors ask each person to sign in with their own account
          rather than sharing one. None are set up yet — when there are, they
          appear here for you to connect.
        </p>
      </Card>
    );
  }

  return (
    <ul className="space-y-3">
      {items.map((item) => {
        const connected = item.connectedAt !== null;
        const disconnect = (
          <Button
            size="sm"
            busy={pending}
            busyLabel="Disconnecting…"
            onClick={() =>
              startTransition(async () => disconnectAction(item.name))
            }
          >
            Disconnect
          </Button>
        );
        return (
          // CARD_SHELL rather than <Card>: these rows are list items, and Card
          // only renders block-level tags. The constant is the same one Card
          // uses, so the shell cannot drift from it.
          <li
            key={item.name}
            className={`${CARD_SHELL} flex flex-wrap items-center gap-4 p-4 shadow-sm`}
          >
            <span className="flex h-11 w-11 shrink-0 items-center justify-center overflow-hidden rounded-lg border border-border bg-background">
              {item.icon ? (
                <Image
                  src={item.icon}
                  alt=""
                  width={44}
                  height={44}
                  className="h-8 w-8 object-contain"
                />
              ) : (
                <Plug className="h-5 w-5 text-muted-foreground" aria-hidden />
              )}
            </span>

            <span className="min-w-0 flex-1">
              <span className="flex flex-wrap items-center gap-2">
                <span className="font-medium text-foreground">
                  {item.displayName}
                </span>
                <StatusPill tone={connected ? "success" : "neutral"}>
                  {connected ? "Connected" : "Not connected"}
                </StatusPill>
              </span>
              <span className="mt-0.5 block text-sm text-muted-foreground">
                {connected && item.connectedAt ? (
                  <>
                    <When at={item.connectedAt} prefix="Connected" />
                    {item.expiresAt ? (
                      <>
                        {" · "}
                        <When at={item.expiresAt} prefix="access expires" />
                      </>
                    ) : null}
                  </>
                ) : (
                  item.description
                )}
              </span>
            </span>

            {item.disabled ? (
              // Connecting is refused while it is disabled, so this says why
              // rather than offering a button that bounces. A grant already
              // stored is kept, and is still the person's own to remove.
              <span className="flex shrink-0 items-center gap-2">
                <span className="text-sm text-muted-foreground">
                  An administrator has disabled this.
                </span>
                {connected && disconnect}
              </span>
            ) : !item.appRegistered ? (
              // The person cannot fix this themselves, so it explains rather
              // than offering a button that would fail.
              <span className="text-sm text-muted-foreground">
                An administrator has not finished setting this up yet.
              </span>
            ) : connected ? (
              <span className="flex shrink-0 items-center gap-2">
                {/*
                  A stored grant can still be one the provider no longer
                  renews, and then apps send the person here to connect. This
                  page cannot tell without asking the provider, so reconnecting
                  is always on offer: it replaces the grant in one round trip.
                */}
                <a
                  href={`/api/connectors/${encodeURIComponent(item.name)}/oauth/start?return=/account/connections`}
                  className="inline-flex h-9 items-center gap-1.5 rounded-md bg-secondary px-3 text-sm font-medium text-secondary-foreground hover:bg-secondary/80 focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-ring"
                >
                  <Link2 className="h-4 w-4" aria-hidden />
                  Reconnect
                </a>
                {disconnect}
              </span>
            ) : (
              // A plain anchor: this is a full-page round trip out to the
              // provider and back, which is what the OAuth flow needs.
              <a
                href={`/api/connectors/${encodeURIComponent(item.name)}/oauth/start?return=/account/connections`}
                className="inline-flex h-9 shrink-0 items-center gap-1.5 rounded-md bg-primary px-3 text-sm font-medium text-primary-foreground shadow-sm hover:bg-primary/90 focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-ring"
              >
                <Link2 className="h-4 w-4" aria-hidden />
                Connect
              </a>
            )}
          </li>
        );
      })}
    </ul>
  );
}
