/* This Source Code Form is subject to the terms of the Mozilla Public
 * License, v. 2.0. If a copy of the MPL was not distributed with this
 * file, You can obtain one at https://mozilla.org/MPL/2.0/. */

import { appRegistry } from "@/generated/app-registry";
import { connectorRegistry } from "@/generated/connector-registry";
import { sql } from "@/lib/db/client";
import { recordAdminAction, type AdminActor } from "@/lib/apps/admin-audit";
import { SCHEDULER_ACTOR } from "@/lib/apps/audit-actors";
import { connectorWritableKey } from "@/lib/connectors/switch-keys";
import {
  DENIABLE,
  addedCapabilities,
  appCapabilities,
  capabilityKey,
  type Capability,
  type CapabilityKind,
} from "./capabilities";
import { getApprovedKeys, replaceApproved } from "./capability-store";

export { getApprovedKeys, replaceApproved };

/**
 * Approving capabilities, not just apps (supabase/migrations/0009_capability_approvals.sql).
 *
 *   - **Approved set.** What an admin approved an app to ask for: the whole
 *     set its manifest asks for when they activate it, or approve what it
 *     newly asks for. The release step compares each build with it
 *     (scripts/sync-capabilities.ts), and growth means re-approval.
 *   - **Denials.** Capabilities an admin turned off while the app runs, only
 *     of the kinds it already handles the absence of (`DENIABLE`). Read once
 *     per context build (src/lib/apps/context.ts).
 *   - **Expiry.** An app's write access to a connector it hasn't written
 *     through in 90 days is taken away, as 7a's "Can't change data", by the
 *     cron tick.
 */

/** The current manifest's capabilities, or none for an app this build lacks. */
export function currentCapabilities(slug: string): Capability[] {
  const app = appRegistry.find((a) => a.slug === slug);
  return app ? appCapabilities(app) : [];
}

/** Record activation as approval of everything it asks for now (src/lib/apps/access.ts). */
export async function approveOnActivation(slug: string, by: string | null): Promise<void> {
  await replaceApproved(sql, slug, currentCapabilities(slug), by);
}

/**
 * An admin approving what an app newly asks for. Audited as
 * `app.capabilities.approve`, with what was added. Activating a Registry app
 * that was switched off for it is a separate act, which approves it too.
 */
export async function approveCapabilities(actor: AdminActor, slug: string): Promise<Capability[]> {
  const caps = currentCapabilities(slug);
  const added = addedCapabilities(caps, await getApprovedKeys(sql, slug));
  await replaceApproved(sql, slug, caps, actor.id);
  await recordAdminAction(actor, {
    action: "app.capabilities.approve",
    targetType: "app",
    targetId: slug,
    details: { added: added.map(capabilityKey) },
  });
  return added;
}

/** What the admin pages show about an app's capabilities. */
export interface CapabilityStatus {
  /** What it asks for that isn't approved. */
  added: Capability[];
  /** When the release step flagged it. */
  pendingSince: string | null;
  /** The deniable ones it asks for, each with whether an admin turned it off. */
  deniable: Array<Capability & { denied: boolean }>;
}

/** Each app's capability status, by slug. Empty when unreadable: a view. */
export async function getCapabilityStatus(slugs: readonly string[]): Promise<Record<string, CapabilityStatus>> {
  const out: Record<string, CapabilityStatus> = {};
  try {
    const approved = await sql<{ app_slug: string; kind: string; capability: string }[]>`
      select app_slug, kind, capability from public.app_capability_approvals where app_slug = any(${[...slugs]}::text[])
    `;
    const denied = await sql<{ app_slug: string; kind: string; capability: string }[]>`
      select app_slug, kind, capability from public.app_capability_denials where app_slug = any(${[...slugs]}::text[])
    `;
    const flags = await sql<{ slug: string; capabilities_pending_since: Date | null }[]>`
      select slug, capabilities_pending_since from public.apps where slug = any(${[...slugs]}::text[])
    `;
    for (const slug of slugs) {
      const caps = currentCapabilities(slug);
      const mine = new Set(approved.filter((r) => r.app_slug === slug).map((r) => `${r.kind}:${r.capability}`));
      const off = new Set(denied.filter((r) => r.app_slug === slug).map((r) => `${r.kind}:${r.capability}`));
      const since = flags.find((f) => f.slug === slug)?.capabilities_pending_since ?? null;
      out[slug] = {
        // An app with no approvals at all hasn't been activated or seen by a
        // release step yet: nothing to call "more".
        added: mine.size === 0 ? [] : addedCapabilities(caps, mine),
        pendingSince: since ? since.toISOString() : null,
        deniable: caps.filter((c) => DENIABLE.has(c.kind)).map((c) => ({ ...c, denied: off.has(capabilityKey(c)) })),
      };
    }
  } catch (err) {
    console.error("[capabilities] could not read approvals:", err);
  }
  return out;
}

