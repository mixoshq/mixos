/* This Source Code Form is subject to the terms of the Mozilla Public
 * License, v. 2.0. If a copy of the MPL was not distributed with this
 * file, You can obtain one at https://mozilla.org/MPL/2.0/. */

"use client";

import { useEffect, useRef, useState, type ReactNode } from "react";
import Link from "next/link";
import { AlertCircle, Search } from "lucide-react";
import type { AppManifest, EscapeRule } from "@/lib/apps/types";
import { MIXOS_SOURCE } from "@/lib/apps/types";
import {
  getAppSchema,
  type AppSchemaColumn,
  type AppSchemaTable,
} from "@/lib/apps/admin-actions";
import { Dialog } from "@/components/ui/dialog";
import { StatusPill } from "@/components/ui/status";
import FolderTabs from "@/components/ui/folder-tabs";
import LucideIcon from "@/components/lucide-icon";
import AppSettingsPanel from "./app-settings-panel";
import { Provenance, RemoveAction } from "./provenance";
import { formatCount } from "@/lib/apps/display";
import {
  getMcpToolSettings,
  setMcpToolEnabledAction,
} from "@/lib/mcp/tool-settings-actions";
import { Toggle } from "@/components/ui/toggle";
import { useToast } from "@/components/ui/toast";
import {
  BLOCK_LABEL,
  blockDone,
  groupByBlock,
  type MissingConnector,
} from "@/lib/apps/connector-readiness";
import AppAccessPanel from "./app-access-panel";
import { appRegistry } from "@/generated/app-registry";
import { remixIndex } from "@/generated/remix-index";
import {
  describeAnchor,
  remixesFrom,
  remixesInto,
  type RemixIndexEntry,
} from "@/lib/apps/remix";

type DialogTab =
  | "overview"
  | "access"
  | "settings"
  | "wiring"
  | "connectors"
  | "mcp"
  | "database"
  | "remixes";

/**
 * Every tab, on every app, always.
 *
 * FolderTabs argues for filtering tabs a record does not use, and that is right
 * for a tab band whose membership is itself information. It is not right here:
 * this is a registry an admin reads down, opening app after app, and a band that
 * reorders between them makes "check the connectors" a fresh hunt each time.
 * The empty states carry the same fact the missing tab would have — an app with
 * no database says so — without moving the tabs either side of it.
 *
 * Reach, MCP and Database sit together because they are one question asked
 * three ways: what does this app reach out to (its connectors and the hosts it
 * may call), what does it expose outwards, and what does it keep for itself.
 * Remixes comes last: where this app's code came from, and where it went.
 */
const TABS: Array<{ key: DialogTab; label: string }> = [
  { key: "overview", label: "Overview" },
  { key: "access", label: "Access" },
  { key: "settings", label: "Settings" },
  { key: "wiring", label: "Hooks & Services" },
  { key: "connectors", label: "Reach" },
  { key: "mcp", label: "MCP" },
  { key: "database", label: "Database" },
  { key: "remixes", label: "Remixes" },
];

/** Separator between app slug and tool name in the client-facing MCP name.
 *  Mirrors `toolFullName` in lib/mcp/tools.ts, which cannot be imported here —
 *  that module pulls in the grant checks and is server-only. */
const MCP_NS = "__";

/** A tab's section heading. Same rhythm as the connector dialog's. */
function SectionHeading({ children }: { children: ReactNode }) {
  return (
    <h3 className="text-xs font-semibold uppercase tracking-widest text-muted-foreground">
      {children}
    </h3>
  );
}

/**
 * What each escape means for the admin deciding whether to run the app — the
 * consequence, not the mechanism. `Record` over the rule type, so adding a rule
 * without saying what it means here fails the typecheck.
 */
const ESCAPE_MEANING: Record<EscapeRule, string> = {
  "raw-response":
    "Some routes return their own response, such as a download, a stream or a redirect, instead of validated data. Sign-in, role, CSRF and rate-limit checks still apply.",
};

/** What a tab says when the app declares nothing for it. */
function Empty({ children }: { children: ReactNode }) {
  return <p className="mt-1 text-sm text-muted-foreground">{children}</p>;
}

function Mono({ children }: { children: ReactNode }) {
  return (
    <code className="rounded bg-muted px-1 py-0.5 font-mono text-xs">
      {children}
    </code>
  );
}

/**
 * One line of a facts panel: label left, value hard right, hairline beneath.
 *
 * BORROWED FROM A NUTRITION LABEL, AND FOR THE SAME REASON. What an admin does
 * on this tab is compare — this app against the one they opened a minute ago —
 * and comparison wants a fixed set of rows in a fixed order with the numbers in
 * a column, not prose that reorders itself around whatever each app happens to
 * have. The rules are hairlines rather than the label's black bars: this sits on
 * a card inside a dialog, and heavy rules at this size read as a table someone
 * forgot to style.
 *
 * `sub` is the "Saturated Fat" indent — a constituent of the row above it,
 * carried at a lighter weight so the top-level rows still scan as a column.
 */
function Row({
  label,
  value,
  sub = false,
}: {
  label: ReactNode;
  value: ReactNode;
  sub?: boolean;
}) {
  return (
    <div
      className={`flex items-baseline justify-between gap-4 border-b border-border py-1.5 last:border-b-0 ${
        sub ? "pl-4" : ""
      }`}
    >
      <span
        className={
          sub
            ? "min-w-0 text-xs text-muted-foreground"
            : "text-sm font-semibold text-foreground"
        }
      >
        {label}
      </span>
      <span
        className={`shrink-0 tabular-nums ${
          sub ? "text-xs text-muted-foreground" : "text-sm text-foreground"
        }`}
      >
        {value}
      </span>
    </div>
  );
}

