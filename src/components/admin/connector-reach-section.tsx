/* This Source Code Form is subject to the terms of the Mozilla Public
 * License, v. 2.0. If a copy of the MPL was not distributed with this
 * file, You can obtain one at https://mozilla.org/MPL/2.0/. */

"use client";

import { Suspense, use, useState } from "react";
import { StatusPill } from "@/components/ui/status";
import { InfoTooltip } from "@/components/ui/info-tooltip";
import {
  OBSERVED_DAYS,
  describeAppReach,
  describeReach,
  type AppReach,
  type ConnectorReach,
  type ObservedCall,
  type ObservedCalls,
  type OwnCredentialStatus,
} from "@/lib/connectors/reach";
import type { CredentialField } from "@/lib/connectors/types";
import AppCredentialsPanel, { OWN_STATE_LABEL, type AppCredentialActions } from "./app-credentials-panel";
import AppLimitsPanel, { type SetAppLimits } from "./app-limits-panel";

/**
 * The Details tab's Reach section: every app that declares this connector,
 * whether it runs, what MixOS lets it call, and what it called in the last
 * 30 days. The answer to "if one of these apps were compromised, what could it
 * do with this connector?", and to "which apps does a change here affect?".
 *
 * What each app may call is drawn with the page (lib/connectors/reach.ts). The
 * calls come from telemetry, streamed in after it: the page passes a promise,
 * and the rows show without them until it settles.
 */

/** The calls for this connector: still coming, unreadable, or read. */
type Observed = { state: "loading" } | { state: "unknown" } | { state: "read"; calls: ObservedCall[] };

export interface ReachSectionProps {
  reach: ConnectorReach;
  /** The connector's name, to find its calls in `observed`. */
  connectorName: string;
  /** All connectors' calls, as the page streams them; absent where nothing passes it (a test). */
  observed?: Promise<ObservedCalls | null>;
  /** How many of the connector's methods change data. */
  declaredWrites: number;
  /** An admin switched it off: nothing can call it. */
  disabled: boolean;
  /** Each person connects their own account. */
  userScoped: boolean;
  /** It authenticates with a credential, which a public API doesn't. */
  authenticates: boolean;
  /**
   * Changes are allowed, and the shared grant was taken before they were: the
   * provider refuses the writes until someone connects again.
   */
  writeGrantMissing: boolean;
  /** Apps with credentials of their own for it (lib/connectors/app-config.ts). */
  ownCredentials?: OwnCredentialStatus[];
  /**
   * What giving an app its own credentials needs: the connector's fields and
   * the page's actions. Absent where they can't be given, a user-scoped
   * connector or one that authenticates with nothing.
   */
  ownCredentialsSetup?: {
    displayName: string;
    fields: CredentialField[];
    isOAuth: boolean;
    actions: AppCredentialActions;
  };
  /** An app whose own credentials to open on arrival: the way back from its Connect. */
  initialApp?: string | null;
  /**
   * What narrowing an app's reach needs (lib/connectors/app-access.ts): the
   * connector's methods, and the page's action. Absent where nothing passes it.
   */
  limitsSetup?: {
    methods: { method: string; mutates: boolean }[];
    setLimits: SetAppLimits;
  };
}

/**
 * Which row's panel is open, `cred:<slug>` or `limits:<slug>`, held above the
 * Suspense so streaming in the calls keeps it.
 */
interface OpenRow {
  openApp: string | null;
  toggle: (key: string) => void;
}

export default function ConnectorReachSection(props: ReachSectionProps) {
  const { reach, observed, connectorName } = props;
  const [openApp, setOpenApp] = useState<string | null>(props.initialApp ? `cred:${props.initialApp}` : null);
  const open: OpenRow = { openApp, toggle: (key) => setOpenApp((v) => (v === key ? null : key)) };
  return (
    <section>
      <h3 className="text-xs font-semibold uppercase tracking-widest text-muted-foreground">
        Reach
      </h3>
      {reach.apps.length === 0 ? (
        <p className="mt-1 text-sm text-foreground">No app uses this connector yet.</p>
      ) : observed ? (
        <Suspense fallback={<ReachList {...props} {...open} observed={{ state: "loading" }} />}>
          <StreamedReachList {...props} {...open} observed={observed} connectorName={connectorName} />
        </Suspense>
      ) : (
        <ReachList {...props} {...open} observed={{ state: "unknown" }} />
      )}
    </section>
  );
}

function StreamedReachList(
  props: Omit<ReachSectionProps, "observed"> & OpenRow & { observed: Promise<ObservedCalls | null> },
) {
  const all = use(props.observed);
  const calls = all?.[props.connectorName];
  return <ReachList {...props} observed={calls ? { state: "read", calls } : { state: "unknown" }} />;
}

