/* This Source Code Form is subject to the terms of the Mozilla Public
 * License, v. 2.0. If a copy of the MPL was not distributed with this
 * file, You can obtain one at https://mozilla.org/MPL/2.0/. */

"use client";

import { useMemo, useState, useTransition } from "react";
import { Search } from "lucide-react";
import type { ConnectorManifest } from "@/lib/connectors/types";
import type { ConnectorVerification } from "@/lib/connectors/config";
import type { ConnectorAccess } from "@/lib/connectors/access";
import type { ScopeStatusRow } from "@/lib/connectors/scope-status";
import type { ConnectorScope } from "@/lib/connectors/types";
import {
  describeDependents,
  type ConnectorDependents,
} from "@/lib/connectors/dependents";
import type { ConnectorConfigState } from "@/lib/connectors/status";
import type { ConnectorReplacement } from "@/lib/connectors/switch";
import type { ConnectorTestOutcome } from "@/lib/connectors/test-connection";
import { describeIdentity } from "@/lib/repository/identity";
import ConnectorTile from "./connector-tile";
import ConnectorConfigureDialog from "./connector-configure-dialog";
import type { ProposalTarget } from "@/lib/github/outcomes";
import RemoveDialog, { type RemoveTarget } from "./remove/remove-dialog";
import TypedConfirmDialog from "./typed-confirm-dialog";
import { Button } from "@/components/ui/button";
import { CARD_SHELL } from "@/components/ui/card";
import { Dialog } from "@/components/ui/dialog";
import { cn } from "@/lib/utils";

/** Connection state for a three-legged connector; null for every other kind. */
export interface ConnectorOAuthStatus {
  /**
   * A grant is stored: the deployment's, or for a user-scoped connector the
   * viewing admin's own.
   */
  connected: boolean;
  /** Epoch millis the access token expires, when one is stored. */
  expiresAt: number | null;
  /** Redirect URI to register upstream; null when no origin is configured. */
  redirectUri: string | null;
  /**
   * Every scope the provider documents, each flagged `requested`. The consent
   * screen only ever asks for the requested subset; the rest is the catalogue
   * the Scopes tab renders.
   */
  scopes: ConnectorScope[];
}

export type ConnectorWithStatus = ConnectorManifest & {
  /**
   * Derived server-side by `registryConfigState()`, which applies the rule the
   * runtime's `configured` getter uses, so the tile cannot claim a connector is
   * ready when no app could call it. For a user-scoped connector it describes
   * the deployment's half — the saved application — since each person's grant
   * is their own.
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
  scopeStatus: ScopeStatusRow[];
  /** Which apps declare this connector, required vs optional. */
  dependents: ConnectorDependents;
  /**
   * When an admin disabled it (ISO 8601), or null while it is enabled. A
   * disabled connector keeps its credentials and its `state`; nothing calls it.
   */
  disabledAt: string | null;
  /**
   * Set when the release step found it under a name a different connector had,
   * and turned it off. Enabling it needs its name typed, and clears this.
   */
  replacement: ConnectorReplacement | null;
  /**
   * Whether an admin allowed it to change data (lib/connectors/writable.ts).
   * Off for every connector until someone allows it, and meaningless for one
   * with no method declared `mutates`.
   */
  changesAllowed: boolean;
  oauth: ConnectorOAuthStatus | null;
};

interface Props {
  connectors: ConnectorWithStatus[];
  /** Connector whose dialog should be open on load — set by the OAuth return. */
  initialOpen?: string | null;
  /** Returns whether the connector now holds a usable credential set. */
  configureAction: (formData: FormData) => Promise<boolean>;
  testAction: (connectorName: string) => Promise<ConnectorTestOutcome>;
  /** On a built deployment with the GitHub App linked: where a removal can be proposed instead. */
  proposal?: ProposalTarget | null;
  /**
   * Disable (`enabled: false`) or Enable a connector. Enabling one that
   * replaces a different connector passes its name as typed.
   */
  switchAction: (
    connectorName: string,
    enabled: boolean,
    typedName?: string,
  ) => Promise<void>;
  /** Allow a connector to change data, or make it read-only again. */
  changesAction: (connectorName: string, allowed: boolean) => Promise<void>;
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
  switchAction,
  changesAction,
  proposal = null,
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

  const [switching, startSwitch] = useTransition();
  /** The connector awaiting Disable's confirmation, or null. */
  const [confirmingDisable, setConfirmingDisable] =
    useState<ConnectorWithStatus | null>(null);
  /** A replacing connector awaiting Enable's typed confirmation, or null. */
  const [confirmingEnable, setConfirmingEnable] =
    useState<ConnectorWithStatus | null>(null);
  const [enableError, setEnableError] = useState<string | null>(null);
  /** The connector whose Remove dialog is open, or null. */
  const [removing, setRemoving] = useState<RemoveTarget | null>(null);

  function enable(connector: ConnectorWithStatus) {
    if (connector.replacement) {
      setEnableError(null);
      setConfirmingEnable(connector);
      return;
    }
    startSwitch(async () => {
      await switchAction(connector.name, true);
    });
  }