/** One of the two facts panels, headed and ruled. */
function FactsPanel({
  title,
  children,
}: {
  title: string;
  children: ReactNode;
}) {
  return (
    <section>
      <h3 className="border-b border-border pb-1 text-xs font-semibold uppercase tracking-widest text-foreground">
        {title}
      </h3>
      <div className="mt-1">{children}</div>
    </section>
  );
}

/**
 * The Database tab: a rail of tables beside the selected table's columns.
 *
 * WHY NOT ONE LONG LIST. A real app is not the two-table toy this started as —
 * ten tables, one of them twenty-eight columns wide, is ordinary. Rendered
 * flat that is roughly a hundred and twenty lines of
 * name-and-type in a panel eight of them tall, which is not a schema viewer, it
 * is a wall you scroll past. The rail turns "which tables are there" into one
 * glance and costs a single click to answer "what is in this one".
 *
 * Selection is DERIVED, never stored as the source of truth: `selected` is a
 * wish, and the table actually shown is that wish reconciled against what the
 * filter currently leaves visible. Storing the resolved table instead would
 * need an effect to repair it every time the filter changed — the exact
 * set-state-in-effect cascade this file avoids elsewhere.
 */
function SchemaBrowser({ tables }: { tables: AppSchemaTable[] }) {
  const [selected, setSelected] = useState<string | null>(null);
  const [filter, setFilter] = useState("");
  const needle = filter.trim().toLowerCase();

  const matches = (c: AppSchemaColumn) => c.name.toLowerCase().includes(needle);

  /*
    A table survives the filter if its own name matches — in which case all of
    its columns are relevant — or if any column does, in which case only the
    matching columns are. Without the first case, typing a table's name empties
    the very table you were looking for.
  */
  const visible = needle
    ? tables
        .map((t) => {
          const nameHit = t.name.toLowerCase().includes(needle);
          const cols = nameHit ? t.columns : t.columns.filter(matches);
          return {
            table: t,
            cols,
            hits: nameHit ? t.columns.length : cols.length,
          };
        })
        .filter((e) => e.cols.length > 0)
    : tables.map((t) => ({ table: t, cols: t.columns, hits: 0 }));

  const active =
    visible.find((e) => e.table.name === selected) ?? visible[0] ?? null;

  return (
    /* No top margin: with the heading gone, the filter box is the first thing
       in the panel and the dialog body already supplies the padding. */
    <div>
      <div className="relative max-w-sm">
        <Search
          aria-hidden
          className="absolute left-3 top-1/2 h-4 w-4 -translate-y-1/2 text-muted-foreground"
        />
        <input
          type="search"
          value={filter}
          onChange={(e) => setFilter(e.target.value)}
          placeholder="Filter tables and columns…"
          aria-label="Filter tables and columns"
          className="w-full rounded-lg border border-input bg-background py-2 pl-9 pr-3 text-sm shadow-sm focus:outline-none focus:ring-1 focus:ring-ring"
        />
      </div>

      {visible.length === 0 ? (
        <Empty>No table or column matches &ldquo;{filter.trim()}&rdquo;.</Empty>
      ) : (
        <div className="mt-3 grid gap-4 sm:grid-cols-[minmax(11rem,14rem)_1fr]">
          {/* The rail. A list of buttons, not a <select>: ten tables are worth
              showing at once, and their column counts are half the reason to
              look. */}
          <nav aria-label="Tables">
            <ul className="overflow-hidden rounded-lg border border-border">
              {visible.map(({ table, hits }, i) => {
                const isActive = active?.table.name === table.name;
                return (
                  <li key={table.name}>
                    <button
                      type="button"
                      onClick={() => setSelected(table.name)}
                      aria-current={isActive ? "true" : undefined}
                      className={`flex w-full items-baseline justify-between gap-2 px-3 py-2 text-left text-sm transition-colors ${
                        i > 0 ? "border-t border-border" : ""
                      } ${
                        isActive
                          ? "bg-primary text-primary-foreground"
                          : "bg-card text-foreground hover:bg-muted"
                      }`}
                    >
                      <span className="min-w-0 truncate font-mono text-xs">
                        {table.name}
                      </span>
                      {/* Full strength on the selected row: `bg-primary` has
                          exactly one verified foreground, and thinning it to
                          make the count read as secondary puts it under the
                          contrast floor. See docs/apps/ux.md#never-dim-a-token. */}
                      <span
                        className={`shrink-0 text-xs tabular-nums ${
                          isActive
                            ? "text-primary-foreground"
                            : "text-muted-foreground"
                        }`}
                      >
                        {needle ? hits : table.columns.length}
                      </span>
                    </button>
                  </li>
                );
              })}
            </ul>
            {/* Under the list it counts, in the rail's own small print — a
                heading above the whole tab named the panel you were already
                looking at, and put the number nowhere near the thing it was
                the number of. */}
            <p className="mt-2 text-xs text-muted-foreground">
              {needle && visible.length !== tables.length
                ? `${visible.length} of ${formatCount(tables.length, "table")}`
                : formatCount(tables.length, "table")}
            </p>
          </nav>

          {active && (
            <div className="min-w-0">
              <p className="flex flex-wrap items-baseline gap-x-2">
                <span className="font-mono text-sm font-semibold text-foreground">
                  {active.table.name}
                </span>
                <span className="text-xs text-muted-foreground">
                  {needle && active.cols.length !== active.table.columns.length
                    ? `${active.cols.length} of ${formatCount(active.table.columns.length, "column")} matching`
                    : formatCount(active.table.columns.length, "column")}
                </span>
              </p>
              {/* Scrolls inside itself: twenty-eight rows must not be what
                  decides the height of the panel around them. */}
              <div className="mt-2 overflow-x-auto rounded-lg border border-border">
                <table className="w-full text-left text-sm">
                  <thead>
                    <tr className="border-b border-border bg-muted/40 text-xs uppercase tracking-wide text-muted-foreground">
                      <th scope="col" className="px-3 py-1.5 font-semibold">
                        Column
                      </th>
                      <th scope="col" className="px-3 py-1.5 font-semibold">
                        Type
                      </th>
                      <th scope="col" className="px-3 py-1.5 font-semibold">
                        Nullable
                      </th>
                      <th scope="col" className="px-3 py-1.5 font-semibold">
                        Key
                      </th>
                      <th scope="col" className="px-3 py-1.5 font-semibold">
                        Default
                      </th>
                    </tr>
                  </thead>
                  <tbody className="divide-y divide-border">
                    {active.cols.map((c) => (
                      <tr key={c.name} className="align-baseline">
                        <td className="px-3 py-1.5 font-mono text-xs text-foreground">
                          {c.name}
                        </td>
                        <td className="px-3 py-1.5 font-mono text-xs text-muted-foreground">
                          {c.type}
                        </td>
                        <td className="px-3 py-1.5 text-xs text-muted-foreground">
                          {/* Spelled out rather than a tick or a blank: an
                              empty cell in a nullability column is the one
                              value a reader cannot tell from "not checked". */}
                          {c.nullable ? "yes" : "no"}
                        </td>
                        <td className="px-3 py-1.5 text-xs">
                          {c.primaryKey ? (
                            <StatusPill tone="neutral">PK</StatusPill>
                          ) : c.references ? (
                            <span className="font-mono text-xs text-muted-foreground">
                              → {c.references.table}.{c.references.column}
                            </span>
                          ) : (
                            <span className="text-muted-foreground">—</span>
                          )}
                        </td>
                        <td className="max-w-[14rem] px-3 py-1.5 font-mono text-xs text-muted-foreground">
                          {c.default ? (
                            /* `'draft'::text` and `gen_random_uuid()` are both
                               common and neither needs to wrap the row; the
                               full expression stays available on hover. */
                            <span className="block truncate" title={c.default}>
                              {c.default}
                            </span>
                          ) : (
                            "—"
                          )}
                        </td>
                      </tr>
                    ))}
                  </tbody>
                </table>
              </div>
            </div>
          )}
        </div>
      )}
    </div>
  );
}

