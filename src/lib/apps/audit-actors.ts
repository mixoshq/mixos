/* This Source Code Form is subject to the terms of the Mozilla Public
 * License, v. 2.0. If a copy of the MPL was not distributed with this
 * file, You can obtain one at https://mozilla.org/MPL/2.0/. */

/**
 * Who an `admin_audit_log` row names when no signed-in admin acted.
 *
 * Most rows are written by a server action, which has checked a session with
 * `requireAdmin()` first: their `actor_id` is that admin's user id and their
 * `actor_email` is that admin's address. Two writers have no session:
 *
 * - **The release step** (scripts/sync-app-registry.ts) records apps leaving
 *   and returning to the build as `release-step`.
 * - **`npm run register`** (scripts/register.ts) records registering,
 *   discarding and recovering in a checkout as `cli:<os user>@<hostname>`.
 *
 * Their `actor_id` is null, and their names are not addresses (the colon, and
 * no `@` in the first), so no reader takes one for an admin's. Nobody signed in
 * to write them, so nothing checked who they name: the CLI's comes from the
 * machine it ran on, and anyone with a shell there can set both halves. Readers
 * label them unverified (isUnverifiedActor()).
 *
 * A row whose `actor_id` became null because the admin's user was deleted
 * still names their address, and was verified when it was written, so the
 * label keys on the name, not on the null.
 *
 * No imports: a client component may use this.
 */

/** The release step's name in the log. */
export const RELEASE_STEP_ACTOR = "release-step";

/** The scheduler tick's name in the log, for what it does by itself (an expired write, Item 8). */
export const SCHEDULER_ACTOR = "scheduler";

/** What every name the CLI writes starts with. */
export const CLI_ACTOR_PREFIX = "cli:";

/** One half of a CLI actor's name: printable ASCII a person can read, at most 64 characters. */
function namePart(raw: string | undefined): string {
  const cleaned = (raw ?? "").replace(/[^A-Za-z0-9._-]/g, "_").slice(0, 64);
  return cleaned || "unknown";
}

/** `cli:<os user>@<hostname>`, each half reduced to characters that print plainly. */
export function cliActorName(user: string | undefined, hostname: string | undefined): string {
  return `${CLI_ACTOR_PREFIX}${namePart(user)}@${namePart(hostname)}`;
}

/** Whether a row's actor is one no sign-in checked: the CLI's or the release step's. */
export function isUnverifiedActor(actorEmail: string): boolean {
  return actorEmail.startsWith(CLI_ACTOR_PREFIX) || actorEmail === RELEASE_STEP_ACTOR || actorEmail === SCHEDULER_ACTOR;
}
