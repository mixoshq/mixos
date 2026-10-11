/* This Source Code Form is subject to the terms of the Mozilla Public
 * License, v. 2.0. If a copy of the MPL was not distributed with this
 * file, You can obtain one at https://mozilla.org/MPL/2.0/. */

import { requireReadOnlySession } from "@/lib/auth/session";
import { requireAdmin } from "@/lib/apps/access";
import {
  getAppInstallCounts,
  getWidgetSetupCounts,
  getAppOpenCounts,
  getTopUsers,
  getOpenTrend,
  getEventCountsForSource,
  getEventTrendForSource,
  getEventTopUsers,
  getConnectorCallersBreakdown,
  getMcpCallCountsByApp,
  type TelemetrySourceType,
  type TopUser,
} from "@/lib/analytics/queries";
import { appRegistry } from "@/generated/app-registry";
import { connectorRegistry } from "@/generated/connector-registry";
import RangeSelector from "@/components/analytics/range-selector";
import OpenTrendChart from "@/components/analytics/open-trend-chart";
import SourceSelector, {
  type SourceOption,
} from "@/components/analytics/source-selector";
import { Card, CardHeader, CardBody } from "@/components/ui/card";

export const dynamic = "force-dynamic";

const VALID_RANGES = new Set([7, 30, 90]);

interface Props {
  searchParams: Promise<{ range?: string; source?: string }>;
}

/**
 * An app is worth selecting when it declares telemetry events OR exposes MCP
 * tools. MCP requests are recorded for every app with an `mcp` block whether or
 * not it opted into telemetry — being read by a model isn't something an app
 * chooses to track — so the selector has to offer those apps too.
 */
function appHasAnalytics(a: (typeof appRegistry)[number]): boolean {
  return a.telemetry.length > 0 || a.mcp.length > 0;
}

/** Apps/connectors with something to show, as selector options. */
const TELEMETRY_APPS: SourceOption[] = appRegistry
  .filter(appHasAnalytics)
  .map((a) => ({ value: `app:${a.slug}`, label: a.name }));
const TELEMETRY_CONNECTORS: SourceOption[] = connectorRegistry
  .filter((c) => c.telemetry.length > 0)
  .map((c) => ({ value: `connector:${c.name}`, label: c.displayName }));

/** True when any app exposes MCP tools — gates the overview's MCP section. */
const ANY_MCP_APPS = appRegistry.some((a) => a.mcp.length > 0);

/** Parse a `source` param into a validated (type, slug) with data to show. */
function parseSource(
  raw: string | undefined,
): { type: TelemetrySourceType; slug: string } | null {
  if (!raw) return null;
  const [type, slug] = raw.split(":");
  if (
    type === "app" &&
    appRegistry.some((a) => a.slug === slug && appHasAnalytics(a))
  ) {
    return { type: "app", slug };
  }
  if (
    type === "connector" &&
    connectorRegistry.some((c) => c.name === slug && c.telemetry.length > 0)
  ) {
    return { type: "connector", slug };
  }
  return null;
}

/** Description of a declared event/method, for the per-source breakdown. */
function eventDescription(
  type: TelemetrySourceType,
  slug: string,
  event: string,
): string | undefined {
  if (type === "mcp") {
    return appRegistry
      .find((a) => a.slug === slug)
      ?.mcp.find((t) => t.name === event)?.description;
  }
  if (type === "app") {
    return appRegistry
      .find((a) => a.slug === slug)
      ?.telemetry.find((t) => t.name === event)?.description;
  }
  return connectorRegistry
    .find((c) => c.name === slug)
    ?.telemetry.find((t) => t.method === event)?.description;
}

/**
 * A horizontal magnitude bar with a direct value label, and an optional
 * description beneath it.
 *
 * The description wraps on its own full-width line rather than sitting beside
 * the label: the label column is fixed-width and truncating, so an inline
 * sublabel got clipped after a few words — which is most of them, since MCP tool
 * descriptions are written for a model and run long.
 */