/**
 * The not-ready-connector warning, worded once and rendered twice.
 *
 * It lives on the registry row and again on this dialog's Overview, for someone
 * who opened it to find out what the strip was about. Same component both
 * places, so the two cannot drift into saying different things.
 *
 * It is a warning, not a gate. What a connector that isn't ready blocks is
 * activating the app and granting it to anyone, both enforced on the server
 * (src/lib/apps/connector-gates.ts). Each connector is named with what it
 * still needs, in the Connector Registry's words: configured, connected after
 * its client ID is saved, or enabled after an admin switched it off.
 *
 * Worded by the app's state. An inactive app is waiting on the connectors to
 * be activated, which is the button a few pixels below. An active one was
 * activated before a connector stopped being ready (it was switched off, say),
 * so it is running without it: it still can't be granted, and whatever it
 * needs the connector for fails.
 */
export function MissingConnectorWarning({
  app,
  missingConnectors,
  isActive,
}: {
  app: AppManifest;
  missingConnectors: MissingConnector[];
  isActive: boolean;
}) {
  const groups = groupByBlock(missingConnectors);
  const names = groups.map(([state, group], g) => (
    <span key={state}>
      {g > 0 && (g === groups.length - 1 ? " and " : ", ")}
      {group.map((m, i) => (
        <span key={m.name}>
          {i > 0 && (i === group.length - 1 ? " and " : ", ")}
          <span className="font-semibold">{m.displayName}</span>
        </span>
      ))}{" "}
      {isActive
        ? group.length === 1
          ? "isn't"
          : "aren't"
        : group.length === 1
          ? "is"
          : "are"}{" "}
      {blockDone(state)}
    </span>
  ));
  return (
    <p className="flex items-start gap-2 text-xs text-foreground">
      <AlertCircle className="mt-0.5 h-3.5 w-3.5 shrink-0 text-primary" />
      <span>
        {isActive ? (
          <>
            <span className="font-semibold">{app.name}</span> is active, but{" "}
            {names}, so it can&apos;t be granted to anyone, and anything that
            needs {missingConnectors.length === 1 ? "that connector" : "those connectors"}{" "}
            fails
          </>
        ) : (
          <>
            <span className="font-semibold">{app.name}</span> can&apos;t be
            activated or granted until {names}
          </>
        )}
        .{" "}
        <Link
          href="/admin/connectors"
          className="font-medium text-primary underline underline-offset-2"
        >
          Open Connector Registry →
        </Link>
      </span>
    </p>
  );
}

/**
 * The Reach tab: what this app calls out to.
 *
 * Two sections, one question: the connectors it calls, which hold credentials
 * for outside services, and the hosts its own code may call, from `egress`.
 * Between them they are every way the app can send data out of the platform.
 * Exported for its test, which renders it on its own.
 */