/** The section's body, with the calls as they stand. Exported for its test. */
export function ReachList({
  reach,
  observed,
  connectorName,
  declaredWrites,
  disabled,
  userScoped,
  authenticates,
  writeGrantMissing,
  ownCredentials = [],
  ownCredentialsSetup,
  limitsSetup,
  openApp = null,
  toggle = () => {},
}: Omit<ReachSectionProps, "observed" | "initialApp"> & Partial<OpenRow> & { observed: Observed }) {
  const declaring = new Set(reach.apps.map((a) => a.slug));
  const ownBySlug = new Map(ownCredentials.filter((o) => declaring.has(o.appSlug)).map((o) => [o.appSlug, o]));
  const sharedCount = reach.apps.length - ownBySlug.size;
  /** Calls from an app that doesn't declare the connector now, or from no app at all. */
  const others =
    observed.state === "read" ? observed.calls.filter((c) => c.appSlug === null || !declaring.has(c.appSlug)) : [];

  return (
    <div className="mt-1 space-y-2">
      <p className="text-sm text-foreground">
        {describeReach(reach)}.{" "}
        {userScoped
          ? "Each person connects their own account, and an app uses it only on that person's requests."
          : !authenticates
            ? null
            : ownBySlug.size === 0
              ? "They all use the same credential, so revoking it at the provider stops every one of them."
              : sharedCount === 0
                ? "Each of them uses credentials of its own."
                : `${sharedCount === 1 ? "One uses" : `${sharedCount} use`} the shared credential, and ${
                    ownBySlug.size === 1 ? "one uses its own" : `${ownBySlug.size} use their own`
                  }.`}
      </p>

      {disabled && (
        <p className="text-sm text-muted-foreground">
          While it is disabled, none of them can call it.
        </p>
      )}
      {!reach.activityKnown && (
        <p className="rounded-md border border-warning/40 bg-warning/10 px-3 py-2 text-sm text-foreground">
          Couldn&apos;t read which apps are active, so every app is shown as if it runs.
        </p>
      )}
      {writeGrantMissing && reach.canWriteCount > 0 && (
        <p className="rounded-md border border-warning/40 bg-warning/10 px-3 py-2 text-sm text-foreground">
          The grant was taken before changes were allowed, so the provider refuses these apps&apos; changes
          until someone connects again.
        </p>
      )}

      <ul className="divide-y divide-border overflow-hidden rounded-md border border-border">
        {reach.apps.map((app, i) => (
          <li key={app.slug} className={`px-3 py-2 ${i % 2 === 1 ? "bg-muted/60" : ""}`}>
            <AppRow
              app={app}
              declaredWrites={declaredWrites}
              observed={observed}
              own={ownBySlug.get(app.slug)}
              setup={ownCredentialsSetup}
              limits={limitsSetup}
              connectorName={connectorName}
              openCredentials={openApp === `cred:${app.slug}`}
              openLimits={openApp === `limits:${app.slug}`}
              onToggle={(panel) => toggle(`${panel}:${app.slug}`)}
            />
          </li>
        ))}
      </ul>

      {others.length > 0 && (
        <div className="text-xs text-muted-foreground">
          <p className="font-medium text-foreground">
            Called in the last {OBSERVED_DAYS} days by apps that don&apos;t declare it now
          </p>
          <ul className="mt-1 space-y-0.5">
            {groupByApp(others).map(([key, calls]) => (
              <li key={key}>
                {calls[0].appName ?? calls[0].appSlug ?? "No app recorded"}: {callList(calls)}
              </li>
            ))}
          </ul>
        </div>
      )}

      <p className="text-xs text-muted-foreground">
        What MixOS lets each app call. MCP tools and search only ever read. What the provider allows
        is the credential&apos;s scopes, on the Methods and Scopes tabs.
      </p>
    </div>
  );
}