function Bar({
  label,
  sublabel,
  value,
  max,
}: {
  label: string;
  sublabel?: string;
  value: number;
  max: number;
}) {
  const pct = max > 0 ? Math.max((value / max) * 100, 2) : 0;
  return (
    <div className="py-1.5">
      <div className="flex items-center gap-3">
        <div
          className="w-56 shrink-0 truncate text-sm text-foreground"
          title={label}
        >
          {label}
        </div>
        <div className="h-2.5 flex-1 rounded-full bg-muted">
          <div
            className="h-2.5 rounded-full bg-brand"
            style={{ width: `${pct}%` }}
          />
        </div>
        <div className="w-12 shrink-0 text-right text-sm font-medium tabular-nums text-foreground">
          {value.toLocaleString()}
        </div>
      </div>
      {sublabel && (
        // pr-15 keeps the text clear of the value column so the block reads as
        // one unit rather than running under the number.
        <p className="mt-1 pr-15 text-xs leading-snug text-muted-foreground">
          {sublabel}
        </p>
      )}
    </div>
  );
}

function Section({
  title,
  description,
  children,
}: {
  title: string;
  description?: string;
  children: React.ReactNode;
}) {
  return (
    <Card as="section">
      <CardHeader title={title} description={description} />
      <CardBody>{children}</CardBody>
    </Card>
  );
}

function Empty({ text }: { text: string }) {
  return <p className="text-sm text-muted-foreground">{text}</p>;
}

/** Ranked users table, shared by the overview and per-source telemetry views. */
function UsersTable({
  users,
  countLabel,
}: {
  users: TopUser[];
  countLabel: string;
}) {
  return (
    <table className="w-full text-sm">
      <thead>
        <tr className="border-b border-border text-left text-xs font-semibold uppercase tracking-wider text-muted-foreground">
          <th className="pb-2 pr-2 font-semibold">#</th>
          <th className="pb-2 pr-2 font-semibold">User</th>
          <th className="pb-2 pr-2 text-right font-semibold">{countLabel}</th>
        </tr>
      </thead>
      <tbody>
        {users.map((u, i) => (
          <tr key={u.email || i} className="border-b border-border/50">
            <td className="py-2 pr-2 tabular-nums text-muted-foreground">
              {i + 1}
            </td>
            <td className="py-2 pr-2">
              <div className="font-medium text-foreground">{u.displayName}</div>
              {u.email && (
                <div className="text-xs text-muted-foreground">{u.email}</div>
              )}
            </td>
            <td className="py-2 pr-2 text-right font-medium tabular-nums text-foreground">
              {u.opens.toLocaleString()}
            </td>
          </tr>
        ))}
      </tbody>
    </table>
  );
}

/**
 * MCP detail for one app: which tools a model called, who was asking, and the
 * daily trend.
 *
 * Rendered for any app declaring `mcp`, independent of whether it declares
 * telemetry events — an app doesn't opt into being read by a model, so its
 * operator shouldn't have to opt into seeing it.
 */
async function McpView({ slug, days }: { slug: string; days: number }) {
  const [counts, trend, topUsers] = await Promise.all([
    getEventCountsForSource("mcp", slug, days),
    getEventTrendForSource("mcp", slug, days),
    getEventTopUsers("mcp", slug, days),
  ]);

  const declared = appRegistry.find((a) => a.slug === slug)?.mcp ?? [];
  const maxCount = Math.max(1, ...counts.map((c) => c.count));

  // Show every declared tool, including ones never called — "nobody has ever
  // used this tool" is the more actionable reading than its absence.
  const rows = declared.map((t) => ({
    event: t.name,
    count: counts.find((c) => c.event === t.name)?.count ?? 0,
  }));

  return (
    <>
      <div className="grid gap-6 lg:grid-cols-2">
        <Section
          title="MCP tool calls"
          description={`Requests from connected MCP clients (Claude) per tool, in the last ${days} days.`}
        >
          {rows.length === 0 ? (
            <Empty text="This app declares no MCP tools." />
          ) : (
            rows.map((r) => (
              <Bar
                key={r.event}
                label={r.event}
                sublabel={eventDescription("mcp", slug, r.event)}
                value={r.count}
                max={maxCount}
              />
            ))
          )}
        </Section>

        <Section
          title="Top users via MCP"
          description={`Users whose connected client read this app in the last ${days} days.`}
        >
          {topUsers.length === 0 ? (
            <Empty text="No MCP requests in this range." />
          ) : (
            <UsersTable users={topUsers} countLabel="Requests" />
          )}
        </Section>
      </div>

      <Section
        title="MCP requests over time"
        description={`Daily MCP tool calls over the last ${days} days.`}
      >
        <OpenTrendChart data={trend} noun="request" />
      </Section>
    </>
  );
}