/** The capabilities an admin turned off for one app, as keys. Throws when unreadable. */
export async function getDeniedKeys(slug: string): Promise<Set<string>> {
  const rows = await sql<{ kind: string; capability: string }[]>`
    select kind, capability from public.app_capability_denials where app_slug = ${slug}
  `;
  return new Set(rows.map((r) => `${r.kind}:${r.capability}`));
}

/** Why a capability can't be turned off. */
export class CapabilityError extends Error {
  constructor(message: string) {
    super(message);
    this.name = "CapabilityError";
  }
}

/**
 * Turn one of an app's deniable capabilities off, or back on. Audited as
 * `app.capability.deny` or `app.capability.allow`.
 */
export async function setCapabilityDenied(
  actor: AdminActor,
  slug: string,
  kind: CapabilityKind,
  capability: string,
  denied: boolean,
): Promise<void> {
  if (!DENIABLE.has(kind)) {
    throw new CapabilityError("The app can't run without this, so it is approved with the app, not turned off on its own.");
  }
  if (!currentCapabilities(slug).some((c) => c.kind === kind && c.capability === capability)) {
    throw new CapabilityError(`${slug} doesn't ask for that.`);
  }
  if (denied) {
    await sql`
      insert into public.app_capability_denials (app_slug, kind, capability, denied_by)
      values (${slug}, ${kind}, ${capability}, ${actor.id})
      on conflict (app_slug, kind, capability) do nothing
    `;
  } else {
    await sql`
      delete from public.app_capability_denials where app_slug = ${slug} and kind = ${kind} and capability = ${capability}
    `;
  }
  await recordAdminAction(actor, {
    action: denied ? "app.capability.deny" : "app.capability.allow",
    targetType: "app",
    targetId: slug,
    details: { kind, capability },
  });
}

/** How long a write access goes unused before it expires. */
export const WRITE_EXPIRY_DAYS = 90;

/** What the cron tick took away: an app's write access to a connector. */
export interface ExpiredWrite {
  app: string;
  connector: string;
}

/**
 * Take away write access an app hasn't used. For each active app approved,
 * more than 90 days ago, to change data through a connector that may change
 * data, with no successful call to a write method of it in those 90 days and
 * no limit already taking its writes away: set 7a's "Can't change data"
 * (connector_app_access, with expired_at), and audit `app.capability.expired`.
 * Turning it back on is "Remove its limits" in the connector's Reach section.
 */
export async function expireUnusedWrites(now: Date = new Date()): Promise<ExpiredWrite[]> {
  const cutoff = new Date(now.getTime() - WRITE_EXPIRY_DAYS * 86_400_000);
  const candidates = await sql<{ app_slug: string; connector: string }[]>`
    select ap.app_slug, ap.capability as connector
      from public.app_capability_approvals ap
      join public.apps a on a.slug = ap.app_slug and a.is_active
     where ap.kind = 'connector-write'
       and ap.approved_at < ${cutoff}
       and exists (
         select 1 from public.platform_settings s where s.key = 'connector.writable.' || ap.capability
       )
       and not exists (
         select 1 from public.connector_app_access x
          where x.app_slug = ap.app_slug and x.connector_name = ap.capability and x.writes = 'deny'
       )
  `;
  const expired: ExpiredWrite[] = [];
  for (const c of candidates) {
    // The writable key's name is the switch's, by construction; checked again here.
    if (`connector.writable.${c.connector}` !== connectorWritableKey(c.connector)) continue;
    const writes = (connectorRegistry.find((r) => r.name === c.connector)?.telemetry ?? [])
      .filter((t) => t.mutates)
      .map((t) => t.method);
    if (writes.length === 0) continue;
    const used = await sql`
      select 1 from public.telemetry_events
       where source_type = 'connector' and source_slug = ${c.connector} and caller_app_slug = ${c.app_slug}
         and outcome = 'ok' and event_name = any(${writes}::text[]) and created_at > ${cutoff}
       limit 1
    `;
    if (used.length > 0) continue;
    await sql`
      insert into public.connector_app_access (connector_name, app_slug, writes, methods, expired_at)
      values (${c.connector}, ${c.app_slug}, 'deny', null, ${now})
      on conflict (connector_name, app_slug) do update set writes = 'deny', expired_at = ${now}, set_at = now()
    `;
    await recordAdminAction(
      { id: null, email: SCHEDULER_ACTOR },
      {
        action: "app.capability.expired",
        targetType: "app",
        targetId: c.app_slug,
        details: { connector: c.connector, unusedDays: WRITE_EXPIRY_DAYS },
      },
    );
    expired.push({ app: c.app_slug, connector: c.connector });
  }
  return expired;
}

/** Write access the cron tick took away, for a notice. Empty when unreadable. */
export async function getExpiredWrites(): Promise<Array<ExpiredWrite & { at: string }>> {
  try {
    const rows = await sql<{ app_slug: string; connector_name: string; expired_at: Date }[]>`
      select app_slug, connector_name, expired_at from public.connector_app_access
       where expired_at is not null and writes = 'deny'
       order by expired_at desc
    `;
    return rows.map((r) => ({ app: r.app_slug, connector: r.connector_name, at: r.expired_at.toISOString() }));
  } catch {
    return [];
  }
}
