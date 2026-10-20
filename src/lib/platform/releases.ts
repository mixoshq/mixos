/* This Source Code Form is subject to the terms of the Mozilla Public
 * License, v. 2.0. If a copy of the MPL was not distributed with this
 * file, You can obtain one at https://mozilla.org/MPL/2.0/. */

/**
 * The release check's rules, with no I/O: which release on the list counts,
 * when a check is due, what is kept, and what admins are told.
 *
 * ./release-check.ts does the work from the scheduler tick: the switch, the
 * lock, the request and the stored state. The admin pages show what
 * `describeReleaseCheck()` returns (src/components/settings/settings-shell.tsx),
 * and its notice also puts a banner over every other page for admins
 * (./release-banner.ts).
 * Everything here takes its clock and this build's version as arguments, so the
 * tests can drive every case.
 *
 * ── THE SOURCE ──────────────────────────────────────────────────────────────
 *
 * mixos.org's list of MixOS releases, `GET /api/v1/mixos/releases` on the
 * catalogue this instance browses (`fetchCoreReleases()` in
 * src/lib/repository/client.ts). mixos.org builds it from the core
 * repository's annotated tags on `main`, and records nothing about who reads
 * it. The core repository is private, so GitHub's own release pages would be a
 * 404 for most admins; the list and its pages on mixos.org are not.
 *
 * ── WHICH RELEASE ───────────────────────────────────────────────────────────
 *
 * The newest on this instance's channel, by semver, whatever order the list
 * is in. On `stable` a release marked as a prerelease, or whose tag has a
 * suffix, is left out; on `prerelease` it counts (MIXOS_RELEASE_CHANNEL,
 * src/lib/repository/policy.ts). It is kept whether or not it is newer than
 * this build: the page compares it with the version running, which changes
 * with each deploy while the stored answer doesn't.
 *
 * ── WHEN ────────────────────────────────────────────────────────────────────
 *
 * On the update check's schedule (src/lib/repository/updates.ts): 21 hours
 * after the last success plus up to an hour; after a failure, an hour later or
 * at the catalogue's `Retry-After`, but never more than a day. A changed
 * channel is due at once, as a changed set of extensions is for that check.
 *
 * ── NEVER APPLIED ───────────────────────────────────────────────────────────
 *
 * The answer drives one notice, its banner and one line, and nothing else.
 * Applying a release is merging its tag into the operator's repository and
 * deploying it, which no button here does: the notice and the banner name
 * `/mixos upgrade`, which an admin runs in their own copy.
 */

import { z } from "zod";
import { docsUrl } from "@/lib/docs";
import { CORE_RELEASE_TAG, CoreReleaseSchema, type CoreRelease } from "@/lib/repository/types";
import { RELEASE_CHANNELS, type ReleaseChannel } from "@/lib/repository/policy";
import {
  ago,
  day,
  scheduleAfterFailure,
  scheduleAfterSuccess,
  scheduleIsDue,
} from "@/lib/repository/updates";
import {
  compareRelease,
  compareReleaseVersions,
  parseReleaseVersion,
  type ReleaseStep,
  type ReleaseVersion,
} from "./version-floor";

/* -------------------------------------------------------------------------- */
/*  Which release                                                              */
/* -------------------------------------------------------------------------- */

/** A prerelease, by its flag or by its tag: on `stable`, either leaves it out. */
export function isPrerelease(release: CoreRelease): boolean {
  return release.prerelease || release.tag.includes("-");
}

/** Whether `release` counts on `channel`. */
export function onChannel(release: CoreRelease, channel: ReleaseChannel): boolean {
  return channel === "prerelease" || !isPrerelease(release);
}

/** The newest release on `channel`, by semver, or null when the list has none. */
export function latestOnChannel(
  releases: readonly CoreRelease[],
  channel: ReleaseChannel,
): CoreRelease | null {
  let best: { release: CoreRelease; version: ReleaseVersion } | null = null;
  for (const release of releases) {
    if (!onChannel(release, channel)) continue;
    // The schema has already refused a tag that isn't a version.
    const version = parseReleaseVersion(release.tag);
    if (!version) continue;
    if (!best || compareReleaseVersions(version, best.version) > 0) best = { release, version };
  }
  return best?.release ?? null;
}

/* -------------------------------------------------------------------------- */
/*  What is kept: the stored state                                             */
/* -------------------------------------------------------------------------- */

