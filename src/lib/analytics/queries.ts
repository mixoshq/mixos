import { sql } from "@/lib/db/client";
import { appRegistry } from "@/generated/app-registry";

/**
 * Aggregation queries backing the admin Analytics page.
 *
 * These use the raw postgres.js client (`sql`) rather than the Supabase-style
 * shim (`createServiceClient`) because the shim does not support GROUP BY /
 * COUNT / aggregates. Everything here is admin-gated by the caller.
 *
 * Note on data completeness:
 * - Install and widget counts are LIVE SNAPSHOTS of current state (all-time).
 * - App-open and top-user metrics only reflect events recorded since the
 *   analytics beacon shipped — there is no historical backfill.
 */

/** Resolve an app slug to its display name, falling back to the slug itself. */
function appName(slug: string): string {
  return appRegistry.find((a) => a.slug === slug)?.name ?? slug;
}

/** Resolve "<App> — <Widget>" for a (slug, widgetId) pair. */
function widgetLabel(slug: string, widgetId: string): string {
  const app = appRegistry.find((a) => a.slug === slug);
  const widget = app?.widgets.find((w) => w.id === widgetId);
  const appLabel = app?.name ?? slug;
  const wLabel = widget?.name ?? widgetId;
  return `${appLabel} — ${wLabel}`;
}

export interface AppInstallCount {
  slug: string;
  name: string;
  installs: number;
}

/** How many users have each app installed (live snapshot from user_apps). */
export async function getAppInstallCounts(): Promise<AppInstallCount[]> {
  const rows = await sql<{ app_slug: string; installs: string }[]>`
    select app_slug, count(*)::int as installs
    from public.user_apps
    group by app_slug
    order by installs desc, app_slug asc
  `;
  return rows.map((r) => ({
    slug: r.app_slug,
    name: appName(r.app_slug),
    installs: Number(r.installs),
  }));
}

export interface WidgetSetupCount {
  slug: string;
  widgetId: string;
  label: string;
  instances: number;
  users: number;
}

/**
 * How many times each widget is placed on dashboards (live snapshot). Counts
 * every instance, so multiple copies of the same widget count separately, and
 * also reports how many distinct users have at least one.
 */
export async function getWidgetSetupCounts(): Promise<WidgetSetupCount[]> {
  const rows = await sql<
    { app_slug: string; widget_id: string; instances: string; users: string }[]
  >`
    select app_slug, widget_id,
           count(*)::int as instances,
           count(distinct user_id)::int as users
    from public.dashboard_widgets
    group by app_slug, widget_id
    order by instances desc, app_slug asc, widget_id asc
  `;
  return rows.map((r) => ({
    slug: r.app_slug,
    widgetId: r.widget_id,
    label: widgetLabel(r.app_slug, r.widget_id),
    instances: Number(r.instances),
    users: Number(r.users),
  }));
}

export interface AppOpenCount {
  slug: string;
  name: string;
  opens: number;
}

/** Opens per app within the last `sinceDays` days. */
export async function getAppOpenCounts(
  sinceDays: number,
): Promise<AppOpenCount[]> {
  const rows = await sql<{ app_slug: string; opens: string }[]>`
    select app_slug, count(*)::int as opens
    from public.app_open_events
    where created_at >= now() - ${sinceDays} * interval '1 day'
    group by app_slug
    order by opens desc, app_slug asc
  `;
  return rows.map((r) => ({
    slug: r.app_slug,
    name: appName(r.app_slug),
    opens: Number(r.opens),
  }));
}

export interface TopUser {
  displayName: string;
  email: string;
  opens: number;
}

/** Users ranked by total app opens within the last `sinceDays` days. */
export async function getTopUsers(
  sinceDays: number,
  limit = 20,
): Promise<TopUser[]> {
  const rows = await sql<
    { display_name: string | null; email: string | null; opens: string }[]
  >`
    select u.display_name, u.email, count(*)::int as opens
    from public.app_open_events e
    join public.users u on u.id = e.user_id
    where e.created_at >= now() - ${sinceDays} * interval '1 day'
    group by u.id, u.display_name, u.email
    order by opens desc, u.display_name asc
    limit ${limit}
  `;
  return rows.map((r) => ({
    displayName: r.display_name ?? r.email ?? "Unknown",
    email: r.email ?? "",
    opens: Number(r.opens),
  }));
}

export interface OpenTrendPoint {
  /** ISO date (yyyy-mm-dd) for the day bucket. */
  day: string;
  opens: number;
}

/** Daily open counts across the last `sinceDays` days, zero-filled per day. */
export async function getOpenTrend(sinceDays: number): Promise<OpenTrendPoint[]> {
  const rows = await sql<{ day: string; opens: string }[]>`
    select to_char(date_trunc('day', gs), 'YYYY-MM-DD') as day,
           count(e.id)::int as opens
    from generate_series(
      date_trunc('day', now()) - ${sinceDays - 1} * interval '1 day',
      date_trunc('day', now()),
      interval '1 day'
    ) as gs
    left join public.app_open_events e
      on date_trunc('day', e.created_at) = gs
    group by gs
    order by gs asc
  `;
  return rows.map((r) => ({ day: r.day, opens: Number(r.opens) }));
}

// ============================================================
// Telemetry — per-source (app/connector) usage events. Backs the Analytics
// page's source-selector view. See docs/apps/telemetry.md.
// ============================================================

