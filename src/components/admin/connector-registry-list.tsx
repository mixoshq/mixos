/* This Source Code Form is subject to the terms of the Mozilla Public
 * License, v. 2.0. If a copy of the MPL was not distributed with this
 * file, You can obtain one at https://mozilla.org/MPL/2.0/. */

"use client";

import { useMemo, useState } from "react";
import { Search } from "lucide-react";
import type { ConnectorManifest } from "@/lib/connectors/types";
import type { ConnectorVerification } from "@/lib/connectors/config";
import type { ConnectorAccess } from "@/lib/connectors/access";
import type { ScopeDocs } from "@/lib/connectors/scope-docs";
import type { ConnectorDependents } from "@/lib/connectors/dependents";
import type { ConnectorConfigState } from "@/lib/connectors/status";
import type { ConnectorTestOutcome } from "@/lib/connectors/test-connection";
import ConnectorTile from "./connector-tile";
import ConnectorConfigureDialog from "./connector-configure-dialog";

/** Connection state for a three-legged connector; null for every other kind. */
export interface ConnectorOAuthStatus {
  connected: boolean;
  /** Epoch millis the access token expires, when one is stored. */
  expiresAt: number | null;
  /** Redirect URI to register upstream; null when no origin is configured. */
  redirectUri: string | null;
  /** Scopes the consent screen will ask for. Shown so the ask is not a surprise. */
  scopes: string[];
}

export type ConnectorWithStatus = ConnectorManifest & {
  /**
   * Derived server-side by `connectorConfigState()` — the same function the
   * runtime's `configured` getter uses, so the tile cannot claim a connector is
   * ready when no app could call it.
   */
  state: ConnectorConfigState;
  /**
   * When Test Connection last actually succeeded. Distinct from `state`, which
   * only knows what is stored — a complete credential set the upstream rejects
   * still reads as "ready".
   */
  verification: ConnectorVerification;
  /** Granted scopes and observed usage — see lib/connectors/access.ts. */
  access: ConnectorAccess;
  /** Cached plain-English permissions from the provider's reference page. */
  scopeDocs: ScopeDocs;
  /** Which apps declare this connector, required vs optional. */
  dependents: ConnectorDependents;
  oauth: ConnectorOAuthStatus | null;
};

interface Props {
  connectors: ConnectorWithStatus[];
  /** Connector whose dialog should be open on load — set by the OAuth return. */
  initialOpen?: string | null;
  /** Returns whether the connector now holds a usable credential set. */
  configureAction: (formData: FormData) => Promise<boolean>;
  testAction: (connectorName: string) => Promise<ConnectorTestOutcome>;
  refreshScopeDocsAction: (
    connectorName: string,
  ) => Promise<{ ok: boolean; error?: string }>;
}

type StatusFilter = "all" | "configured" | "unconfigured";

const STATUS_OPTIONS: Array<{ value: StatusFilter; label: string }> = [
  { value: "all", label: "All" },
  { value: "configured", label: "Configured" },
  { value: "unconfigured", label: "Unconfigured" },
];