function AppRow({
  app,
  declaredWrites,
  observed,
  own,
  setup,
  limits,
  connectorName,
  openCredentials: open,
  openLimits,
  onToggle,
}: {
  app: AppReach;
  declaredWrites: number;
  observed: Observed;
  own: OwnCredentialStatus | undefined;
  setup: ReachSectionProps["ownCredentialsSetup"];
  limits: ReachSectionProps["limitsSetup"];
  connectorName: string;
  openCredentials: boolean;
  openLimits: boolean;
  onToggle: (panel: "cred" | "limits") => void;
}) {
  const callable = new Set([...app.reads, ...app.writes]);
  // What it could reach before any limit: every read, and every write if its
  // entry asks for "write".
  const asksWrites = app.write !== "none" && app.write !== "not-asked";
  const reachableMethods = (limits?.methods ?? []).filter((m) => !m.mutates || asksWrites);
  return (
    <>
      <span className="flex flex-wrap items-center gap-x-2 gap-y-1">
        <span className="text-sm font-medium text-foreground">{app.name}</span>
        <span className="text-xs text-muted-foreground">{app.optional ? "Optional" : "Required"}</span>
        {app.active === false && (
          <InfoTooltip tip="An admin switched it off, so none of its code runs and it calls nothing. Activating it hands it what this row lists.">
            <StatusPill tone="neutral">Inactive</StatusPill>
          </InfoTooltip>
        )}
        {app.canWriteNow && <StatusPill tone="warning">Changes data</StatusPill>}
        {app.write === "read-only" && (
          <InfoTooltip tip="Its entry asks to change data, and this connector is read-only, so its changes are refused before the provider is asked.">
            <StatusPill tone="neutral">Read-only here</StatusPill>
          </InfoTooltip>
        )}
        {app.narrowing && (
          <InfoTooltip tip="An admin narrowed what it may call here: its writes, the methods, or both.">
            <StatusPill tone="neutral">Limited</StatusPill>
          </InfoTooltip>
        )}
        {own && (
          <InfoTooltip tip="An admin gave it credentials of its own, which it uses instead of the shared ones. It never falls back to the shared ones.">
            <StatusPill tone={own.state === "ready" ? "success" : own.state === "unreadable" ? "danger" : "warning"}>
              {OWN_STATE_LABEL[own.state]}
            </StatusPill>
          </InfoTooltip>
        )}
        <span className="ml-auto flex items-center gap-3">
          {limits && reachableMethods.length > 0 && (
            <button
              type="button"
              onClick={() => onToggle("limits")}
              aria-expanded={openLimits}
              className="text-xs font-medium text-primary underline underline-offset-2 hover:no-underline"
            >
              {openLimits ? "Close" : "Limits…"}
            </button>
          )}
          {setup && (
            <button
              type="button"
              onClick={() => onToggle("cred")}
              aria-expanded={open}
              className="text-xs font-medium text-primary underline underline-offset-2 hover:no-underline"
            >
              {open ? "Close" : own ? "Its own credentials…" : "Give it its own credentials…"}
            </button>
          )}
        </span>
      </span>
      <span className="mt-0.5 block text-sm text-foreground">{describeAppReach(app, declaredWrites)}</span>
      <span className="mt-0.5 block text-xs text-muted-foreground">
        {observedLine(
          observed,
          (c) => c.appSlug === app.slug,
          (method) => callable.has(method),
        )}
      </span>
      {limits && openLimits && (
        <AppLimitsPanel
          connectorName={connectorName}
          appSlug={app.slug}
          appName={app.name}
          methods={reachableMethods}
          asksWrites={asksWrites && reachableMethods.some((m) => m.mutates)}
          narrowing={app.narrowing}
          setLimits={limits.setLimits}
        />
      )}
      {setup && open && (
        <AppCredentialsPanel
          connectorName={connectorName}
          connectorDisplayName={setup.displayName}
          appSlug={app.slug}
          appName={app.name}
          fields={setup.fields}
          isOAuth={setup.isOAuth}
          own={own}
          actions={setup.actions}
        />
      )}
    </>
  );
}

/** "In the last 30 days: listDeals 124 · getDeal 3, 1 failed", or why there is no such line. */
function observedLine(
  observed: Observed,
  mine: (c: ObservedCall) => boolean,
  callable: (method: string) => boolean,
): string {
  if (observed.state === "loading") return `Reading the last ${OBSERVED_DAYS} days' calls…`;
  if (observed.state === "unknown") return "Couldn't read which methods it called.";
  const calls = observed.calls.filter(mine);
  if (calls.length === 0) return `No calls in the last ${OBSERVED_DAYS} days.`;
  return `In the last ${OBSERVED_DAYS} days: ${callList(calls, callable)}`;
}

/**
 * Each method with how often it was called, and how often that failed. A
 * method the app can't call now (a write, before it went read-only) says so.
 */
function callList(calls: ObservedCall[], callable?: (method: string) => boolean): string {
  return calls
    .map((c) => {
      const failed = c.errors > 0 ? `, ${c.errors} failed` : "";
      const refused = c.refused > 0 ? `, ${c.refused.toLocaleString("en-US")} refused` : "";
      const gone = callable && !callable(c.method) ? ", not callable now" : "";
      return `${c.method} ${c.calls.toLocaleString("en-US")}${failed}${refused}${gone}`;
    })
    .join(" · ");
}

function groupByApp(calls: ObservedCall[]): Array<[string, ObservedCall[]]> {
  const by = new Map<string, ObservedCall[]>();
  for (const c of calls) {
    const key = c.appSlug ?? "";
    by.set(key, [...(by.get(key) ?? []), c]);
  }
  return [...by.entries()];
}
