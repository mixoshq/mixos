/* This Source Code Form is subject to the terms of the Mozilla Public
 * License, v. 2.0. If a copy of the MPL was not distributed with this
 * file, You can obtain one at https://mozilla.org/MPL/2.0/. */

/**
 * The update check: once a day, from the scheduler tick (`/api/cron`), ask the
 * catalogue about the extensions this build installed from it, so a release
 * its publisher withdrew reaches the admins of every instance running it.
 * ./updates.ts holds the rules; this module does the I/O.
 *
 * ── WHAT IS SENT, AND WHAT ISN'T ────────────────────────────────────────────
 *
 * One `POST <catalogue>/api/v1/updates`, from the server, never a browser:
 *
 *   { "instanceId": "<random UUID>",
 *     "items": [{ "kind": "app", "slug": "files", "version": "1.2.0" }] }
 *
 * The items are the extensions whose install record names this catalogue
 * (`itemsToCheck()`). Nothing else is sent: no MixOS version, no URL or host
 * name, nothing about users, data or settings, and nothing about an extension
 * that is local or came from elsewhere. mixos.org counts an install the first
 * time an instance lists a release, so there is no separate install report.
 *
 * ── THE INSTANCE ID ─────────────────────────────────────────────────────────
 *
 * `crypto.randomUUID()`, created the first time there is something to check
 * with the switch on, and kept in `platform_settings.registry_instance_id`.
 * Derived from nothing: not the host, the URL, a key or a user. One database is
 * one instance, so a checkout and production are two, and a restored backup is
 * the one it was. Deleting the row makes a new ID at the next check.
 *
 * ── OFF ─────────────────────────────────────────────────────────────────────
 *
 * MIXOS_UPDATE_CHECK=false (./policy.ts): the tick returns before reading
 * anything, so nothing is sent and no ID is created.
 *
 * ── ONE AT A TIME ───────────────────────────────────────────────────────────
 *
 * Every instance on a database shares one schedule, so the check runs under
 * the `repository.update-check` lock, with a two-minute lease: the request
 * times out after 8 seconds, and a holder that dies frees it soon. Whoever gets
 * the lock reads the schedule again, so two ticks at once make one request.
 *
 * Nothing here fails the tick: `/api/cron` calls this last, in a catch of its
 * own, and a failed request is recorded, not thrown.
 */

import { randomUUID } from "node:crypto";
import { registryInstalls } from "@/generated/registry-installs";
import { createServiceClient } from "@/lib/db/server";
import { LockUnavailableError, withPlatformLock } from "@/lib/platform/lock";
import { RepositoryError, checkUpdates, repositoryBaseUrl } from "./client";
import type { RegistryInstall } from "./install-record";
import { updateCheckEnabled } from "./policy";
import {
  afterFailure,
  afterSuccess,
  checkIsDue,
  itemsToCheck,
  parseUpdateCheckState,
  type UpdateCheckState,
} from "./updates";

/** The `platform_settings` keys this keeps. No migration: the table is key and value. */
export const INSTANCE_ID_KEY = "registry_instance_id";
export const UPDATE_CHECK_KEY = "registry_update_check";

/** The lease's length. The work under it is one request with an 8-second timeout. */
const LOCK_TTL_SECONDS = 120;

const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;

/** What a tick did, as `/api/cron` reports it. */
export type UpdateCheckOutcome =
  /** MIXOS_UPDATE_CHECK is false: nothing read, sent or created. */
  | "off"
  /** Nothing in this build came from the catalogue, so there is nothing to ask. */
  | "nothing-installed"
  | "not-due"
  /** Another tick holds the lock. */
  | "busy"
  | "checked"
  /** Recorded, with the next try scheduled. */
  | "failed";

export interface UpdateCheckOptions {
  /** This build's installs from a Registry. */
  installs?: readonly RegistryInstall[];
  now?: () => Date;
  /** For the random delay, in [0, 1). */
  random?: () => number;
}

