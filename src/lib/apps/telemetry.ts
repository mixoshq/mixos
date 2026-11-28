/* This Source Code Form is subject to the terms of the Mozilla Public
 * License, v. 2.0. If a copy of the MPL was not distributed with this
 * file, You can obtain one at https://mozilla.org/MPL/2.0/. */

import { sql } from "@/lib/db/client";
import type { BaseConnector } from "@/lib/connectors/types";
import { connectorTelemetryCutoff, connectorTelemetryRetention } from "./telemetry-retention";

/**
 * Telemetry — first-party usage tracking for apps and connectors.
 *
 * Apps get a `context.telemetry` client (below) and call `track()` explicitly.
 * Connectors record nothing themselves: the platform wraps declared methods on
 * the `context.connectors.<name>` proxy (see `instrumentConnector`) so a call
 * is recorded without the connector class importing anything. Both write to the
 * shared `public.telemetry_events` table. Every write is best-effort — a
 * failure never surfaces to or blocks the caller.
 *
 * See `docs/apps/telemetry.md` and `docs/connectors/telemetry.md`.
 */

export interface TelemetryClient {
  /**
   * Record a key-usage event. `eventName` must be one of the events declared in
   * the app's `app.json` `telemetry` list — an undeclared name is dropped.
   * `properties` is an optional low-cardinality dimensions bag (no PII/secrets).
   */
  track(eventName: string, properties?: Record<string, unknown>): Promise<void>;
}

/**
 * Per-app telemetry client, injected as `context.telemetry` when an app
 * declares one or more `telemetry` events. Scoped to the app slug, so an app
 * can only write its own events. Mirrors `createNotificationsClient`.
 */
export function createTelemetryClient(
  appSlug: string,
  opts: { declaredEvents: Set<string>; userId: string | null },
): TelemetryClient {
  const { declaredEvents, userId } = opts;
  return {
    async track(eventName, properties) {
      // Undeclared names are dropped — declaration is the manifest's contract.
      if (!declaredEvents.has(eventName)) return;
      try {
        await sql`
          insert into public.telemetry_events
            (source_type, source_slug, event_name, user_id, properties)
          values ('app', ${appSlug}, ${eventName}, ${userId}, ${sql.json(
            (properties ?? {}) as Parameters<typeof sql.json>[0],
          )})
        `;
      } catch {
        // Telemetry is non-critical — swallow write failures.
      }
    },
  };
}

/**
 * Record one connector-usage event. Called only by `instrumentConnector` —
 * connectors never call this directly. Captures which connector method ran and
 * which app drove the call (`callerAppSlug`). Best-effort.
 */
export async function recordConnectorEvent(opts: {
  connectorSlug: string;
  method: string;
  callerAppSlug: string;
  userId: string | null;
  /**
   * How the call settled. Omitted only if a caller cannot tell. `refused` is
   * a call the platform stopped before the connector ran it (./detection.ts).
   */
  outcome?: "ok" | "error" | "refused";
  /**
   * ConnectorError category on failure — "denied" vs "throttled" vs "timed
   * out" — or, for a refusal, why: `undeclared`, `write-not-asked`,
   * `write-not-allowed`, `narrowed`, `budget` or `disabled`.
   */
  errorCategory?: string | null;
}): Promise<void> {
  try {
    await sql`
      insert into public.telemetry_events
        (source_type, source_slug, caller_app_slug, event_name, user_id, outcome, error_category)
      values (
        'connector', ${opts.connectorSlug}, ${opts.callerAppSlug}, ${opts.method},
        ${opts.userId}, ${opts.outcome ?? null}, ${opts.errorCategory ?? null}
      )
    `;
  } catch {
    // best-effort
  }
}

/**
 * Record one cross-app service call (App Services broker). Captures which
 * provider service ran and which app requested it (`callerAppSlug`). Best-effort
 * — attribution never blocks or fails the request.
 */
export async function recordServiceCall(opts: {
  providerSlug: string;
  serviceName: string;
  callerAppSlug: string;
  userId: string | null;
}): Promise<void> {
  try {
    await sql`
      insert into public.telemetry_events
        (source_type, source_slug, caller_app_slug, event_name, user_id)
      values ('service', ${opts.providerSlug}, ${opts.callerAppSlug}, ${opts.serviceName}, ${opts.userId})
    `;
  } catch {
    // best-effort
  }
}

/**
 * Record one MCP tool call. Captures which app's tool ran and which registered
 * MCP client drove it (in `caller_app_slug`, reusing that column as "who asked"
 * — an OAuth client id rather than an app slug, distinguishable by the
 * `source_type = 'mcp'` discriminator). Best-effort.
 *
 * Unlike app telemetry, MCP calls are recorded whether or not the app declares
 * any `telemetry` events: the app didn't choose to be called, and an operator
 * needs to be able to see what a model has been reading.
 */
export async function recordMcpCall(opts: {
  appSlug: string;
  toolName: string;
  clientId: string;
  userId: string;
}): Promise<void> {
  try {
    await sql`
      insert into public.telemetry_events
        (source_type, source_slug, caller_app_slug, event_name, user_id)
      values ('mcp', ${opts.appSlug}, ${opts.clientId}, ${opts.toolName}, ${opts.userId})
    `;
  } catch {
    // best-effort
  }
}