export function AppReachPanel({
  app,
  missingConnectors,
}: {
  app: AppManifest;
  missingConnectors: MissingConnector[];
}) {
  const missing = new Map(missingConnectors.map((m) => [m.name, m]));
  return (
    <div className="space-y-8">
      <section>
        <SectionHeading>Connectors</SectionHeading>
        {app.connectors.length > 0 ? (
          <>
            {/*
              The name, the version the app was built against, whether it
              changes data there, and what the connector still needs before
              the app can be activated or granted.
            */}
            <ul className="mt-2 space-y-1 text-sm text-muted-foreground">
              {app.connectorRequirements
                .filter((need) => !need.optional)
                .map((need) => (
                  <li key={need.name} className="flex flex-wrap items-center gap-2">
                    <Mono>{need.name}</Mono>
                    <span>{need.version} or later</span>
                    {need.access === "write" && (
                      <StatusPill tone="warning">Changes data</StatusPill>
                    )}
                    {missing.get(need.name) && (
                      <StatusPill tone="warning">
                        {BLOCK_LABEL[missing.get(need.name)!.state]}
                      </StatusPill>
                    )}
                  </li>
                ))}
            </ul>
            {missingConnectors.length > 0 && (
              <p className="mt-3 text-xs text-muted-foreground">
                A connector this app requires must be ready before the app
                can be activated or granted to anyone: configured, connected
                if it signs in with OAuth, not disabled, and allowed to change
                data if the app changes data in it.{" "}
                <Link
                  href="/admin/connectors"
                  className="font-medium text-primary underline underline-offset-2"
                >
                  Open Connector Registry →
                </Link>
              </p>
            )}
          </>
        ) : (
          <Empty>
            This app calls no connector, so it holds no credentials for an
            outside service.
          </Empty>
        )}
      </section>

      {/*
        The hosts the app's own code may call, from the manifest's `egress`.
        context.http checks every request against this list, resolves the
        name, re-checks each address against private ranges, and repeats both
        on every redirect (src/lib/apps/http.ts), and the build refuses every
        other way out of app code, so with its connectors this is where the
        app's own code can send data. It is the field the Permissions guide on
        mixos.org tells an admin to read first.
      */}
      <section>
        <SectionHeading>Network</SectionHeading>
        {app.egress.length > 0 ? (
          <>
            <p className="mt-1 text-sm text-muted-foreground">
              The only hosts this app&apos;s own code can call. Each request,
              and each redirect, is checked against this list.
              {app.egress.some((host) => host.startsWith("*.")) &&
                " An entry starting with *. covers one level of subdomain under the name after it, and not that name itself."}
            </p>
            <ul className="mt-2 space-y-1 text-sm">
              {app.egress.map((host) => (
                <li key={host}>
                  <Mono>{host}</Mono>
                </li>
              ))}
            </ul>
          </>
        ) : (
          <Empty>
            This app makes no outbound calls of its own. It reaches outside
            services only through its connectors.
          </Empty>
        )}
      </section>
    </div>
  );
}

/**
 * The MCP tab: each tool the app contributes, with its admin switch.
 *
 * The switches are read each time the tab is shown, which includes every time
 * the dialog opens, since the dialog unmounts its panels when it closes. So
 * another admin's change, or a release step that turned the tools off when a
 * different extension took the slug, shows the next time the tab is opened,
 * without a reload. Null until known — never "all off" by default on screen,
 * since that would be a claim about the database we had not read. Exported
 * for its test.
 */
