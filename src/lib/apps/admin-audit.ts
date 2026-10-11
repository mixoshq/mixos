/* This Source Code Form is subject to the terms of the Mozilla Public
 * License, v. 2.0. If a copy of the MPL was not distributed with this
 * file, You can obtain one at https://mozilla.org/MPL/2.0/. */

/**
 * Record a privileged action.
 *
 * Every admin server action is a directly-invocable POST endpoint that calls
 * `requireAdmin()` itself (see docs/security-architecture.md §9). That answers
 * "may this person do it". This answers "who did it, and to what" — which
 * nothing recorded before, on a platform whose admins hold every third-party
 * credential in the deployment.
 *
 * ── Two rules ───────────────────────────────────────────────────────────────
 *
 * 1. **Never pass a secret in `details`.** Several of these actions exist to
 *    carry credentials. Record which KEYS were set, never their values. Use
 *    `redactedKeys()` on anything that came from a credential form.
 *
 * 2. **Never let auditing fail the action.** A write here that throws must not
 *    roll back the thing the admin actually did — a connector saved but
 *    unaudited is strictly better than a connector the admin believes failed and
 *    saves twice. Failures are logged loudly instead. The trade is deliberate,
 *    and it is the reason this must never be the only control: it is a record,
 *    not a gate.
 */

import { sql } from "@/lib/db/client";
import { isUnverifiedActor } from "./audit-actors";

/**
 * Who did it. `id` is the signed-in admin's user id; null for an actor no
 * sign-in checked, whose `email` is then a name from ./audit-actors.ts, such as
 * the CLI's `cli:<os user>@<hostname>`.
 */
export interface AdminActor {
  id: string | null;
  email: string;
}

export interface AdminAuditEntry {
  /** Dotted verb: `connector.configure`, `user.grant.add`, `app.password.set`. */
  action: string;
  /** `connector` | `app` | `user` | `theme` | `job` | ... */
  targetType?: string;
  /** Connector name, app slug, user id — whatever identifies the target. */
  targetId?: string;
  /** Non-secret context. Read rule 1 above before adding anything here. */
  details?: Record<string, unknown>;
}

/**
 * The names of the fields that were supplied, without their values.
 *
 * This is what a credential form is allowed to contribute to an audit row: an
 * admin reading the log needs to know that `apiKey` and `region` were set on
 * Tuesday, and must never be able to read them back out of it.
 */
export function redactedKeys(values: Record<string, unknown>): string[] {
  return Object.entries(values)
    .filter(([, v]) => v !== undefined && v !== null && v !== "")
    .map(([k]) => k)
    .sort();
}

export async function recordAdminAction(
  actor: AdminActor,
  entry: AdminAuditEntry,
): Promise<void> {
  try {
    await sql`
      insert into public.admin_audit_log
        (actor_id, actor_email, action, target_type, target_id, details)
      values (
        ${actor.id},
        ${actor.email},
        ${entry.action},
        ${entry.targetType ?? null},
        ${entry.targetId ?? null},
        ${sql.json((entry.details ?? {}) as never)}
      )
    `;
  } catch (err) {
    // Rule 2. Loud, because a silently empty audit log is worse than none —
    // it reads as "nothing happened".
    console.error(
      `[admin-audit] FAILED to record ${entry.action} by ${actor.email}:`,
      err,
    );
  }
}

export interface AdminAuditRow {
  id: string;
  actorId: string | null;
  actorEmail: string;
  /**
   * False for a row no signed-in admin wrote: the CLI's or the release step's
   * (./audit-actors.ts). Show those as unverified: nothing checked who they
   * name.
   */
  actorVerified: boolean;
  action: string;
  targetType: string | null;
  targetId: string | null;
  details: Record<string, unknown>;
  createdAt: string;
}

/** The shape `sql` hands back, before it is renamed to the camelCase row. */
interface RawAuditRow {
  id: string;
  actor_id: string | null;
  actor_email: string;
  action: string;
  target_type: string | null;
  target_id: string | null;
  details: Record<string, unknown>;
  created_at: string | Date;
}

function toAuditRow(r: RawAuditRow): AdminAuditRow {
  return {
    id: r.id,
    actorId: r.actor_id,
    actorEmail: r.actor_email,
    actorVerified: !isUnverifiedActor(r.actor_email),
    action: r.action,
    targetType: r.target_type,
    targetId: r.target_id,
    details: r.details ?? {},
    createdAt: String(r.created_at),
  };
}

/** Clamped so a caller cannot turn a UI list into a full table scan. */
function clampLimit(limit: number): number {
  return Math.min(Math.max(limit, 1), 1000);
}

/** Most recent first. For the admin UI; callers must be admins themselves. */
export async function readAdminAuditLog(limit = 200): Promise<AdminAuditRow[]> {
  const rows = (await sql`
    select id, actor_id, actor_email, action, target_type, target_id, details, created_at
    from public.admin_audit_log
    order by created_at desc
    limit ${clampLimit(limit)}
  `) as unknown as RawAuditRow[];

  return rows.map(toAuditRow);
}

/**
 * Everything done TO one record — the user dialog's Activity tab.
 *
 * Scoped by target, not by actor. The question that tab answers is "how did this
 * account come to have the access it has", and the answer is a list of things
 * other people did to it: grants added, roles set, admin toggled, password
 * reset. Filtering by `actor_id` instead would answer a different question and
 * return nothing at all for every non-admin, which is most of the table.
 *
 * `target_type` is part of the filter because `target_id` alone is not unique
 * across types — an app slug and a user id live in the same column.
 */
export async function readAdminAuditLogForTarget(
  targetType: string,
  targetId: string,
  limit = 100,
): Promise<AdminAuditRow[]> {
  const rows = (await sql`
    select id, actor_id, actor_email, action, target_type, target_id, details, created_at
    from public.admin_audit_log
    where target_type = ${targetType} and target_id = ${targetId}
    order by created_at desc
    limit ${clampLimit(limit)}
  `) as unknown as RawAuditRow[];

  return rows.map(toAuditRow);
}