/**
 * Per-source telemetry detail: event/method counts, a daily trend, and — for
 * apps — top users, or — for connectors — a by-calling-app breakdown.
 */
async function TelemetryView({
  type,
  slug,
  days,
}: {
  type: TelemetrySourceType;
  slug: string;
  days: number;
}) {
  const isConnector = type === "connector";
  const noun = isConnector ? "call" : "event";

  const [counts, trend, topUsers, callers] = await Promise.all([
    getEventCountsForSource(type, slug, days),
    getEventTrendForSource(type, slug, days),
    isConnector
      ? Promise.resolve([] as TopUser[])
      : getEventTopUsers(type, slug, days),
    isConnector
      ? getConnectorCallersBreakdown(slug, days)
      : Promise.resolve([]),
  ]);

  const maxCount = Math.max(1, ...counts.map((c) => c.count));
  const maxCalls = Math.max(1, ...callers.map((c) => c.calls));

  return (
    <>
      <Section
        title={isConnector ? "Method calls" : "Events"}
        description={`${isConnector ? "Calls per instrumented method" : "Counts per declared event"} in the last ${days} days.`}
      >
        {counts.length === 0 ? (
          <Empty text={`No ${noun}s recorded in this range.`} />
        ) : (
          counts.map((c) => (
            <Bar
              key={c.event}
              label={c.event}
              sublabel={eventDescription(type, slug, c.event)}
              value={c.count}
              max={maxCount}
            />
          ))
        )}
      </Section>

      <Section
        title={`${isConnector ? "Calls" : "Events"} over time`}
        description={`Daily ${noun}s over the last ${days} days.`}
      >
        <OpenTrendChart data={trend} noun={noun} />
      </Section>

      {isConnector ? (
        <Section
          title="By calling app"
          description={`Which apps drove this connector in the last ${days} days.`}
        >
          {callers.length === 0 ? (
            <Empty text="No calls recorded in this range." />
          ) : (
            callers.map((c) => (
              <Bar
                key={c.slug || c.name}
                label={c.name}
                value={c.calls}
                max={maxCalls}
              />
            ))
          )}
        </Section>
      ) : (
        <Section
          title="Top users"
          description={`Users ranked by events in the last ${days} days.`}
        >
          {topUsers.length === 0 ? (
            <Empty text="No user activity in this range." />
          ) : (
            <UsersTable users={topUsers} countLabel="Events" />
          )}
        </Section>
      )}
    </>
  );
}

function Header({
  description,
  currentSource,
  days,
}: {
  description: string;
  currentSource: string;
  days: number;
}) {
  return (
    <div className="flex flex-col gap-4 lg:flex-row lg:items-start lg:justify-between">
      <div>
        <h1 className="text-2xl font-bold text-foreground">Analytics</h1>
        <p className="mt-1 text-sm text-muted-foreground">{description}</p>
      </div>
      <div className="flex shrink-0 flex-wrap items-center gap-2">
        <SourceSelector
          current={currentSource}
          apps={TELEMETRY_APPS}
          connectors={TELEMETRY_CONNECTORS}
        />
        <RangeSelector current={days} />
      </div>
    </div>
  );
}

