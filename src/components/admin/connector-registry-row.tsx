"use client";

import { useState, useTransition } from "react";
import { ChevronDown, ChevronRight, Link2, Loader2, Plug, PlugZap } from "lucide-react";
import { renderAuthors, formatLastUpdated } from "@/lib/apps/display";
import { StatusPill } from "@/components/ui/status";
import type { ConnectorTestOutcome } from "@/lib/connectors/test-connection";
import type { ConnectorWithStatus } from "./connector-registry-list";

interface Props {
  connector: ConnectorWithStatus;
  configureAction: (formData: FormData) => void;
  testAction: (connectorName: string) => Promise<ConnectorTestOutcome>;
}

/** "in 52 minutes" / "3 days ago" — enough for an admin to judge freshness. */
function formatExpiry(epochMs: number): string {
  const deltaMin = Math.round((epochMs - Date.now()) / 60000);
  const abs = Math.abs(deltaMin);
  const unit = abs < 60 ? `${abs} min` : abs < 1440 ? `${Math.round(abs / 60)} hr` : `${Math.round(abs / 1440)} days`;
  return deltaMin >= 0 ? `expires in ${unit}` : `expired ${unit} ago`;
}

export default function ConnectorRegistryRow({
  connector,
  configureAction,
  testAction,
}: Props) {
  const [expanded, setExpanded] = useState(false);
  const [testing, startTest] = useTransition();
  const [outcome, setOutcome] = useState<ConnectorTestOutcome | null>(null);

  return (
    <div>
      <div
        className="flex cursor-pointer items-start justify-between px-6 py-4 hover:bg-accent/50"
        onClick={() => setExpanded((v) => !v)}
      >
        <div className="flex items-start gap-2">
          {expanded ? (
            <ChevronDown className="mt-0.5 h-4 w-4 shrink-0 text-muted-foreground" />
          ) : (
            <ChevronRight className="mt-0.5 h-4 w-4 shrink-0 text-muted-foreground" />
          )}
          <Plug className="mt-0.5 h-5 w-5 shrink-0 text-muted-foreground" />
          <div>
            <p className="font-medium">{connector.displayName}</p>
            <p className="text-sm text-muted-foreground">
              {connector.description}
            </p>
            {/*
              One pill, deliberately. A "User-scoped" badge used to sit beside
              it, keyed on a `scope` manifest field that no longer exists —
              connectors are tenant-scoped only, and `scope` is now actively
              rejected by RawConnectorManifestSchema (a z.strictObject), so a
              connector.json carrying it fails the build rather than silently
              re-enabling the badge. See docs/connectors/architecture.md.
            */}
            <div className="mt-1 flex items-center gap-2">
              <span className="rounded-full bg-slate-100 px-2 py-0.5 text-xs font-medium text-slate-800">
                {connector.credentialFields.length} Settings
              </span>
            </div>
          </div>
        </div>
        <div className="flex shrink-0 flex-col items-end gap-3">
          <p className="text-[10px] leading-none text-muted-foreground">
            <strong className="font-semibold">Updated</strong>{" "}
            {formatLastUpdated(connector.lastUpdated, "Not yet committed")}
          </p>
          <span
            className={`rounded-full px-2.5 py-0.5 text-xs font-medium ${
              connector.configured
                ? "bg-green-100 text-green-800"
                : "bg-yellow-100 text-yellow-800"
            }`}
          >
            {connector.configured ? "Configured" : "Not Configured"}
          </span>
          {connector.authors && connector.authors.length > 0 && (
            <p className="text-[10px] leading-none text-muted-foreground">
              <strong className="font-semibold">Authored By</strong>{" "}
              {renderAuthors(connector.authors)}
            </p>
          )}
        </div>
      </div>

      {expanded && (
        <div className="border-t border-border bg-accent/20 px-6 py-4 pl-12">
          <form action={configureAction}>
            <input
              type="hidden"
              name="connectorName"
              value={connector.name}
            />
            <div className="space-y-4">
              {connector.credentialFields.map((field) => (
                <div key={field.key}>
                  <label className="mb-1 block text-sm font-medium">
                    {field.label}
                  </label>
                  <input
                    type={field.type === "password" ? "password" : "text"}
                    name={field.key}
                    placeholder={
                      connector.configured
                        ? "••••••••"
                        : `Enter ${field.label}`
                    }
                    className="w-full rounded-md border border-input bg-background px-3 py-2 text-sm shadow-sm focus:outline-none focus:ring-1 focus:ring-ring"
                  />
                </div>
              ))}
            </div>
            <button
              type="submit"
              className="mt-4 rounded-md bg-mixnavy px-4 py-2 text-sm font-medium text-white hover:bg-mixnavy/90"
            >
              {connector.configured ? "Update Credentials" : "Configure"}
            </button>
          </form>

          {/*
            "Configured" only means the fields are non-empty. This is what turns
            that claim into a fact — a key pasted with a trailing space, or a
            base URL pointing at the wrong environment, shows up here instead of
            through a broken widget days later.
          */}
          <div className="mt-4 border-t border-border pt-4">
            <div className="flex flex-wrap items-center gap-3">
              <button
                type="button"
                disabled={testing}
                onClick={() =>
                  startTest(async () => setOutcome(await testAction(connector.name)))
                }
                className="inline-flex items-center gap-2 rounded-md border border-input bg-background px-3 py-2 text-sm font-medium shadow-sm hover:bg-accent disabled:cursor-not-allowed disabled:opacity-60"
              >
                {testing ? (
                  <Loader2 className="h-4 w-4 animate-spin" aria-hidden />
                ) : (
                  <PlugZap className="h-4 w-4" aria-hidden />
                )}
                {testing ? "Testing…" : "Test Connection"}
              </button>

              {outcome && !testing && (
                <StatusPill tone={outcome.ok ? "success" : "danger"}>
                  {outcome.ok ? "Connection works" : "Connection failed"}
                </StatusPill>
              )}
            </div>

            {outcome && !testing && (
              <div className="mt-2 space-y-1">
                <p className="text-sm text-muted-foreground">
                  {outcome.ok
                    ? (outcome.detail ?? "The upstream accepted our credentials.")
                    : outcome.message}
                </p>
                {!outcome.ok && outcome.adminHint && (
                  <p className="text-xs text-muted-foreground">{outcome.adminHint}</p>
                )}
                {!outcome.ok && outcome.upstreamRequestId && (
                  <p className="font-mono text-[11px] text-muted-foreground">
                    Reference: {outcome.upstreamRequestId}
                  </p>
                )}
              </div>
            )}
          </div>

          {connector.oauth && (
            <div className="mt-6 border-t border-border pt-4">
              <div className="flex items-start justify-between gap-4">
                <div className="min-w-0">
                  <p className="text-sm font-medium">Authorization</p>
                  <p className="mt-0.5 text-sm text-muted-foreground">
                    {connector.oauth.connected ? (
                      <>
                        Connected
                        {connector.oauth.expiresAt
                          ? ` — access token ${formatExpiry(connector.oauth.expiresAt)}, refreshed automatically.`
                          : "."}
                      </>
                    ) : (
                      "Not connected. Save the client ID and secret above, then authorize."
                    )}
                  </p>
                </div>
                {/*
                  A plain anchor, not a router link: this starts a full-page
                  navigation out to the provider and back, which is exactly what
                  the OAuth round trip needs.
                */}
                <a
                  href={`/api/connectors/${encodeURIComponent(connector.name)}/oauth/start?return=/admin/connectors`}
                  className="shrink-0 inline-flex items-center gap-2 rounded-md border border-input bg-background px-3 py-2 text-sm font-medium shadow-sm hover:bg-accent"
                >
                  <Link2 className="h-4 w-4" />
                  {connector.oauth.connected ? "Reconnect" : "Connect"}
                </a>
              </div>

              {connector.oauth.redirectUri ? (
                <div className="mt-3">
                  <label className="mb-1 block text-xs font-medium text-muted-foreground">
                    Redirect URI — register this in the provider&apos;s app settings
                  </label>
                  <input
                    readOnly
                    value={connector.oauth.redirectUri}
                    onFocus={(e) => e.currentTarget.select()}
                    className="w-full rounded-md border border-input bg-muted px-3 py-2 font-mono text-xs shadow-sm"
                  />
                </div>
              ) : (
                <p className="mt-3 text-xs text-yellow-800">
                  Set NEXTAUTH_URL to this deployment&apos;s public URL before connecting —
                  the redirect URI is built from it.
                </p>
              )}
            </div>
          )}
        </div>
      )}
    </div>
  );
}