/**
 * Record one app API route call. Best-effort, like every other recorder here.
 *
 * Auto-recorded, no declaration required — the same argument `recordMcpCall`
 * makes: an app does not choose to be called, and an operator needs to see what
 * its surface is actually doing.
 *
 * TWO THINGS THIS GETS RIGHT ON PURPOSE.
 *
 * `event_name` is the route's on-disk PATTERN (`GET /items/[id]`), never the URL
 * (`GET /items/42`). The admin Analytics page does `group by event_name`, so the
 * key space has to be finite — and it is: exactly the app's declared route set,
 * known at build time. Path VALUES are caller-controlled and, on the public
 * mount, reachable without a session, so grouping on them would let anyone mint
 * unlimited distinct event names and make the Analytics page unrenderable.
 *
 * Unlike the other platform recorders this one fires AFTER the work, because
 * the whole point is the outcome — status, duration, and which budget (if any)
 * the route blew. Those are recorded as a measure and a small enumeration
 * respectively; a raw millisecond value is never a grouping key.
 */
export async function recordRouteCall(opts: {
  appSlug: string;
  /** `GET /items/[id]` — method plus the on-disk pattern. Never URL values. */
  eventName: string;
  userId: string | null;
  /** Which auth tier the caller resolved to. */
  tier: string;
  status: number;
  durationMs: number;
  /** `"timeout"` | `"connector-budget"` when a budget was exceeded. */
  overBudget?: "timeout" | "connector-budget";
}): Promise<void> {
  try {
    await sql`
      insert into public.telemetry_events
        (source_type, source_slug, event_name, user_id, properties)
      values (
        'route',
        ${opts.appSlug},
        ${opts.eventName},
        ${opts.userId},
        ${sql.json({
          tier: opts.tier,
          status: opts.status,
          ms: opts.durationMs,
          ...(opts.overBudget ? { over_budget: opts.overBudget } : {}),
        } as Parameters<typeof sql.json>[0])}
      )
    `;
  } catch (err) {
    // Best-effort like its siblings — but NOT silent. Every other recorder has
    // an empty catch, which is why a CHECK-constraint violation on a new
    // source_type would have been invisible forever. One warn is worth it.
    console.warn("[telemetry] route call not recorded:", err);
  }
}

/** Why the platform refused a connector call, as the refused row records it. */
export type ConnectorRefusal =
  | "undeclared"
  | "write-not-asked"
  | "write-not-allowed"
  | "narrowed"
  | "budget"
  | "disabled";

/**
 * Record a connector call the platform refused before the connector ran it,
 * for detection (./detection.ts): a refusal is the clearest sign of an app
 * reaching for what it wasn't given. Fire-and-forget, and never throws.
 */
export function recordRefusedConnectorCall(opts: {
  connectorSlug: string;
  method: string;
  callerAppSlug: string;
  userId: string | null;
  reason: ConnectorRefusal;
}): void {
  void recordConnectorEvent({
    connectorSlug: opts.connectorSlug,
    method: opts.method,
    callerAppSlug: opts.callerAppSlug,
    userId: opts.userId,
    outcome: "refused",
    errorCategory: opts.reason,
  });
}

/** Why `context.http` refused a hop, as its egress row records it. */
export type EgressRefusal = "host" | "scheme" | "address";

/**
 * Record one `context.http` hop: the host, the app, and how it went (ok, an
 * error, or refused before any connection, with why). One row per hop, so a
 * redirect to somewhere else is its own row. Fire-and-forget, and never
 * throws: a telemetry failure must not fail the request.
 */
export function recordEgressEvent(opts: {
  appSlug: string;
  host: string;
  userId: string | null;
  outcome: "ok" | "error" | "refused";
  /** For a refusal, why; for an error, a short category. */
  category?: string | null;
  /** The HTTP status, for an answered hop. */
  status?: number | null;
}): void {
  void (async () => {
    try {
      await sql`
        insert into public.telemetry_events
          (source_type, source_slug, caller_app_slug, event_name, user_id, outcome, error_category, properties)
        values (
          'egress', ${opts.host.toLowerCase()}, ${opts.appSlug}, 'request', ${opts.userId},
          ${opts.outcome}, ${opts.category ?? null},
          ${sql.json(opts.status != null ? { status: opts.status } : {})}
        )
      `;
    } catch {
      // best-effort
    }
  })();
}

/** Drop egress rows past 90 days: the one source Item 6 adds, and bounds. */
export async function pruneEgressTelemetry(retentionDays = 90): Promise<number> {
  try {
    const result = (await sql`
      delete from public.telemetry_events
      where source_type = 'egress'
        and created_at < now() - ${retentionDays} * interval '1 day'
    `) as unknown as { count: number };
    return result.count ?? 0;
  } catch (err) {
    console.warn("[telemetry] egress telemetry prune failed:", err);
    return 0;
  }
}

