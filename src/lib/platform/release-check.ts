/* This Source Code Form is subject to the terms of the Mozilla Public
 * License, v. 2.0. If a copy of the MPL was not distributed with this
 * file, You can obtain one at https://mozilla.org/MPL/2.0/. */

/**
 * The release check: once a day, from the scheduler tick (`/api/cron`), ask
 * mixos.org which releases of MixOS exist, so the admin pages can say when a
 * newer one is out, and when an admin presses Check now
 * (./release-check-actions.ts). ./releases.ts holds the rules; this module
 * does the I/O.
 *
 * ── WHAT IS SENT, AND WHAT ISN'T ────────────────────────────────────────────
 *
 * One `GET <catalogue>/api/v1/mixos/releases`, from the server, never a
 * browser, with `User-Agent: MixOS` and nothing else about this instance: no
 * instance ID, no version, no query and no body (`fetchCoreReleases()`).
 * mixos.org records nothing for a GET, so all it learns is that a MixOS
 * somewhere asked, from the request's IP address.
 *
 * ── OFF ─────────────────────────────────────────────────────────────────────
 *
 * MIXOS_UPDATE_CHECK=false, the same switch as the extension update check
 * (src/lib/repository/policy.ts): the tick returns before reading anything,
 * so nothing is sent. One switch, so "off" means nothing goes to mixos.org.
 *
 * ── ONE AT A TIME ───────────────────────────────────────────────────────────
 *
 * Every instance on a database shares one schedule, so the check runs under
 * the `platform.release-check` lock with a two-minute lease, as the update
 * check runs under its own. Whoever gets the lock reads the schedule again, so
 * two ticks at once make one request.
 *
 * ── WHAT IT WRITES ──────────────────────────────────────────────────────────
 *
 * One row, `platform_settings.mixos_release_check`, and the lock's own row
 * while it runs. Nothing else: no file, no setting, no deploy. Nothing here
 * fails the tick: `/api/cron` calls this in a catch of its own, and a failed
 * request is recorded, not thrown.
 */

import { createServiceClient } from "@/lib/db/server";
import { RepositoryError, fetchCoreReleases, repositoryBaseUrl } from "@/lib/repository/client";
import { releaseChannel, updateCheckEnabled, type ReleaseChannel } from "@/lib/repository/policy";
import { sourceHost } from "@/lib/repository/provenance";
import { LockUnavailableError, withPlatformLock } from "./lock";
import {
  afterReleaseCheck,
  afterReleaseCheckFailure,
  checkNowWaitsUntil,
  describeRelease,
  describeReleaseCheck,
  parseReleaseCheckState,
  releaseCheckIsDue,
  type ReleaseCheckState,
  type ReleaseCheckView,
} from "./releases";
import { mixosVersion } from "./version";

/** The `platform_settings` key this keeps. No migration: the table is key and value. */
export const RELEASE_CHECK_KEY = "mixos_release_check";

/** The lease's length. The work under it is one request with an 8-second timeout. */
const LOCK_TTL_SECONDS = 120;

/** What a tick did, as `/api/cron` reports it. */
export type ReleaseCheckOutcome =
  /** MIXOS_UPDATE_CHECK is false: nothing read or sent. */
  | "off"
  | "not-due"
  /** Another tick holds the lock. */
  | "busy"
  | "checked"
  /** Recorded, with the next try scheduled. */
  | "failed";

export interface ReleaseCheckOptions {
  /**
   * An admin's Check now: due by `checkNowWaitsUntil()` rather than the
   * schedule, so "not-due" means it was checked under a minute ago or the
   * catalogue asked for a wait. Everything else is the tick's: the switch,
   * the lock, the request and what is stored.
   */
  manual?: boolean;
  /** MIXOS_RELEASE_CHANNEL unless given. */
  channel?: ReleaseChannel;
  now?: () => Date;
  /** For the random delay, in [0, 1). */
  random?: () => number;
}