/** Run the update check if it is due. Called by `/api/cron` on every tick. */
export async function runUpdateCheck(options: UpdateCheckOptions = {}): Promise<UpdateCheckOutcome> {
  if (!updateCheckEnabled()) return "off";
  const now = options.now ?? (() => new Date());

  let catalogue: string;
  try {
    catalogue = repositoryBaseUrl();
  } catch (err) {
    // Only a checkout reaches this: a built deployment ignores a bad value.
    // Browse reports it to admins; the check has nowhere to ask.
    console.warn(`[update-check] Not checking: ${err instanceof Error ? err.message : String(err)}`);
    return "failed";
  }

  const items = itemsToCheck(options.installs ?? registryInstalls, catalogue);
  if (items.length === 0) return "nothing-installed";
  if (!checkIsDue(await readUpdateCheckState(), items, now())) return "not-due";

  try {
    return await withPlatformLock(
      "repository.update-check",
      async (lease) => {
        // Read again under the lock: another tick may have checked meanwhile.
        const previous = await readUpdateCheckState();
        if (!checkIsDue(previous, items, now())) return "not-due";

        const instanceId = await instanceIdForCheck();
        let next: UpdateCheckState;
        let outcome: UpdateCheckOutcome;
        try {
          const answer = await checkUpdates(instanceId, items);
          next = afterSuccess(items, answer.items, now(), options.random);
          outcome = "checked";
        } catch (err) {
          const message = err instanceof Error ? err.message : String(err);
          const retryAfter = err instanceof RepositoryError ? err.retryAfterSeconds : undefined;
          next = afterFailure(previous, message, retryAfter, now());
          outcome = "failed";
          console.warn(`[update-check] ${message} Trying again at ${next.nextCheckAt}.`);
        }

        // A holder that lost the lease leaves the schedule to the one that took it.
        await lease.assertHeld();
        await writeUpdateCheckState(next);
        if (outcome === "checked") logWithdrawn(next);
        return outcome;
      },
      { ttlSeconds: LOCK_TTL_SECONDS },
    );
  } catch (err) {
    if (err instanceof LockUnavailableError) return "busy";
    throw err;
  }
}

/**
 * The stored state, or null before the first check. Throws when the database
 * can't be read; the admin pages catch that and show no answer.
 */
export async function readUpdateCheckState(): Promise<UpdateCheckState | null> {
  const { data, error } = await createServiceClient()
    .from("platform_settings")
    .select("value")
    .eq("key", UPDATE_CHECK_KEY)
    .maybeSingle();
  if (error) throw error;
  return parseUpdateCheckState((data as { value: string } | null)?.value);
}

async function writeUpdateCheckState(state: UpdateCheckState): Promise<void> {
  const { error } = await createServiceClient()
    .from("platform_settings")
    .upsert(
      { key: UPDATE_CHECK_KEY, value: JSON.stringify(state), updated_at: new Date().toISOString() },
      { onConflict: "key" },
    );
  if (error) throw error;
}

/**
 * This instance's ID, made now if there is none. Only the check calls this,
 * under its lock, once it knows it has something to send. A value that isn't a
 * UUID, which mixos.org would refuse, is replaced.
 */
async function instanceIdForCheck(): Promise<string> {
  const { data, error } = await createServiceClient()
    .from("platform_settings")
    .select("value")
    .eq("key", INSTANCE_ID_KEY)
    .maybeSingle();
  if (error) throw error;
  const stored = (data as { value: string } | null)?.value;
  if (stored && UUID.test(stored)) return stored;

  const id = randomUUID();
  const { error: saveError } = await createServiceClient().from("platform_settings").upsert(
    { key: INSTANCE_ID_KEY, value: id, updated_at: new Date().toISOString() },
    { onConflict: "key" },
  );
  if (saveError) throw saveError;
  return id;
}

/** One warning per withdrawn release, so an alert on the server log can catch it. */
function logWithdrawn(state: UpdateCheckState): void {
  for (const r of state.results) {
    if (!r.withdrawn) continue;
    console.warn(
      `[update-check] ${r.kind}/${r.slug} ${r.version} was withdrawn by its publisher` +
        `${r.reason ? `: ${r.reason}` : "."}`,
    );
  }
}