export function McpToolsPanel({ app }: { app: AppManifest }) {
  const toast = useToast();
  const [toolsOn, setToolsOn] = useState<Record<string, boolean> | null>(null);
  const [toolsError, setToolsError] = useState<string | null>(null);
  const [toolBusy, setToolBusy] = useState<string | null>(null);
  const toolsRequested = useRef(false);
  useEffect(() => {
    if (app.mcp.length === 0) return;
    if (toolsRequested.current) return;
    toolsRequested.current = true;
    getMcpToolSettings(app.slug)
      .then(setToolsOn)
      .catch(() => setToolsError("Reload the page to try again."));
  }, [app.mcp.length, app.slug]);

  // Optimistic: the switch moves when it is clicked, and moves back with a
  // toast if the save fails. Waiting for the round trip made it look broken.
  async function toggleTool(name: string, enabled: boolean) {
    setToolBusy(name);
    setToolsOn((prev) => ({ ...(prev ?? {}), [name]: enabled }));
    let refusal: string | null = null;
    try {
      const result = await setMcpToolEnabledAction(app.slug, name, enabled);
      if (!result.ok) refusal = result.message;
    } catch {
      // A thrown error reaches the browser without its words in production.
      refusal = "Could not change the tool. Reload the page and try again.";
    } finally {
      setToolBusy(null);
    }
    if (refusal !== null) {
      setToolsOn((prev) => ({ ...(prev ?? {}), [name]: !enabled }));
      toast.show("error", refusal);
    }
  }
  const enabledCount = toolsOn
    ? app.mcp.filter((t) => toolsOn[t.name]).length
    : null;

  return (
    <section>
      <SectionHeading>
        MCP tools
        {app.mcp.length
          ? enabledCount === null
            ? ` — ${formatCount(app.mcp.length, "tool")}`
            : ` — ${enabledCount} of ${app.mcp.length} enabled`
          : ""}
      </SectionHeading>
      {app.mcp.length === 0 ? (
        <Empty>
          This app contributes no MCP tools, so it never appears on the MCP
          consent screen.
        </Empty>
      ) : (
        <>
          <p className="mt-1 text-sm text-muted-foreground">
            Read-only tools this app contributes to the MixOS MCP server.
            Every tool starts off. A tool you switch on can be called by
            people who have this app and have authorized it on the consent
            screen; a tool that is off is not listed or callable for anyone,
            from its next call, and an app with none on is left off the
            consent screen.
          </p>
          {toolsError && (
            <p className="mt-2 flex items-start gap-1.5 text-sm text-destructive">
              <AlertCircle className="mt-0.5 h-4 w-4 shrink-0" />
              <span>Could not read the tool switches. {toolsError}</span>
            </p>
          )}
          {/*
            Every field is shown, because every field is written for a MODEL
            rather than for the admin reading this — and a description that
            reads badly here is a tool that gets called wrongly, or never.
            This tab is the only place that text is visible without opening
            app.json.
          */}
          <ul className="mt-3 space-y-3">
            {app.mcp.map((tool) => (
              <li
                key={tool.name}
                className="rounded-lg border border-border bg-muted/30 px-4 py-3"
              >
                <div className="flex flex-wrap items-start justify-between gap-3">
                  <p className="font-mono text-sm font-semibold text-foreground">
                    {app.slug}
                    {MCP_NS}
                    {tool.name}
                  </p>
                  {toolsOn !== null && (
                    <Toggle
                      checked={!!toolsOn[tool.name]}
                      onCheckedChange={(next) =>
                        toggleTool(tool.name, next)
                      }
                      label={`The ${tool.name} tool`}
                      busy={toolBusy === tool.name}
                      disabled={toolBusy !== null && toolBusy !== tool.name}
                    />
                  )}
                </div>
                <p className="mt-1 text-sm text-foreground">
                  {tool.description}
                </p>
                {tool.hint && (
                  <p className="mt-1 text-sm text-muted-foreground">
                    <span className="font-medium text-foreground">
                      When to use:
                    </span>{" "}
                    {tool.hint}
                  </p>
                )}
                <dl className="mt-2 space-y-1 text-xs">
                  <div className="flex flex-wrap items-baseline gap-x-2 gap-y-1">
                    <dt className="text-muted-foreground">Built from</dt>
                    <dd className="flex flex-wrap items-center gap-1">
                      {tool.sources.map((s) => (
                        <span key={s}>
                          {/* "mixos" is not a connector — it is the marker
                              for data that exists only in MixOS, and
                              rendering it as a slug would send an admin
                              hunting the connector registry for it. */}
                          {s === MIXOS_SOURCE ? (
                            <span className="rounded bg-muted px-1.5 py-0.5 text-xs text-foreground">
                              MixOS records
                            </span>
                          ) : (
                            <Mono>{s}</Mono>
                          )}
                        </span>
                      ))}
                    </dd>
                  </div>
                  {tool.notCovered && (
                    <div className="flex flex-wrap items-baseline gap-x-2">
                      <dt className="text-muted-foreground">Not covered</dt>
                      <dd className="text-foreground">{tool.notCovered}</dd>
                    </div>
                  )}
                </dl>
              </li>
            ))}
          </ul>
        </>
      )}
    </section>
  );
}

/** An app's name in this build, or its slug for one that has left it. */
function appName(slug: string): string {
  return appRegistry.find((a) => a.slug === slug)?.name ?? slug;
}

const DECISION_LABEL = { same: "Kept the same", different: "Changed", remove: "Removed" } as const;

/** `change-status` as a person says it. */
function spoken(id: string): string {
  return id.replace(/-/g, " ");
}