/** Run the release check if it is due. Called by `/api/cron` on every tick. */
export async function runReleaseCheck(options: ReleaseCheckOptions = {}): Promise<ReleaseCheckOutcome> {
  if (!updateCheckEnabled()) return "off";
  const now = options.now ?? (() => new Date());
  const channel = options.channel ?? releaseChannel();

  try {
    repositoryBaseUrl();
  } catch (err) {
    // Only a checkout reaches this: a built deployment ignores a bad value.
    // Browse reports it to admins; the check has nowhere to ask.
    console.warn(`[release-check] Not checking: ${err instanceof Error ? err.message : String(err)}`);
    return "failed";
  }

  const isDue = (state: ReleaseCheckState | null) =>
    options.manual ? checkNowWaitsUntil(state, now()) === null : releaseCheckIsDue(state, channel, now());
  if (!isDue(await readReleaseCheckState())) return "not-due";

  try {
    return await withPlatformLock(
      "platform.release-check",
      async (lease) => {
        // Read again under the lock: another tick may have checked meanwhile.
        const previous = await readReleaseCheckState();
        if (!isDue(previous)) return "not-due";

        let next: ReleaseCheckState;
        let outcome: ReleaseCheckOutcome;
        try {
          const list = await fetchCoreReleases();
          if (list.ignored > 0) {
            console.warn(
              `[release-check] Left out ${list.ignored} of the ${list.releases.length + list.ignored} ` +
                `releases on the list: they didn't parse.`,
            );
          }
          next = afterReleaseCheck(list.releases, channel, now(), options.random);
          outcome = "checked";
        } catch (err) {
          const message = err instanceof Error ? err.message : String(err);
          const retryAfter = err instanceof RepositoryError ? err.retryAfterSeconds : undefined;
          next = afterReleaseCheckFailure(previous, channel, message, retryAfter, now());
          outcome = "failed";
          console.warn(`[release-check] ${message} Trying again at ${next.nextCheckAt}.`);
        }

        // A holder that lost the lease leaves the schedule to the one that took it.
        await lease.assertHeld();
        await writeReleaseCheckState(next);
        if (outcome === "checked") logNewer(next);
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
export async function readReleaseCheckState(): Promise<ReleaseCheckState | null> {
  const { data, error } = await createServiceClient()
    .from("platform_settings")
    .select("value")
    .eq("key", RELEASE_CHECK_KEY)
    .maybeSingle();
  if (error) throw error;
  return parseReleaseCheckState((data as { value: string } | null)?.value);
}

async function writeReleaseCheckState(state: ReleaseCheckState): Promise<void> {
  const { error } = await createServiceClient()
    .from("platform_settings")
    .upsert(
      { key: RELEASE_CHECK_KEY, value: JSON.stringify(state), updated_at: new Date().toISOString() },
      { onConflict: "key" },
    );
  if (error) throw error;
}

/** One line when a newer release is out, so whoever reads the server log hears too. */
function logNewer(state: ReleaseCheckState): void {
  const notice = describeRelease(state.latest, state.channel, mixosVersion());
  if (notice) console.log(`[release-check] ${notice.text}`);
}

/**
 * What the admin pages show about new releases: the notice at the top, when
 * one is out, and the line under the build's version. Read from the stored
 * answer, never from the network, so a page waits on nobody. A database that
 * can't be read costs the answer, not the page.
 */
export async function releaseCheckView(now: Date = new Date()): Promise<ReleaseCheckView> {
  const enabled = updateCheckEnabled();
  const channel = releaseChannel();

  let host: string | null = null;
  try {
    host = sourceHost(repositoryBaseUrl());
  } catch {
    // A bad MIXOS_REPOSITORY_URL, in a checkout. Browse says so.
  }

  let state: ReleaseCheckState | null = null;
  if (enabled) {
    try {
      state = await readReleaseCheckState();
    } catch (err) {
      console.error("[release-check] could not read the last answer:", err);
    }
  }

  return describeReleaseCheck({ enabled, channel, state, current: mixosVersion(), host, now });
}