/**
 * `mcp` rows are written by the MCP broker for every tool call, keyed by the
 * app that owns the tool. Unlike `app` rows they aren't opt-in — an app doesn't
 * choose to be called by a model — so any app declaring `mcp` gets these for
 * free. See `recordMcpCall` in src/lib/apps/telemetry.ts.
 *
 * `route` rows are written by the gateway for every app API request, on the same
 * no-opt-in argument, with `event_name` set to the route PATTERN
 * (`GET /items/[id]`) so the key space stays finite. They are pruned on a
 * retention window; the other sources are not.
 *
 * Note `service` is written by the App Services broker but is deliberately
 * absent here — those rows have no admin view, which is exactly the outcome to
 * avoid for `route`.
 */
export type TelemetrySourceType = "app" | "connector" | "mcp" | "route";

export interface EventCount {
  event: string;
  count: number;
}

/** Counts per declared event/method for one source, within `sinceDays`. */
export async function getEventCountsForSource(
  sourceType: TelemetrySourceType,
  sourceSlug: string,
  sinceDays: number,
): Promise<EventCount[]> {
  const rows = await sql<{ event_name: string; count: string }[]>`
    select event_name, count(*)::int as count
    from public.telemetry_events
    where source_type = ${sourceType}
      and source_slug = ${sourceSlug}
      and created_at >= now() - ${sinceDays} * interval '1 day'
    group by event_name
    order by count desc, event_name asc
  `;
  return rows.map((r) => ({ event: r.event_name, count: Number(r.count) }));
}

/** Daily event counts for one source, zero-filled per day. Reuses OpenTrendPoint. */
export async function getEventTrendForSource(
  sourceType: TelemetrySourceType,
  sourceSlug: string,
  sinceDays: number,
): Promise<OpenTrendPoint[]> {
  const rows = await sql<{ day: string; opens: string }[]>`
    select to_char(date_trunc('day', gs), 'YYYY-MM-DD') as day,
           count(e.id)::int as opens
    from generate_series(
      date_trunc('day', now()) - ${sinceDays - 1} * interval '1 day',
      date_trunc('day', now()),
      interval '1 day'
    ) as gs
    left join public.telemetry_events e
      on date_trunc('day', e.created_at) = gs
     and e.source_type = ${sourceType}
     and e.source_slug = ${sourceSlug}
    group by gs
    order by gs asc
  `;
  return rows.map((r) => ({ day: r.day, opens: Number(r.opens) }));
}

/** Users ranked by event count for one source, within `sinceDays`. */
export async function getEventTopUsers(
  sourceType: TelemetrySourceType,
  sourceSlug: string,
  sinceDays: number,
  limit = 20,
): Promise<TopUser[]> {
  const rows = await sql<
    { display_name: string | null; email: string | null; opens: string }[]
  >`
    select u.display_name, u.email, count(*)::int as opens
    from public.telemetry_events e
    join public.users u on u.id = e.user_id
    where e.source_type = ${sourceType}
      and e.source_slug = ${sourceSlug}
      and e.created_at >= now() - ${sinceDays} * interval '1 day'
    group by u.id, u.display_name, u.email
    order by opens desc, u.display_name asc
    limit ${limit}
  `;
  return rows.map((r) => ({
    displayName: r.display_name ?? r.email ?? "Unknown",
    email: r.email ?? "",
    opens: Number(r.opens),
  }));
}

export interface ConnectorCallerCount {
  slug: string;
  name: string;
  calls: number;
}

/** For a connector, how many calls each app drove, within `sinceDays`. */
export async function getConnectorCallersBreakdown(
  connectorSlug: string,
  sinceDays: number,
): Promise<ConnectorCallerCount[]> {
  const rows = await sql<{ caller_app_slug: string | null; calls: string }[]>`
    select caller_app_slug, count(*)::int as calls
    from public.telemetry_events
    where source_type = 'connector'
      and source_slug = ${connectorSlug}
      and created_at >= now() - ${sinceDays} * interval '1 day'
    group by caller_app_slug
    order by calls desc, caller_app_slug asc
  `;
  return rows.map((r) => ({
    slug: r.caller_app_slug ?? "",
    name: r.caller_app_slug ? appName(r.caller_app_slug) : "Unknown app",
    calls: Number(r.calls),
  }));
}

// ── MCP ─────────────────────────────────────────────────────────────────────
//
// Every MCP tool call writes a telemetry row with `source_type = 'mcp'`,
// `source_slug` = the owning app, `event_name` = the tool, and the OAuth client
// id in `caller_app_slug`. These are recorded unconditionally for any app that
// declares `mcp` — being read by a model is not something an app opts into
// tracking, and an operator needs to be able to see it.

export interface McpAppCount {
  slug: string;
  name: string;
  calls: number;
}

/** MCP tool calls per app, within `sinceDays`. Drives the overview breakdown. */
export async function getMcpCallCountsByApp(
  sinceDays: number,
): Promise<McpAppCount[]> {
  const rows = await sql<{ source_slug: string; calls: string }[]>`
    select source_slug, count(*)::int as calls
    from public.telemetry_events
    where source_type = 'mcp'
      and created_at >= now() - ${sinceDays} * interval '1 day'
    group by source_slug
    order by calls desc, source_slug asc
  `;
  return rows.map((r) => ({
    slug: r.source_slug,
    name: appName(r.source_slug),
    calls: Number(r.calls),
  }));
}

// Note: the OAuth client id is still recorded on every MCP row
// (`caller_app_slug`), so a per-client breakdown can be added later without a
// schema change. The Analytics view deliberately doesn't show one — which
// *person* is reading an app is the useful question; which of their clients did
// it is noise, and client ids churn as users reconnect.