/** The commit a remix was taken at, as a short SHA, or why there is none. */
function Moment({ entry }: { entry: RemixIndexEntry["entry"] }) {
  const { source } = entry;
  return (
    <span className="flex flex-wrap items-center gap-2 text-xs text-muted-foreground">
      {source.commitSha ? (
        <span>
          at <Mono>{source.commitSha.slice(0, 7)}</Mono>
        </span>
      ) : (
        <span>never committed</span>
      )}
      {source.registry && (
        <span>
          version {source.registry.version} from{" "}
          {source.registry.origin.replace(/^https?:\/\//, "")}
        </span>
      )}
      {source.modified && <StatusPill tone="warning">Modified locally</StatusPill>}
      <span>on {entry.remixedAt}</span>
    </span>
  );
}

/** What was kept, changed and removed, grouped, for actions or hidden rules. */
function Decisions({
  label,
  decisions,
}: {
  label: string;
  decisions: Record<string, "same" | "different" | "remove"> | undefined;
}) {
  const ids = Object.keys(decisions ?? {});
  if (ids.length === 0) return null;
  return (
    <div className="flex flex-wrap items-baseline gap-x-2 gap-y-1">
      <dt className="text-muted-foreground">{label}</dt>
      <dd className="text-foreground">
        {(["same", "different", "remove"] as const)
          .map((d) => {
            const these = ids.filter((id) => decisions![id] === d);
            return these.length === 0
              ? null
              : `${DECISION_LABEL[d]}: ${these.map(spoken).join(", ")}`;
          })
          .filter(Boolean)
          .join(" · ")}
      </dd>
    </div>
  );
}

/** One remix, from either side. `from` names the source; otherwise the app that took it. */
function RemixCard({ remix, from }: { remix: RemixIndexEntry; from: boolean }) {
  const { entry } = remix;
  const [pointedAt, ...drewOn] = entry.source.anchors;
  return (
    <li className="rounded-lg border border-border bg-muted/30 px-4 py-3">
      <div className="flex flex-wrap items-start justify-between gap-3">
        <p className="text-sm font-semibold text-foreground">
          {from ? `From ${appName(entry.source.app)}` : `Into ${appName(remix.app)}`}
          <span className="font-normal text-muted-foreground">
            {" "}
            — the {describeAnchor(pointedAt)}
          </span>
        </p>
        <Moment entry={entry} />
      </div>
      <p className="mt-1 text-sm text-foreground">{entry.summary}</p>
      <dl className="mt-2 space-y-1 text-xs">
        {drewOn.length > 0 && (
          <div className="flex flex-wrap items-baseline gap-x-2 gap-y-1">
            <dt className="text-muted-foreground">Drew on</dt>
            <dd className="flex flex-wrap gap-1">
              {drewOn.map((a) => (
                <Mono key={a}>{describeAnchor(a)}</Mono>
              ))}
            </dd>
          </div>
        )}
        <Decisions label="Actions" decisions={entry.actions} />
        <Decisions label="Hidden rules" decisions={entry.hiddenRules} />
        {(entry.partsRemoved?.length ?? 0) > 0 && (
          <div className="flex flex-wrap items-baseline gap-x-2">
            <dt className="text-muted-foreground">Parts removed</dt>
            <dd className="text-foreground">
              {entry.partsRemoved!.map(spoken).join(", ")}
            </dd>
          </div>
        )}
        <div className="flex flex-wrap items-baseline gap-x-2 gap-y-1">
          <dt className="text-muted-foreground">Keywords</dt>
          <dd className="flex flex-wrap gap-1">
            {remix.keywords.map((k) => (
              <span
                key={k}
                className="rounded bg-muted px-1.5 py-0.5 text-xs text-foreground"
              >
                {k}
              </span>
            ))}
          </dd>
        </div>
        <div className="flex flex-wrap items-baseline gap-x-2">
          <dt className="text-muted-foreground">Code</dt>
          <dd className="text-foreground">
            {entry.license.mode === "adapted"
              ? `Adapted under ${entry.license.spdx}`
              : `Rebuilt from the remix card${entry.license.spdx ? ` (${entry.license.spdx})` : " (no license declared)"}`}
          </dd>
        </div>
        {from && (
          <div className="flex flex-wrap items-baseline gap-x-2 gap-y-1">
            <dt className="text-muted-foreground">Landed in</dt>
            <dd className="flex flex-wrap gap-1">
              {entry.landedIn.map((f) => (
                <Mono key={f}>{f}</Mono>
              ))}
            </dd>
          </div>
        )}
      </dl>
    </li>
  );
}

/**
 * Where this app's code came from and where it went: each remix as the moment
 * it was taken — the commit, what was kept, changed and removed — read from the
 * `remixedFrom` entries in this build (src/generated/remix-index.ts). The
 * remixed code has usually moved on since; the record hasn't, by design. See
 * docs/apps/remix.md.
 */
export function AppRemixPanel({ app }: { app: AppManifest }) {
  const from = remixesFrom(remixIndex, app.slug);
  const into = remixesInto(remixIndex, app.slug);
  return (
    <div className="space-y-8">
      <section>
        <SectionHeading>Remixed from</SectionHeading>
        {from.length === 0 ? (
          <Empty>This app hasn&apos;t remixed anything from another app.</Empty>
        ) : (
          <ul className="mt-3 space-y-3">
            {from.map((r) => (
              <RemixCard key={`${r.entry.source.app} ${r.entry.source.anchors[0]} ${r.entry.remixedAt}`} remix={r} from />
            ))}
          </ul>
        )}
      </section>

      <section>
        <SectionHeading>Remixed into</SectionHeading>
        {into.length === 0 ? (
          <Empty>No app in this build has remixed anything from this one.</Empty>
        ) : (
          <ul className="mt-3 space-y-3">
            {into.map((r) => (
              <RemixCard key={`${r.app} ${r.entry.source.anchors[0]} ${r.entry.remixedAt}`} remix={r} from={false} />
            ))}
          </ul>
        )}
      </section>
    </div>
  );
}

export default function AppDetailsDialog({
  app,
  missingConnectors,
  isActive,
  grantCount,
  onGrantCount,
  open,
  onClose,
  onRemove,
}: {
  app: AppManifest;
  missingConnectors: MissingConnector[];
  /** Whether the app serves anything, for the connector warning's wording. */
  isActive: boolean;
  /** Users holding a grant. Meaningless for a global app — see the row. */
  grantCount: number;
  /**
   * The count the Access tab just read, after a grant or a revoke, so the
   * tile's pill and the row below agree with the list without waiting for
   * the page to refresh.
   */
  onGrantCount?: (count: number) => void;
  open: boolean;
  onClose: () => void;
  /** Opens the Remove dialog in this one's place, from the footer's Remove. */
  onRemove?: () => void;
}) {
  const [tab, setTab] = useState<DialogTab>("overview");
  const [schema, setSchema] = useState<AppSchemaTable[] | null>(null);
  const [schemaError, setSchemaError] = useState<string | null>(null);
  const [schemaLoading, setSchemaLoading] = useState(false);

  /*
    Fetched on open rather than when the Database tab is reached, because the
    table count is on Overview — and a facts panel that fills in a row several
    seconds after you looked at it is worse than one query per open.

    The in-flight guard is a ref rather than state: setting state in the effect
    body is the cascading-render pattern React's rule flags, and the guard only
    exists to stop a second fetch.
  */
  const schemaRequested = useRef(false);
  useEffect(() => {
    if (!open || !app.database) return;
    if (schemaRequested.current) return;
    schemaRequested.current = true;
    setSchemaLoading(true);
    getAppSchema(app.slug)
      .then((s) => setSchema(s))
      .catch((e) => setSchemaError(e instanceof Error ? e.message : String(e)))
      .finally(() => setSchemaLoading(false));
  }, [open, app.database, app.slug]);


  const missing = new Map(missingConnectors.map((m) => [m.name, m]));

  const emits = [...app.hooks.emits.actions, ...app.hooks.emits.filters];
  const listens = [...app.hooks.listens.actions, ...app.hooks.listens.filters];

  return (
    <Dialog
      open={open}
      onClose={onClose}
      size="xl"
      fixedHeight
      title={app.name}
      subtitle={app.description}
      icon={
        <span className="flex h-8 w-8 shrink-0 items-center justify-center rounded-md border border-border bg-background">
          <LucideIcon
            name={app.icon}
            className="h-4 w-4 text-muted-foreground"
          />
        </span>
      }
      footer={<Provenance lastUpdated={app.lastUpdated} authors={app.authors} />}
      /*
        Where this app's source lives. The footer already carries provenance —
        when it changed and who changed it — and this is the third question in
        that set: where do I go to change it myself. Then Remove, last and
        quietest: the tile no longer carries it, so an admin opens the app,
        sees what it is, and removes it from here.
      */
      footerAside={
        <span className="flex items-center gap-4">
          <code className="font-mono text-xs text-muted-foreground">
            /apps/{app.slug}/
          </code>
          {onRemove && <RemoveAction name={app.name} onClick={onRemove} />}
        </span>
      }
      tabs={
        <FolderTabs
          items={TABS}
          active={tab}
          onChange={setTab}
          surface="card"
        />
      }
    >
      {tab === "overview" && (
        <div className="space-y-5">
          {missingConnectors.length > 0 && (
            <div className="rounded-lg border-l-4 border-brand-accent bg-brand-accent/10 px-4 py-3">
              <MissingConnectorWarning
                app={app}
                missingConnectors={missingConnectors}
                isActive={isActive}
              />
            </div>
          )}

          {/*
            Declared in app.json because it reaches past the app: the name and
            mark on the menu bar and the sign-in page belong to the install.
            Shown on Overview, where an admin looks before activating.
          */}
          {app.branding && (
            <div className="rounded-md border border-border bg-muted/50 px-3 py-2 text-sm text-foreground">
              <p className="font-medium">
                Changes the install&apos;s branding
              </p>
              <p className="mt-0.5">{app.branding.reason}</p>
              <p className="mt-1 text-xs">
                Filters{" "}
                {app.branding.hooks.map((h, i) => (
                  <span key={h}>
                    {i > 0 && ", "}
                    <Mono>{h}</Mono>
                  </span>
                ))}
                . A slot the active theme claims in its own{" "}
                <Mono>branding</Mono> stays the theme&apos;s.
              </p>
            </div>
          )}

          {/*
            Two panels, one question each: what the app is BUILT FROM, and what
            it is WIRED TO. Splitting them is what keeps either column short
            enough to take in at a glance — and it fills a panel this wide with
            two readable columns instead of one column and a void.
          */}
          <div className="grid gap-x-12 gap-y-6 sm:grid-cols-2">
            <FactsPanel title="Composition">
              {/*
                `global` in the manifest means every user holds this implicitly
                and the grant cannot be revoked — so there are no grant rows to
                count, and rendering the count anyway would report the widest
                possible audience as "0 granted users".

                First in the panel rather than last: a row placed after the
                widget and connector sub-lists sits at a different height on
                every app.
              */}
              <Row
                label="Who can install it"
                value={
                  app.global
                    ? "Anyone"
                    : formatCount(grantCount, "granted user")
                }
              />
              <Row label="Pages" value={app.pageCount} />
              <Row label="Widgets" value={app.widgets.length} />
              {app.widgets.map((w) => (
                <Row
                  key={w.id}
                  sub
                  /* The name leads because it is what the widget is called on a
                     dashboard; the id is what you grep for, so it lands in the
                     value column where the eye is already running down. */
                  label={
                    <span className="flex flex-wrap items-baseline gap-x-2">
                      <span className="text-foreground">{w.name}</span>
                      <span>
                        {formatCount(w.config?.length ?? 0, "setting")}
                      </span>
                    </span>
                  }
                  value={<Mono>{w.id}</Mono>}
                />
              ))}
              <Row label="Connectors" value={app.connectors.length} />
              {app.connectors.map((name) => (
                <Row
                  key={name}
                  sub
                  label={<Mono>{name}</Mono>}
                  /* Both states named, never one state and a blank: an admin
                     scanning for the unconfigured one should not have to decide
                     whether an empty cell means "fine" or "not checked". */
                  value={
                    missing.get(name) ? (
                      <StatusPill tone="warning">
                        {BLOCK_LABEL[missing.get(name)!.state]}
                      </StatusPill>
                    ) : (
                      <StatusPill tone="success">Configured</StatusPill>
                    )
                  }
                />
              ))}
              <Row label="MCP tools" value={app.mcp.length} />
              <Row
                label="Search objects"
                value={app.search.length === 0 ? 0 : app.search.map((o) => o.label).join(", ")}
              />
              <Row
                label="Database tables"
                /* The only live number in the panel, so it is the only one that
                   cannot be stated on the first render. An em dash for the
                   failed query rather than a 0: the count is unknown, and
                   "0 tables" would be a claim we did not verify. The Database
                   tab carries the error itself. */
                value={
                  !app.database
                    ? 0
                    : schema
                      ? schema.length
                      : schemaLoading
                        ? "Loading…"
                        : "—"
                }
              />
            </FactsPanel>

            <FactsPanel title="Wiring">
              <Row label="Hooks fired" value={emits.length} />
              <Row label="Hooks listened for" value={listens.length} />
              <Row label="Services provided" value={app.provides.length} />
              <Row label="Services consumed" value={app.consumes.length} />
            </FactsPanel>
          </div>

          {/*
            Here, where an admin looks before activating an app. The generator
            will not register a route that uses an escape the manifest does not
            declare, so an app cannot use one without it appearing in this list.
            See docs/plans/20261005_2150-app-escapes.md.
          */}
          <FactsPanel title="Escapes">
            {app.escapes.length === 0 ? (
              <Empty>None. No route sends its own response.</Empty>
            ) : (
              <ul className="mt-2 space-y-3">
                {app.escapes.map((escape) => (
                  <li key={escape.rule} className="text-sm">
                    <Mono>{escape.rule}</Mono>
                    <p className="mt-1 text-muted-foreground">
                      {ESCAPE_MEANING[escape.rule]}
                    </p>
                    <p className="mt-1 text-foreground">
                      <span className="text-muted-foreground">Reason given: </span>
                      {escape.reason}
                    </p>
                  </li>
                ))}
              </ul>
            )}
          </FactsPanel>
        </div>
      )}

      {tab === "access" && (
        <AppAccessPanel
          app={app}
          missingConnectors={missingConnectors}
          onAccessChange={(access) => {
            if (!access.global) onGrantCount?.(access.rows.length);
          }}
        />
      )}

      {tab === "wiring" && (
        <div className="grid gap-8 sm:grid-cols-2">
          <section>
            <SectionHeading>Hooks</SectionHeading>
            {emits.length === 0 && listens.length === 0 ? (
              <Empty>This app neither fires nor listens for a hook.</Empty>
            ) : (
              <div className="mt-2 space-y-3 text-sm text-muted-foreground">
                {emits.length > 0 && (
                  <div>
                    <p className="text-[10px] uppercase tracking-wider">
                      Fires
                    </p>
                    <ul className="mt-0.5 space-y-0.5">
                      {emits.map((h) => (
                        <li key={`emit-${h}`}>
                          <Mono>{h}</Mono>
                        </li>
                      ))}
                    </ul>
                  </div>
                )}
                {listens.length > 0 && (
                  <div>
                    <p className="text-[10px] uppercase tracking-wider">
                      Listens
                    </p>
                    <ul className="mt-0.5 space-y-0.5">
                      {listens.map((h) => (
                        <li key={`listen-${h}`}>
                          <Mono>{h}</Mono>
                        </li>
                      ))}
                    </ul>
                  </div>
                )}
              </div>
            )}
          </section>

          <section>
            <SectionHeading>App Services</SectionHeading>
            {app.provides.length === 0 && app.consumes.length === 0 ? (
              <Empty>
                This app neither provides nor consumes an app service.
              </Empty>
            ) : (
              <div className="mt-2 space-y-3 text-sm text-muted-foreground">
                {app.provides.length > 0 && (
                  <div>
                    <p className="text-[10px] uppercase tracking-wider">
                      Provides
                    </p>
                    <ul className="mt-0.5 space-y-0.5">
                      {app.provides.map((s) => (
                        <li key={`prov-${s.name}`}>
                          <Mono>
                            {app.slug}:{s.name}
                          </Mono>{" "}
                          <span className="text-[10px]">
                            ({s.audience ?? "user"})
                          </span>
                        </li>
                      ))}
                    </ul>
                  </div>
                )}
                {app.consumes.length > 0 && (
                  <div>
                    <p className="text-[10px] uppercase tracking-wider">
                      Consumes
                    </p>
                    <ul className="mt-0.5 space-y-0.5">
                      {app.consumes.map((d) => (
                        <li key={`cons-${d.app}-${d.service}`}>
                          <Mono>
                            {d.app}:{d.service}
                          </Mono>
                        </li>
                      ))}
                    </ul>
                  </div>
                )}
              </div>
            )}
          </section>
        </div>
      )}

      {tab === "connectors" && (
        <AppReachPanel app={app} missingConnectors={missingConnectors} />
      )}

      {tab === "mcp" && <McpToolsPanel app={app} />}

      {tab === "database" && (
        <section>
          {!app.database ? (
            <Empty>
              This app has no scoped database. It stores nothing of its own.
            </Empty>
          ) : schemaLoading ? (
            <Empty>Loading schema…</Empty>
          ) : schemaError ? (
            <p className="mt-1 text-sm text-destructive">
              Could not read the schema: {schemaError}
            </p>
          ) : schema && schema.length > 0 ? (
            <SchemaBrowser tables={schema} />
          ) : (
            <Empty>Scoped database enabled, but no tables exist yet.</Empty>
          )}
        </section>
      )}

      {tab === "settings" && <AppSettingsPanel app={app} />}

      {tab === "remixes" && <AppRemixPanel app={app} />}
    </Dialog>
  );
}