export default async function AnalyticsAdminPage({ searchParams }: Props) {
  const session = await requireReadOnlySession();
  await requireAdmin(session);

  const { range, source } = await searchParams;
  const parsed = Number(range);
  const days = VALID_RANGES.has(parsed) ? parsed : 30;
  const selected = parseSource(source);

  // Per-source telemetry view.
  if (selected) {
    const label =
      [...TELEMETRY_APPS, ...TELEMETRY_CONNECTORS].find(
        (o) => o.value === `${selected.type}:${selected.slug}`,
      )?.label ?? selected.slug;
    const manifest =
      selected.type === "app"
        ? appRegistry.find((a) => a.slug === selected.slug)
        : undefined;
    const showTelemetry =
      selected.type !== "app" || !!manifest?.telemetry.length;
    const showMcp = selected.type === "app" && !!manifest?.mcp.length;
    return (
      <div className="space-y-6">
        <Header
          description={
            showMcp && !showTelemetry
              ? `MCP requests for the app “${label}” over the selected range.`
              : showMcp
                ? `Telemetry and MCP requests for the app “${label}” over the selected range.`
                : `Telemetry for the ${selected.type} “${label}” over the selected range.`
          }
          currentSource={`${selected.type}:${selected.slug}`}
          days={days}
        />
        {/* An app with `mcp` but no declared telemetry events would otherwise
            render three empty sections — skip them and show only MCP. */}
        {showTelemetry && (
          <TelemetryView
            type={selected.type}
            slug={selected.slug}
            days={days}
          />
        )}
        {showMcp && <McpView slug={selected.slug} days={days} />}
      </div>
    );
  }

  // Overview (default).
  const [installs, widgets, opens, topUsers, trend, mcpByApp] =
    await Promise.all([
      getAppInstallCounts(),
      getWidgetSetupCounts(),
      getAppOpenCounts(days),
      getTopUsers(days),
      getOpenTrend(days),
      ANY_MCP_APPS ? getMcpCallCountsByApp(days) : Promise.resolve([]),
    ]);

  const maxInstalls = Math.max(1, ...installs.map((r) => r.installs));
  const maxWidgets = Math.max(1, ...widgets.map((r) => r.instances));
  const maxOpens = Math.max(1, ...opens.map((r) => r.opens));

  // Every app exposing tools, with its request count — zeros included, so the
  // list doubles as "what is currently reachable by a model".
  const mcpRows = appRegistry
    .filter((a) => a.mcp.length > 0)
    .map((a) => ({
      slug: a.slug,
      name: a.name,
      tools: a.mcp.length,
      calls: mcpByApp.find((m) => m.slug === a.slug)?.calls ?? 0,
    }))
    .sort((x, y) => y.calls - x.calls || x.name.localeCompare(y.name));
  const maxMcp = Math.max(1, ...mcpRows.map((r) => r.calls));

  return (
    <div className="space-y-6">
      <Header
        description="App and widget usage across the instance. Install and widget counts are live totals; open counts and top users reflect the selected date range. Pick an app or connector above to see its telemetry."
        currentSource=""
        days={days}
      />

      <div className="grid gap-6 lg:grid-cols-2">
        <Section
          title="Most-installed apps"
          description="Number of users who currently have each app installed."
        >
          {installs.length === 0 ? (
            <Empty text="No apps installed yet." />
          ) : (
            installs.map((r) => (
              <Bar
                key={r.slug}
                label={r.name}
                value={r.installs}
                max={maxInstalls}
              />
            ))
          )}
        </Section>

        <Section
          title="Most set-up widgets"
          description="Widget instances placed on dashboards (multiple copies counted separately)."
        >
          {widgets.length === 0 ? (
            <Empty text="No widgets placed yet." />
          ) : (
            widgets.map((r) => (
              <Bar
                key={`${r.slug}:${r.widgetId}`}
                label={r.label}
                sublabel={`${r.users} user${r.users === 1 ? "" : "s"}`}
                value={r.instances}
                max={maxWidgets}
              />
            ))
          )}
        </Section>
      </div>

      <Section
        title="App opens over time"
        description={`Daily app-page opens over the last ${days} days.`}
      >
        <OpenTrendChart data={trend} />
      </Section>

      <div className="grid gap-6 lg:grid-cols-2">
        <Section
          title="Most-opened apps"
          description={`App-page opens in the last ${days} days.`}
        >
          {opens.length === 0 ? (
            <Empty text="No opens recorded in this range." />
          ) : (
            opens.map((r) => (
              <Bar key={r.slug} label={r.name} value={r.opens} max={maxOpens} />
            ))
          )}
        </Section>

        <Section
          title="Top users"
          description={`Users ranked by app opens in the last ${days} days.`}
        >
          {topUsers.length === 0 ? (
            <Empty text="No user activity in this range." />
          ) : (
            <UsersTable users={topUsers} countLabel="Opens" />
          )}
        </Section>
      </div>

      {ANY_MCP_APPS && (
        <Section
          title="MCP requests by app"
          description={`Tool calls from connected MCP clients (Claude) in the last ${days} days. Every app exposing tools is listed, so a zero means reachable but unused. Select an app above for its per-tool breakdown.`}
        >
          {mcpRows.map((r) => (
            <Bar
              key={r.slug}
              label={r.name}
              sublabel={`${r.tools} tool${r.tools === 1 ? "" : "s"}`}
              value={r.calls}
              max={maxMcp}
            />
          ))}
        </Section>
      )}
    </div>
  );
}