  function confirmEnable(typed: string) {
    if (!confirmingEnable) return;
    const name = confirmingEnable.name;
    startSwitch(async () => {
      try {
        await switchAction(name, true, typed);
        setConfirmingEnable(null);
      } catch {
        setEnableError("It couldn't be enabled. Reload the page and try again.");
      }
    });
  }

  function confirmDisable() {
    if (!confirmingDisable) return;
    const name = confirmingDisable.name;
    startSwitch(async () => {
      await switchAction(name, false);
      setConfirmingDisable(null);
    });
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
                    active
                      ? "bg-white/20 text-brand-foreground"
                      : "bg-muted text-foreground"
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
        <div className="grid grid-cols-1 gap-4 sm:grid-cols-2 lg:grid-cols-3">
          {filtered.map((connector) => (
            <ConnectorTile
              key={connector.name}
              connector={connector}
              onConfigure={() => openTile(connector.name)}
              onDisable={() => setConfirmingDisable(connector)}
              onEnable={() => enable(connector)}
              onRemove={() =>
                setRemoving({ kind: "connector", slug: connector.name, name: connector.displayName })
              }
              switching={switching}
            />
          ))}
        </div>
      ) : (
        <div
          className={cn(CARD_SHELL, "p-5 text-center text-muted-foreground")}
        >
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
          changesAction={changesAction}
        />
      )}

      {/*
        Disabling asks first, and names what it affects: every app that
        declares the connector starts failing its calls to it. Enabling only
        puts things back, so it does not ask.
      */}
      <Dialog
        open={confirmingDisable !== null}
        onClose={() => setConfirmingDisable(null)}
        title={
          confirmingDisable ? `Disable ${confirmingDisable.displayName}?` : ""
        }
        size="sm"
        footer={
          <div className="flex justify-end gap-2">
            <Button
              variant="ghost"
              onClick={() => setConfirmingDisable(null)}
              disabled={switching}
            >
              Cancel
            </Button>
            <Button
              variant="destructive"
              onClick={confirmDisable}
              busy={switching}
              busyLabel="Disabling…"
            >
              Disable
            </Button>
          </div>
        }
      >
        {confirmingDisable && (
          <div className="space-y-3 text-sm">
            <p className="text-muted-foreground">
              Apps can&apos;t call it until you enable it again, and its
              webhooks, Connect and Test Connection are refused. Its credentials
              are kept.
            </p>
            <p className="text-foreground">
              {describeDependents(confirmingDisable.dependents)}
            </p>
            {(confirmingDisable.dependents.required.length > 0 ||
              confirmingDisable.dependents.optional.length > 0) && (
              <dl className="space-y-1">
                {confirmingDisable.dependents.required.length > 0 && (
                  <div className="flex flex-wrap gap-x-2">
                    <dt className="text-muted-foreground">Required by</dt>
                    <dd className="text-foreground">
                      {confirmingDisable.dependents.required.join(" · ")}
                    </dd>
                  </div>
                )}
                {confirmingDisable.dependents.optional.length > 0 && (
                  <div className="flex flex-wrap gap-x-2">
                    <dt className="text-muted-foreground">Optional for</dt>
                    <dd className="text-foreground">
                      {confirmingDisable.dependents.optional.join(" · ")}
                    </dd>
                  </div>
                )}
              </dl>
            )}
          </div>
        )}
      </Dialog>

      {/*
        Enabling a connector the release step found under a name a different
        connector had asks for the name: the credentials it would be handed
        were saved for the one before it.
      */}
      {confirmingEnable?.replacement && (
        <TypedConfirmDialog
          onClose={() => setConfirmingEnable(null)}
          title={`Enable ${confirmingEnable.displayName}?`}
          word={confirmingEnable.name}
          confirmLabel="Enable"
          busyLabel="Enabling…"
          busy={switching}
          error={enableError}
          onConfirm={confirmEnable}
        >
          <p className="text-muted-foreground">
            A different connector had the name{" "}
            <code className="font-mono text-foreground">
              {confirmingEnable.name}
            </code>{" "}
            before this one, so it was disabled.
          </p>
          <dl className="space-y-1">
            <div className="flex flex-wrap gap-x-2">
              <dt className="text-muted-foreground">Before</dt>
              <dd className="text-foreground">
                {describeIdentity(confirmingEnable.replacement.previous)}
              </dd>
            </div>
            <div className="flex flex-wrap gap-x-2">
              <dt className="text-muted-foreground">Now</dt>
              <dd className="text-foreground">
                {describeIdentity(confirmingEnable.replacement.identity)}
              </dd>
            </div>
          </dl>
          <p className="text-muted-foreground">
            Enabling it hands it the credentials saved under this name, and
            every user&apos;s connection to it.{" "}
            {describeDependents(confirmingEnable.dependents)}
          </p>
        </TypedConfirmDialog>
      )}

      {removing && <RemoveDialog target={removing} propose={proposal} onClose={() => setRemoving(null)} />}
    </>
  );
}