/**
 * `platform_settings.mixos_release_check`, as JSON. Overwritten by every
 * check; nothing else is kept.
 *
 * `latest` goes through the list's own schema again when it is read, so the
 * notice builds its link only from a tag that is a version, however the row
 * was written.
 */
const ReleaseCheckStateSchema = z.object({
  /** The channel `latest` was chosen on. A different one makes a check due at once. */
  channel: z.enum(RELEASE_CHANNELS),
  /** The newest release on that channel at the last success, or null when there was none. */
  latest: CoreReleaseSchema.nullable(),
  lastSuccessAt: z.string().nullable(),
  lastAttemptAt: z.string().nullable(),
  /** Why the last attempt failed, or null when it succeeded. */
  lastError: z.string().nullable(),
  nextCheckAt: z.string().nullable(),
});
export type ReleaseCheckState = z.infer<typeof ReleaseCheckStateSchema>;

/**
 * The stored state, or null when there is none or it isn't one. A value that
 * doesn't parse is treated as never checked, so the next tick checks.
 */
export function parseReleaseCheckState(text: string | null | undefined): ReleaseCheckState | null {
  if (!text) return null;
  try {
    const parsed = ReleaseCheckStateSchema.safeParse(JSON.parse(text));
    return parsed.success ? parsed.data : null;
  } catch {
    return null;
  }
}

/* -------------------------------------------------------------------------- */
/*  When                                                                       */
/* -------------------------------------------------------------------------- */

/** Whether a check is due now, on `channel`. A changed channel is due at once, unless a failure's wait holds. */
export function releaseCheckIsDue(
  state: ReleaseCheckState | null,
  channel: ReleaseChannel,
  now: Date,
): boolean {
  return scheduleIsDue(state, now, state !== null && state.channel !== channel);
}

/** The state after a check mixos.org answered. `random` is in [0, 1). */
export function afterReleaseCheck(
  releases: readonly CoreRelease[],
  channel: ReleaseChannel,
  now: Date,
  random: () => number = Math.random,
): ReleaseCheckState {
  return { channel, latest: latestOnChannel(releases, channel), ...scheduleAfterSuccess(now, random) };
}

/**
 * The state after a check that failed: the last answer kept, with the channel
 * it was chosen on, and the next try as `scheduleAfterFailure()` sets it.
 */
export function afterReleaseCheckFailure(
  previous: ReleaseCheckState | null,
  channel: ReleaseChannel,
  error: string,
  retryAfterSeconds: number | undefined,
  now: Date,
): ReleaseCheckState {
  return {
    channel: previous?.channel ?? channel,
    latest: previous?.latest ?? null,
    ...scheduleAfterFailure(previous, error, retryAfterSeconds, now),
  };
}

/* -------------------------------------------------------------------------- */
/*  What admins are told                                                       */
/* -------------------------------------------------------------------------- */

/**
 * The release's page on mixos.org, built from its tag and nothing in the
 * answer. The core repository is private, so its own release pages would be a
 * 404 for most admins; once it is public, this can be
 * `https://github.com/mixoshq/mixos/releases/tag/<tag>`. Null for anything that
 * isn't a release tag.
 */
export function releasePageUrl(tag: string): string | null {
  if (!tag.startsWith("v") || !parseReleaseVersion(tag)) return null;
  return docsUrl(`releases/${encodeURIComponent(tag)}`);
}

/** How to take a release into a copy of MixOS. */
export const UPGRADE_GUIDE_URL = docsUrl("install/after-you-install/upgrading");

/**
 * What an admin runs in Claude Code, in their copy of MixOS, to take the
 * newest release (.claude/skills/mixos/actions/upgrade.md). The notice and the
 * banner give it first.
 */
export const UPGRADE_COMMAND = "/mixos upgrade";

/**
 * The merge by hand, as the upgrade guide gives it, for a release tag the
 * list's schema validates: `git fetch upstream --tags && git merge v0.5.0`.
 */
export function mergeCommand(tag: string): string {
  if (!CORE_RELEASE_TAG.test(tag) || !parseReleaseVersion(tag)) {
    throw new Error("A release tag the list's schema validates.");
  }
  return `git fetch upstream --tags && git merge ${tag}`;
}

/** The docs section that says what the release check sends, and how to turn it off. */
export const WHAT_THE_RELEASE_CHECK_SENDS = docsUrl("security/surface#the-release-check");