/** Rows deleted in one statement, and statements in one tick, by pruneConnectorTelemetry. */
export const CONNECTOR_PRUNE = { batch: 10_000, maxBatches: 20 } as const;

/**
 * Drop connector rows older than MIXOS_CONNECTOR_TELEMETRY_DAYS
 * (./telemetry-retention.ts): 90 days unless set, and none at all for 0.
 * Called from the cron tick.
 *
 * A batch at a time, up to CONNECTOR_PRUNE.maxBatches a tick. Connector rows
 * were kept forever until 28 November 2026, so the first sweep on an instance
 * that has run a while can be millions of rows. Spread over ticks, it holds
 * none of them up. Scoped to `source_type = 'connector'`, as the route and
 * egress prunes are to theirs.
 */
export async function pruneConnectorTelemetry(
  days: number | null = connectorTelemetryRetention().days,
  opts: { batch?: number; maxBatches?: number; now?: number } = {},
): Promise<number> {
  const before = connectorTelemetryCutoff(days, opts.now);
  if (!before) return 0;
  const batch = opts.batch ?? CONNECTOR_PRUNE.batch;
  const maxBatches = opts.maxBatches ?? CONNECTOR_PRUNE.maxBatches;
  let deleted = 0;
  try {
    for (let i = 0; i < maxBatches; i++) {
      const result = (await sql`
        delete from public.telemetry_events
        where id in (
          select id from public.telemetry_events
          where source_type = 'connector' and created_at < ${before}
          limit ${batch}
        )
      `) as unknown as { count: number };
      const count = result.count ?? 0;
      deleted += count;
      if (count < batch) break;
    }
  } catch (err) {
    console.warn("[telemetry] connector telemetry prune failed:", err);
  }
  return deleted;
}

/**
 * Drop route rows older than the retention window. Called from the cron tick.
 *
 * Route telemetry is one row per request, orders of magnitude more than every
 * other source combined, and nothing else sweeps this table. Scoped to
 * `source_type = 'route'` on purpose: an operator may well want a declared app
 * event or an MCP call kept far longer than a request log, and this function has
 * no business deciding that for them.
 */
export async function pruneRouteTelemetry(retentionDays = 30): Promise<number> {
  try {
    // No RETURNING: postgres.js buffers one JS object per returned row, so a
    // large first sweep allocated ~90 MB of heap per million rows purely to
    // count them. `count` off the command tag is free.
    const result = (await sql`
      delete from public.telemetry_events
      where source_type = 'route'
        and created_at < now() - ${retentionDays} * interval '1 day'
    `) as unknown as { count: number };
    return result.count ?? 0;
  } catch (err) {
    console.warn("[telemetry] route telemetry prune failed:", err);
    return 0;
  }
}

/**
 * Wrap a connector instance so that calls to its *declared* methods record a
 * telemetry event. Returns the instance untouched when nothing is declared.
 *
 * The wrapper invokes the real method against the real instance (so private
 * fields keep working) and records the call fire-and-forget: telemetry never
 * blocks or fails a connector call, and only ever sees the method name — never
 * arguments, results, or credentials. Non-method access (e.g. the `configured`
 * getter) passes straight through.
 */
/** ConnectorError carries a `category`; anything else is an unclassified fault. */
function categoryOf(err: unknown): string | null {
  const category = (err as { category?: unknown } | null)?.category;
  return typeof category === "string" ? category : null;
}

export function instrumentConnector<T extends BaseConnector>(
  instance: T,
  opts: {
    connectorSlug: string;
    methods: Set<string>;
    callerAppSlug: string;
    userId: string | null;
  },
): T {
  if (opts.methods.size === 0) return instance;
  return new Proxy(instance, {
    get(target, prop, receiver) {
      const value = Reflect.get(target, prop, receiver);
      if (
        typeof prop === "string" &&
        opts.methods.has(prop) &&
        typeof value === "function"
      ) {
        return (...args: unknown[]) => {
          const record = (
            outcome: "ok" | "error",
            errorCategory?: string | null,
          ) =>
            void recordConnectorEvent({
              connectorSlug: opts.connectorSlug,
              method: prop,
              callerAppSlug: opts.callerAppSlug,
              userId: opts.userId,
              outcome,
              errorCategory,
            });

          /*
            Recorded when the call SETTLES, not when it starts.

            Written up front, the event would be a record of "someone tried" —
            enough to attribute usage, useless for answering "does this
            connector actually have the access it claims". The tradeoff is real
            and deliberate: a call that never settles records nothing.

            The category comes off ConnectorError rather than off an HTTP
            status, which is what keeps "denied" separate from "throttled" — a
            403 means either, depending on the provider (see `rateLimitOn403`).
          */
          let result: unknown;
          try {
            result = (value as (...a: unknown[]) => unknown).apply(target, args);
          } catch (err) {
            record("error", categoryOf(err));
            throw err;
          }

          if (result instanceof Promise) {
            return result.then(
              (v) => {
                record("ok");
                return v;
              },
              (err) => {
                record("error", categoryOf(err));
                throw err;
              },
            );
          }
          record("ok");
          return result;
        };
      }
      return value;
    },
  }) as T;
}
