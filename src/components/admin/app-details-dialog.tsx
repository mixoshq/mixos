/* This Source Code Form is subject to the terms of the Mozilla Public
 * License, v. 2.0. If a copy of the MPL was not distributed with this
 * file, You can obtain one at https://mozilla.org/MPL/2.0/. */

"use client";

import { useEffect, useRef, useState, type ReactNode } from "react";
import Link from "next/link";
import { AlertCircle, Search } from "lucide-react";
import type { AppManifest, EscapeRule } from "@/lib/apps/types";
import { MOS_SOURCE } from "@/lib/apps/types";
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
import {
  renderAuthors,
  formatLastUpdated,
  formatCount,
} from "@/lib/apps/display";
import AppVisibilityPanel from "./app-visibility-panel";
import AppPasswordPanel from "./app-password-panel";

interface MissingConnector {
  name: string;
  displayName: string;
}

type DialogTab =
  "overview" | "access" | "settings" | "wiring" | "connectors" | "mcp" | "database";

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
 * Reach, MCP and Database sit together at the end because they are one
 * question asked three ways: what does this app reach out to (its connectors
 * and the hosts it may call), what does it expose outwards, and what does it
 * keep for itself.
 */
const TABS: Array<{ key: DialogTab; label: string }> = [
  { key: "overview", label: "Overview" },
  { key: "access", label: "Access" },
  { key: "settings", label: "Settings" },
  { key: "wiring", label: "Hooks & Services" },
  { key: "connectors", label: "Reach" },
  { key: "mcp", label: "MCP" },
  { key: "database", label: "Database" },
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
 * The unconfigured-connector warning, worded once and rendered twice.
 *
 * It lives on the registry row and again on this dialog's Overview, for someone
 * who opened it to find out what the strip was about. Same component both
 * places, so the two cannot drift into saying different things.
 *
 * It is a warning, not a gate. It used to block registration; registration is
 * gone, and what an unconfigured connector now blocks is granting the app to a
 * user — enforced in /admin/users, which is where the sentence points.
 */
export function MissingConnectorWarning({
  app,
  missingConnectors,
}: {
  app: AppManifest;
  missingConnectors: MissingConnector[];
}) {
  return (
    <p className="flex items-start gap-2 text-xs text-foreground">
      <AlertCircle className="mt-0.5 h-3.5 w-3.5 shrink-0 text-primary" />
      <span>
        {/* "Activated", not "granted": activation is now the gate this warning
            is actually blocking, and it is the button sitting a few pixels
            below this sentence. Granting was never the first thing stopped —
            an app whose connector is unconfigured cannot serve a request from
            anyone, granted or not. */}
        <span className="font-semibold">{app.name}</span> can&apos;t be
        activated until{" "}
        {missingConnectors.map((m, i) => (
          <span key={m.name}>
            {i > 0 && (i === missingConnectors.length - 1 ? " and " : ", ")}
            <span className="font-semibold">{m.displayName}</span>
          </span>
        ))}{" "}
        {missingConnectors.length === 1 ? "is" : "are"} configured.{" "}
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
  const missingNames = new Set(missingConnectors.map((m) => m.name));
  return (
    <div className="space-y-8">
      <section>
        <SectionHeading>Connectors</SectionHeading>
        {app.connectors.length > 0 ? (
          <>
            {/*
              Every connector is tenant-scoped, so the name is the whole story
              here. This list used to badge some of them "(per-user)"; the
              user-scoped OAuth model that badge described was removed along
              with the generated `userScopedConnectorNames` set it read from.
              See docs/connectors/architecture.md.
            */}
            <ul className="mt-2 space-y-1 text-sm text-muted-foreground">
              {app.connectors.map((name) => (
                <li key={name} className="flex flex-wrap items-center gap-2">
                  <Mono>{name}</Mono>
                  {missingNames.has(name) && (
                    <StatusPill tone="warning">Not configured</StatusPill>
                  )}
                </li>
              ))}
            </ul>
            {missingConnectors.length > 0 && (
              <p className="mt-3 text-xs text-muted-foreground">
                A connector this app requires must hold a working credential
                set before the app can be registered.{" "}
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

export default function AppDetailsDialog({
  app,
  missingConnectors,
  grantCount,
  open,
  onClose,
}: {
  app: AppManifest;
  missingConnectors: MissingConnector[];
  /** Users holding a grant. Meaningless for a global app — see the row. */
  grantCount: number;
  open: boolean;
  onClose: () => void;
}) {
  const [tab, setTab] = useState<DialogTab>("overview");
  const [schema, setSchema] = useState<AppSchemaTable[] | null>(null);
  const [schemaError, setSchemaError] = useState<string | null>(null);
  const [schemaLoading, setSchemaLoading] = useState(false);

  /*
    Fetched on open rather than when the Database tab is reached, because the
    table count is on Overview — and a facts panel that fills in a row several
    seconds after you looked at it is worse than one query per open.

    The in-flight guard is a ref rather than state for the same reason it was in
    the row this replaced: setting it in the effect body is the cascading-render
    pattern React's rule flags, and it only ever existed to stop a second fetch.
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

  const missingNames = new Set(missingConnectors.map((m) => m.name));

  const declaresPassword = (sets: Record<string, string[]> | undefined) =>
    Object.values(sets ?? {}).some((a) => a.includes("password"));
  const hasPasswordRoute =
    declaresPassword(app.pageVisibility) || declaresPassword(app.apiVisibility);

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
      footer={
        <span className="flex flex-wrap justify-center gap-x-10 gap-y-1.5 text-center">
          <span>
            <strong className="font-semibold">Updated</strong>{" "}
            {formatLastUpdated(app.lastUpdated, "Not yet committed")}
          </span>
          {app.authors && app.authors.length > 0 && (
            <span>
              <strong className="font-semibold">By</strong>{" "}
              {renderAuthors(app.authors)}
            </span>
          )}
        </span>
      }
      /*
        Where this app's source lives. The footer already carries provenance —
        when it changed and who changed it — and this is the third question in
        that set: where do I go to change it myself.
      */
      footerAside={
        <code className="font-mono text-xs text-muted-foreground">
          /apps/{app.slug}/
        </code>
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
                    missingNames.has(name) ? (
                      <StatusPill tone="warning">Not configured</StatusPill>
                    ) : (
                      <StatusPill tone="success">Configured</StatusPill>
                    )
                  }
                />
              ))}
              <Row label="MCP tools" value={app.mcp.length} />
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
        <div className="space-y-4">
          <AppVisibilityPanel app={app} />
          {hasPasswordRoute ? (
            <AppPasswordPanel slug={app.slug} appName={app.name} />
          ) : (
            <p className="rounded-md border border-border bg-muted/50 px-3 py-2 text-sm text-foreground">
              No surface of this app is password-gated, so there is no unlock
              password to set. A route opts in by declaring{" "}
              <Mono>password</Mono> as its auth.
            </p>
          )}
        </div>
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

      {tab === "mcp" && (
        <section>
          <SectionHeading>
            MCP tools
            {app.mcp.length ? ` — ${formatCount(app.mcp.length, "tool")}` : ""}
          </SectionHeading>
          {app.mcp.length === 0 ? (
            <Empty>
              This app contributes no MCP tools, so it never appears on the MCP
              consent screen.
            </Empty>
          ) : (
            <>
              <p className="mt-1 text-sm text-muted-foreground">
                Read-only tools this app contributes to the MixOS MCP server. A
                tool is reachable only when the connecting user has authorized
                this app on the consent screen <em>and</em> still holds a grant
                for it.
              </p>
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
                    <p className="font-mono text-sm font-semibold text-foreground">
                      {app.slug}
                      {MCP_NS}
                      {tool.name}
                    </p>
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
                              {/* "ros" is not a connector — it is the marker
                                  for data that exists only in MixOS, and
                                  rendering it as a slug would send an admin
                                  hunting the connector registry for it. */}
                              {s === MOS_SOURCE ? (
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
      )}

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
    </Dialog>
  );
}