/** The notice at the top of the admin pages, when a newer release is out. */
export interface ReleaseNotice {
  /** The release's tag, `v0.5.0`. */
  tag: string;
  /** The release's commit, 40 hex characters, as the list's schema checked it. */
  commitSha: string;
  /** "MixOS 0.5.0 is available (this instance runs 0.4.2). A minor release: it may need changes." */
  text: string;
  /** Its notes, untrusted Markdown, possibly empty. Rendered collapsed, with links as text. */
  notes: string;
  /** Its page on mixos.org. */
  releaseUrl: string;
  /** How to upgrade. */
  upgradeUrl: string;
}

/**
 * What a newer release's step means for whoever runs this instance. Under 0.x
 * a minor release may need changes and a patch release is fixes, which is the
 * rule a release's version is bumped by (scripts/release-prep.ts): a breaking
 * change, an `os` change, or a change to the platform's files makes a minor
 * release, and anything else a patch.
 */
function stepSentence(step: ReleaseStep, to: ReleaseVersion): string {
  const base = `${to.major}.${to.minor}.${to.patch}`;
  switch (step) {
    case "major":
      return "A major release: it may need changes.";
    case "minor":
      return to.major === 0 ? "A minor release: it may need changes." : "A minor release: new features.";
    case "patch":
      return "A patch release: fixes.";
    case "prerelease":
      return to.prerelease.length === 0 ? `The final release of ${base}.` : `A later prerelease of ${base}.`;
  }
}

/**
 * The notice the stored answer calls for, or null: only for a release on this
 * channel that is newer than the version running.
 */
export function describeRelease(
  latest: CoreRelease | null,
  channel: ReleaseChannel,
  current: string,
): ReleaseNotice | null {
  if (!latest || !onChannel(latest, channel)) return null;
  const comparison = compareRelease(latest.tag, current);
  const to = parseReleaseVersion(latest.tag);
  const releaseUrl = releasePageUrl(latest.tag);
  if (comparison?.order !== "newer" || !to || !releaseUrl) return null;

  const version = latest.tag.slice(1);
  const trial =
    isPrerelease(latest) && comparison.step !== "prerelease"
      ? " It's a prerelease, for trying it before it's final."
      : "";
  return {
    tag: latest.tag,
    commitSha: latest.commitSha,
    text: `MixOS ${version} is available (this instance runs ${current}). ${stepSentence(comparison.step, to)}${trial}`,
    notes: latest.notes,
    releaseUrl,
    upgradeUrl: UPGRADE_GUIDE_URL,
  };
}

/**
 * The muted line beside the build's version: whether this instance checks,
 * and when it last heard from the catalogue.
 */
export function releaseStatusLine(
  enabled: boolean,
  state: ReleaseCheckState | null,
  channel: ReleaseChannel,
  host: string,
  now: Date,
): string {
  if (!enabled) return "Release checks are off (MIXOS_UPDATE_CHECK).";
  if (!state?.lastAttemptAt) return "Not checked for new releases yet.";
  if (state.lastError) {
    return state.lastSuccessAt
      ? `Couldn't reach ${host} for new releases since ${day(state.lastSuccessAt, now)}.`
      : `Not checked for new releases yet: couldn't reach ${host}.`;
  }
  const what = channel === "prerelease" ? "new releases and prereleases" : "new releases";
  return `Checked ${host} for ${what} ${ago(state.lastSuccessAt ?? state.lastAttemptAt, now)}.`;
}

export interface ReleaseCheckInput {
  /** MIXOS_UPDATE_CHECK. Off, no answer is shown: nothing keeps it current. */
  enabled: boolean;
  channel: ReleaseChannel;
  state: ReleaseCheckState | null;
  /** This build's version. */
  current: string;
  /** The catalogue's host, as people say it, or null when it can't be read. */
  host: string | null;
  now: Date;
}

export interface ReleaseCheckView {
  /** At the top of the admin pages, when a newer release is out. */
  notice: ReleaseNotice | null;
  /** Under the build's version, or null when there's no catalogue to name. */
  status: string | null;
}

/** Everything the admin pages show about new releases of MixOS. */
export function describeReleaseCheck(input: ReleaseCheckInput): ReleaseCheckView {
  const { enabled, channel, state, current, host, now } = input;
  return {
    notice: enabled && state ? describeRelease(state.latest, channel, current) : null,
    status: host ? releaseStatusLine(enabled, state, channel, host, now) : null,
  };
}