export default function ConnectorRegistryList({
  connectors,
  initialOpen = null,
  configureAction,
  testAction,
  refreshScopeDocsAction,
}: Props) {
  const [query, setQuery] = useState("");
  const [status, setStatus] = useState<StatusFilter>("all");
  /** Which connector's dialog is open. One at a time, by name. */
  const [openName, setOpenName] = useState<string | null>(initialOpen);
  /**
   * Whether the open dialog was opened by the URL or by a click. Only the URL
   * case means "you were already mid-setup" — it is set by the OAuth return —
   * so only that case lands on the Configure tab. A tile click always starts on
   * Details, including a second click on the same connector.
   */
  const [openedFromUrl, setOpenedFromUrl] = useState(initialOpen !== null);

  function openTile(name: string) {
    setOpenedFromUrl(false);
    setOpenName(name);
  }

  const lower = query.toLowerCase();
  /*
    Everything written about a connector, not just what its tile shows. The
    words an admin actually types — "mailbox", "consent screen" — live in the
    setup prose, and `description` is a 140-character blurb about the service.
    Searching only the visible fields would find almost none of them.
  */
  const haystacks = useMemo(
    () =>
      new Map(
        connectors.map((c) => {
          const parts = [c.displayName, c.name, c.description];
          if (c.setup) {
            for (const step of c.setup.steps) {
              parts.push(step.text);
              if (step.why) parts.push(step.why);
            }
            if (c.setup.notes) {
              parts.push(...Object.values(c.setup.notes).filter(Boolean));
            }
          }
          return [c.name, parts.join(" ").toLowerCase()] as const;
        }),
      ),
    [connectors],
  );
  const searchMatches = useMemo(
    () =>
      connectors.filter(
        (c) => !query || (haystacks.get(c.name)?.includes(lower) ?? false),
      ),
    [connectors, query, lower, haystacks],
  );

  // "Configured" means ready to be called. A three-legged connector awaiting
  // authorization is not — it files under Unconfigured, matching what the tile
  // says and what the runtime does.
  const counts = useMemo(() => {
    let configured = 0;
    let unconfigured = 0;
    for (const c of searchMatches) {
      if (c.state === "ready") configured++;
      else unconfigured++;
    }
    return { all: searchMatches.length, configured, unconfigured };
  }, [searchMatches]);

  const filtered = searchMatches.filter((c) => {
    if (status === "configured") return c.state === "ready";
    if (status === "unconfigured") return c.state !== "ready";
    return true;
  });

  const openConnector = connectors.find((c) => c.name === openName) ?? null;

  return (
    <>
      <div className="mb-4 flex flex-col gap-2 sm:flex-row sm:items-center">
        <div className="relative flex-1">
          <Search className="absolute left-3 top-1/2 h-4 w-4 -translate-y-1/2 text-muted-foreground" />
          <input
            type="text"
            placeholder="Search connectors..."
            aria-label="Search connectors"
            value={query}
            onChange={(e) => setQuery(e.target.value)}
            className="w-full rounded-lg border border-input bg-background py-2 pl-9 pr-3 text-sm shadow-sm focus:outline-none focus:ring-1 focus:ring-ring"
          />
        </div>
        <div
          role="tablist"
          aria-label="Filter by configuration status"
          className="inline-flex shrink-0 rounded-lg border border-border bg-background p-0.5 shadow-sm"
        >
          {STATUS_OPTIONS.map((opt) => {
            const active = status === opt.value;
            const count = counts[opt.value];
            return (
              <button
                key={opt.value}
                role="tab"
                type="button"
                aria-selected={active}
                onClick={() => setStatus(opt.value)}
                className={`inline-flex items-center gap-1.5 rounded-md px-3 py-1.5 text-sm transition-colors ${
                  active
                    ? "bg-brand text-brand-foreground"
                    : "text-muted-foreground hover:text-foreground"
                }`}
              >
                <span>{opt.label}</span>
                <span
                  className={`rounded px-1.5 py-px text-xs tabular-nums ${
                    active ? "bg-white/20 text-brand-foreground" : "bg-muted text-foreground"
                  }`}
                >
                  {count}
                </span>
              </button>
            );
          })}
        </div>
      </div>

      {filtered.length > 0 ? (
        <div className="grid gap-4 sm:grid-cols-2 lg:grid-cols-3">
          {filtered.map((connector) => (
            <ConnectorTile
              key={connector.name}
              connector={connector}
              onConfigure={() => openTile(connector.name)}
            />
          ))}
        </div>
      ) : (
        <div className="rounded-xl border border-border bg-card px-6 py-8 text-center text-muted-foreground shadow-sm">
          {query || status !== "all"
            ? "No connectors match your filters."
            : "No connectors registered. Add a connector to the /connectors directory."}
        </div>
      )}

      {/*
        One dialog for the whole grid rather than one per tile. Mounting a
        focus-trapping dialog under every card would put N copies of its key
        handlers on the document, and unmounting on close is what resets the
        save/test state between connectors.
      */}
      {openConnector && (
        <ConnectorConfigureDialog
          key={openConnector.name}
          connector={openConnector}
          open
          initialTab={openedFromUrl ? "configure" : "details"}
          onClose={() => setOpenName(null)}
          configureAction={configureAction}
          testAction={testAction}
          refreshScopeDocsAction={refreshScopeDocsAction}
        />
      )}
    </>
  );
}
