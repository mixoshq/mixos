"use client";

import { useMemo, useState } from "react";
import { Search } from "lucide-react";
import type { ConnectorManifest } from "@/lib/connectors/types";
import type { ConnectorTestOutcome } from "@/lib/connectors/test-connection";
import ConnectorRegistryRow from "./connector-registry-row";

/** Connection state for a three-legged connector; null for every other kind. */
export interface ConnectorOAuthStatus {
  connected: boolean;
  /** Epoch millis the access token expires, when one is stored. */
  expiresAt: number | null;
  /** Redirect URI to register upstream; null when no origin is configured. */
  redirectUri: string | null;
}

export type ConnectorWithStatus = ConnectorManifest & {
  configured: boolean;
  oauth: ConnectorOAuthStatus | null;
};

interface Props {
  connectors: ConnectorWithStatus[];
  configureAction: (formData: FormData) => void;
  testAction: (connectorName: string) => Promise<ConnectorTestOutcome>;
}

type StatusFilter = "all" | "configured" | "unconfigured";

const STATUS_OPTIONS: Array<{ value: StatusFilter; label: string }> = [
  { value: "all", label: "All" },
  { value: "configured", label: "Configured" },
  { value: "unconfigured", label: "Unconfigured" },
];

export default function ConnectorRegistryList({
  connectors,
  configureAction,
  testAction,
}: Props) {
  const [query, setQuery] = useState("");
  const [status, setStatus] = useState<StatusFilter>("all");
  const lower = query.toLowerCase();
  const searchMatches = useMemo(
    () =>
      connectors.filter((c) => {
        if (!query) return true;
        return (
          c.displayName.toLowerCase().includes(lower) ||
          c.name.toLowerCase().includes(lower) ||
          c.description.toLowerCase().includes(lower)
        );
      }),
    [connectors, query, lower],
  );
  const counts = useMemo(() => {
    let configured = 0;
    let unconfigured = 0;
    for (const c of searchMatches) {
      if (c.configured) configured++;
      else unconfigured++;
    }
    return { all: searchMatches.length, configured, unconfigured };
  }, [searchMatches]);
  const filtered = searchMatches.filter((c) => {
    if (status === "configured") return c.configured;
    if (status === "unconfigured") return !c.configured;
    return true;
  });

  return (
    <>
      <div className="mb-4 flex flex-col gap-2 sm:flex-row sm:items-center">
        <div className="relative flex-1">
          <Search className="absolute left-3 top-1/2 h-4 w-4 -translate-y-1/2 text-muted-foreground" />
          <input
            type="text"
            placeholder="Search connectors..."
            value={query}
            onChange={(e) => setQuery(e.target.value)}
            className="w-full rounded-lg border border-border bg-background py-2 pl-9 pr-3 text-sm shadow-sm focus:outline-none focus:ring-1 focus:ring-ring"
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
                    ? "bg-mixnavy text-white"
                    : "text-muted-foreground hover:text-foreground"
                }`}
              >
                <span>{opt.label}</span>
                <span
                  className={`rounded px-1.5 py-px text-xs tabular-nums ${
                    active
                      ? "bg-white/20 text-white"
                      : "bg-muted text-muted-foreground"
                  }`}
                >
                  {count}
                </span>
              </button>
            );
          })}
        </div>
      </div>
      <div className="rounded-xl border border-border bg-card shadow-sm">
        <div className="divide-y divide-border">
          {filtered.length > 0 ? (
            filtered.map((connector) => (
              <ConnectorRegistryRow
                key={connector.name}
                connector={connector}
                configureAction={configureAction}
                testAction={testAction}
              />
            ))
          ) : (
            <div className="px-6 py-8 text-center text-muted-foreground">
              {query || status !== "all"
                ? "No connectors match your filters."
                : "No connectors registered. Add a connector to the /connectors directory."}
            </div>
          )}
        </div>
      </div>
    </>
  );
}
