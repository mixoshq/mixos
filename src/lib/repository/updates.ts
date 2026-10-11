/* This Source Code Form is subject to the terms of the Mozilla Public
 * License, v. 2.0. If a copy of the MPL was not distributed with this
 * file, You can obtain one at https://mozilla.org/MPL/2.0/. */

/**
 * The update check's rules, with no I/O: what is checked, when a check is due,
 * what is kept of an answer, and what admins are told about it.
 *
 * ./update-check.ts does the work from the scheduler tick: the switch, the
 * lock, the request and the stored state. The Apps, Connectors and Themes
 * pages show what `registryNotices()` returns
 * (src/components/admin/registry-notices.tsx). Everything here takes its clock
 * as an argument, so the tests can drive every case.
 *
 * ── WHAT IS CHECKED ─────────────────────────────────────────────────────────
 *
 * The extensions in this build installed from the catalogue this instance
 * browses: a record in `registryInstalls` whose `source` is
 * `repositoryBaseUrl()`. Each is sent as its kind, slug and version. A local
 * extension, one installed from another catalogue, and one whose
 * `.registry.json` was deleted are never sent.
 *
 * ── WHEN ────────────────────────────────────────────────────────────────────
 *
 * 21 hours after the last success, plus up to an hour at random so instances
 * don't all ask at once. Not 24: Vercel Hobby fires its daily cron anywhere in
 * its hour, so two of its ticks can be 23 hours apart, and a check due after 24
 * hours would then run every other day. A changed installed set is due at once,
 * so a deploy that replaces a withdrawn release clears its notice at the next
 * tick. A failure keeps the last answer and tries again in an hour, or when the
 * catalogue's `Retry-After` says, but never more than a day later; while it
 * waits, a changed set waits too.
 *
 * ── WHAT IS KEPT AND SHOWN ──────────────────────────────────────────────────
 *
 * The answer is the catalogue's to write, so it is kept only for an item that
 * was sent, at the version sent, and each field is checked or cleaned before it
 * is stored. It drives notices and nothing else: nothing is updated,
 * deactivated or downloaded because of it. Deactivate, on a withdrawn app's
 * notice, is an admin's act.
 */

import { z } from "zod";
import { mixosVersion, satisfiesMinimum } from "@/lib/platform/version";
import { parseVersion } from "@/lib/platform/version-floor";
import { isRecordedVersion, type RegistryInstall } from "./install-record";
import { sourceHost } from "./provenance";
import { ExtensionKindSchema, type ExtensionKind, type UpdateItem, type UpdateResult } from "./types";

const MINUTE = 60_000;
const HOUR = 60 * MINUTE;
const DAY = 24 * HOUR;

/** From the last success to the next check, before the random delay. */
export const CHECK_EVERY_MS = 21 * HOUR;
/** The random delay's upper bound. */
export const CHECK_JITTER_MS = HOUR;
/** From a failure to the next try, when the catalogue doesn't say. */
export const RETRY_AFTER_FAILURE_MS = HOUR;
/** The longest any wait can be: a `Retry-After` beyond it is cut to it. */
export const LONGEST_WAIT_MS = DAY;

/** The publisher's reason is kept to the length `mixos yank --reason` accepts. */
export const MAX_REASON_LENGTH = 500;

/* -------------------------------------------------------------------------- */
/*  What is checked                                                            */
/* -------------------------------------------------------------------------- */

/**
 * The items an update check sends: each extension installed from `catalogue`,
 * as its kind, slug and version. A folder modified locally is still checked,
 * since it still runs that release with changes on top.
 */
export function itemsToCheck(installs: readonly RegistryInstall[], catalogue: string): UpdateItem[] {
  return installs
    .filter((i) => i.source === catalogue)
    .map(({ kind, slug, version }) => ({ kind, slug, version }));
}

const itemKey = (i: UpdateItem) => `${i.kind}/${i.slug}@${i.version}`;

/** Whether two installed sets are the same, in any order. */
export function sameItems(a: readonly UpdateItem[] | null, b: readonly UpdateItem[]): boolean {
  if (!a || a.length !== b.length) return false;
  const left = a.map(itemKey).sort();
  const right = b.map(itemKey).sort();
  return left.every((key, n) => key === right[n]);
}

/* -------------------------------------------------------------------------- */
/*  What is kept: the stored state                                             */
/* -------------------------------------------------------------------------- */

const UpdateItemSchema = z.object({ kind: ExtensionKindSchema, slug: z.string(), version: z.string() });

/** What is kept of the catalogue's answer for one extension, every field checked or cleaned. */
const StoredResultSchema = z.object({
  kind: ExtensionKindSchema,
  slug: z.string(),
  /** The version sent, which this answer is about. */
  version: z.string(),
  /** The listing's state. Only `published` installs anything new. */
  listing: z.enum(["published", "archived", "draft", "other"]),
  /** The version sent was withdrawn by its publisher. */
  withdrawn: z.boolean(),
  /** The publisher's reason, as plain text, or null. */
  reason: z.string().nullable(),
  /** The catalogue's current release, dotted or a commit's hex, or null when there is none. */
  latest: z.string().nullable(),
  latestReleasedAt: z.string().nullable(),
  /** The current release's floor, as the catalogue gives it. */
  latestRequiresMixOS: z.string().nullable(),
});
export type StoredResult = z.infer<typeof StoredResultSchema>;

/**
 * `platform_settings.registry_update_check`, as JSON. Overwritten by every
 * check; the instance keeps no history of answers.
 */
const UpdateCheckStateSchema = z.object({
  /** What the last successful check sent, which `results` answer. Null before one has. */
  sent: z.array(UpdateItemSchema).nullable(),
  results: z.array(StoredResultSchema),
  lastSuccessAt: z.string().nullable(),
  lastAttemptAt: z.string().nullable(),
  /** Why the last attempt failed, or null when it succeeded. */
  lastError: z.string().nullable(),
  nextCheckAt: z.string().nullable(),
});
export type UpdateCheckState = z.infer<typeof UpdateCheckStateSchema>;

/**
 * The stored state, or null when there is none or it isn't one. A value that
 * doesn't parse is treated as never checked, so the next tick checks.
 */
export function parseUpdateCheckState(text: string | null | undefined): UpdateCheckState | null {
  if (!text) return null;
  try {
    const parsed = UpdateCheckStateSchema.safeParse(JSON.parse(text));
    return parsed.success ? parsed.data : null;
  } catch {
    return null;
  }
}

/**
 * The publisher's reason as plain text: line breaks become spaces, control
 * and bidi characters go, and it is cut to 500 characters. Null when nothing
 * is left. It is rendered as text, never as markup, wherever it is shown.
 */
export function cleanReason(raw: string | null | undefined): string | null {
  if (!raw) return null;
  const text = raw
    .replace(/[\t\n\v\f\r\u0085\u2028\u2029]+/g, " ")
    // C0, DEL and C1 controls, and the bidi controls that can reorder what is
    // printed around them.
    .replace(/[\u0000-\u001f\u007f-\u009f\u200e\u200f\u202a-\u202e\u2066-\u2069]/g, "")
    .replace(/ {2,}/g, " ")
    .trim();
  if (!text) return null;
  // Counted in code points, so the cut never splits a surrogate pair.
  const chars = Array.from(text);
  return chars.length > MAX_REASON_LENGTH
    ? `${chars.slice(0, MAX_REASON_LENGTH - 1).join("").trimEnd()}…`
    : text;
}

/** A floor as the install record accepts one: printable ASCII, short. */
const FLOOR = /^[\x21-\x7e](?:[\x20-\x7e]{0,62}[\x21-\x7e])?$/;

function listingOf(status: string): StoredResult["listing"] {
  return status === "published" || status === "archived" || status === "draft" ? status : "other";
}

function isoOrNull(value: string | null | undefined): string | null {
  if (!value) return null;
  const at = Date.parse(value);
  return Number.isNaN(at) ? null : new Date(at).toISOString();
}

/**
 * What is kept of an answer: one result for each item sent, from the
 * catalogue's entry for that kind and slug at the version sent. An entry for
 * anything else, or at another version, is ignored. The latest version must be
 * one install could record, the floor printable and short, the date a date;
 * anything else is kept as unknown.
 */
export function keepAnswersFor(
  sent: readonly UpdateItem[],
  answered: readonly UpdateResult[],
): StoredResult[] {
  const kept: StoredResult[] = [];
  for (const item of sent) {
    const answer = answered.find(
      (a) => a.kind === item.kind && a.slug === item.slug && a.installedVersion === item.version,
    );
    if (!answer) continue;
    const latest = answer.latestVersion ?? null;
    const floor = answer.latestRequiresMixOS ?? null;
    kept.push({
      // The item's own values, not the answer's copies of them.
      kind: item.kind,
      slug: item.slug,
      version: item.version,
      listing: listingOf(answer.listingStatus),
      withdrawn: answer.installedYanked,
      reason: answer.installedYanked ? cleanReason(answer.installedYankedReason) : null,
      latest: latest !== null && isRecordedVersion(latest) ? latest : null,
      latestReleasedAt: isoOrNull(answer.latestReleasedAt),
      latestRequiresMixOS: floor !== null && FLOOR.test(floor) ? floor : null,
    });
  }
  return kept;
}

/* -------------------------------------------------------------------------- */
/*  When                                                                       */
/* -------------------------------------------------------------------------- */

/**
 * Whether a check is due now, for this installed set.
 *
 * Due with no state, and when the stored schedule is further away than any
 * this code writes (a clock that moved, or a value written by hand), so a
 * stored date can never stop checks for good. After a failure, the wait it set
 * holds whatever else changed.
 */
export function checkIsDue(
  state: UpdateCheckState | null,
  items: readonly UpdateItem[],
  now: Date,
): boolean {
  if (!state?.lastAttemptAt || !state.nextCheckAt) return true;
  const next = Date.parse(state.nextCheckAt);
  if (Number.isNaN(next) || next - now.getTime() > LONGEST_WAIT_MS) return true;
  const waiting = now.getTime() < next;
  if (state.lastError) return !waiting;
  if (!sameItems(state.sent, items)) return true;
  return !waiting;
}

/** The state after a check the catalogue answered. `random` is in [0, 1). */
export function afterSuccess(
  sent: readonly UpdateItem[],
  answered: readonly UpdateResult[],
  now: Date,
  random: () => number = Math.random,
): UpdateCheckState {
  const delay = CHECK_EVERY_MS + Math.floor(Math.min(Math.max(random(), 0), 1) * CHECK_JITTER_MS);
  return {
    sent: sent.map(({ kind, slug, version }) => ({ kind, slug, version })),
    results: keepAnswersFor(sent, answered),
    lastSuccessAt: now.toISOString(),
    lastAttemptAt: now.toISOString(),
    lastError: null,
    nextCheckAt: new Date(now.getTime() + delay).toISOString(),
  };
}

/**
 * The state after a check that failed: the last answer kept, and the next try
 * in an hour, or after `retryAfterSeconds` when the catalogue sent one, but
 * never more than a day away.
 */
export function afterFailure(
  previous: UpdateCheckState | null,
  error: string,
  retryAfterSeconds: number | undefined,
  now: Date,
): UpdateCheckState {
  const wait =
    retryAfterSeconds === undefined || !Number.isFinite(retryAfterSeconds)
      ? RETRY_AFTER_FAILURE_MS
      : Math.min(Math.max(retryAfterSeconds, 0) * 1000, LONGEST_WAIT_MS);
  return {
    sent: previous?.sent ?? null,
    results: previous?.results ?? [],
    lastSuccessAt: previous?.lastSuccessAt ?? null,
    lastAttemptAt: now.toISOString(),
    lastError: cleanReason(error) ?? "The check failed.",
    nextCheckAt: new Date(now.getTime() + wait).toISOString(),
  };
}

/* -------------------------------------------------------------------------- */
/*  What admins are told                                                       */
/* -------------------------------------------------------------------------- */

/**
 * One line under an admin page's header:
 *
 *   - withdrawn: the version this instance runs was withdrawn by its publisher.
 *     A danger, shown on every admin page whatever the kind.
 *   - newer: the catalogue's current release differs, and is newer when both
 *     versions are dotted. On its kind's page.
 *   - unlisted: the listing isn't published any more. On its kind's page.
 *   - modified: the folder no longer matches its install record. Muted.
 *   - elsewhere: installed from another catalogue, so not checked here. Muted.
 */
export type RegistryNoticeType = "withdrawn" | "newer" | "unlisted" | "modified" | "elsewhere";

export interface RegistryNotice {
  type: RegistryNoticeType;
  kind: ExtensionKind;
  slug: string;
  text: string;
}

/** Order on the page: the danger first, the muted last. */
const ORDER: Record<RegistryNoticeType, number> = {
  withdrawn: 0,
  newer: 1,
  unlisted: 2,
  modified: 3,
  elsewhere: 4,
};

/** `X.Y` or `X.Y.Z`, with any suffix: a version that can be put in order. Not a commit's hex, even an all-digit one. */
const DOTTED = /^\d+\.\d+(?:\.\d+)?(?:[-+][0-9A-Za-z.-]+)?$/;

export function isDotted(version: string): boolean {
  return DOTTED.test(version);
}

/** -1, 0 or 1, for two dotted versions, by their numbers alone. */
function compareDotted(a: string, b: string): number {
  const x = parseVersion(a);
  const y = parseVersion(b);
  if (!x || !y) return 0;
  for (const part of ["major", "minor", "patch"] as const) {
    if (x[part] !== y[part]) return x[part] < y[part] ? -1 : 1;
  }
  return 0;
}

/** "5 Oct", with the year when it isn't `now`'s. */
function day(iso: string, now: Date): string {
  const at = new Date(iso);
  return at.toLocaleDateString("en-GB", {
    day: "numeric",
    month: "short",
    ...(at.getFullYear() === now.getFullYear() ? {} : { year: "numeric" }),
  });
}

/** "just now", "5 mins ago", "3 hours ago", "2 days ago", as the admin pages say an age. */
function ago(iso: string, now: Date): string {
  const diff = now.getTime() - Date.parse(iso);
  if (Number.isNaN(diff) || diff < MINUTE) return "just now";
  if (diff < HOUR) {
    const m = Math.round(diff / MINUTE);
    return `${m} min${m === 1 ? "" : "s"} ago`;
  }
  if (diff < DAY) {
    const h = Math.round(diff / HOUR);
    return `${h} hour${h === 1 ? "" : "s"} ago`;
  }
  const d = Math.round(diff / DAY);
  return d < 30 ? `${d} day${d === 1 ? "" : "s"} ago` : `on ${day(iso, now)}`;
}

/**
 * What a notice that names the current release adds about its floor: nothing
 * when this instance meets it, both versions when it doesn't, and the floor
 * alone when the two can't be compared.
 */
function floorLine(floor: string | null, current: string): string {
  if (!floor) return "";
  const check = satisfiesMinimum(floor, current);
  if (check.checked) return check.allowed ? "" : ` It needs MixOS ${floor} or newer; this instance runs ${current}.`;
  return ` It needs MixOS ${floor} or newer.`;
}

export interface DescribeOptions {
  /** The extension's name, as this build's manifest has it. */
  name: string;
  /** The catalogue's host, as people say it: `mixos.org`. */
  host: string;
  /** This build's MixOS version. */
  current?: string;
  now?: Date;
}

/**
 * The notice one answer calls for, or null. A withdrawn release outranks the
 * rest; a listing that isn't published offers nothing to move to; a newer
 * release is "newer" only when both versions are dotted, since a release
 * published from the website is named by its commit.
 */
export function describeUpdate(
  result: StoredResult,
  { name, host, current = mixosVersion(), now = new Date() }: DescribeOptions,
): RegistryNotice | null {
  const of = { kind: result.kind, slug: result.slug };
  // Nothing new installs from a listing that isn't published.
  const latest = result.listing === "published" ? result.latest : null;
  const floor = latest ? floorLine(result.latestRequiresMixOS, current) : "";

  if (result.withdrawn) {
    const why = result.reason ? `: “${result.reason}”.` : ".";
    const next = latest ? ` The current release is ${latest}.${floor}` : " There is no release to move to.";
    return { ...of, type: "withdrawn", text: `${name} ${result.version} was withdrawn by its publisher${why}${next}` };
  }

  if (result.listing !== "published") {
    const how =
      result.listing === "archived"
        ? ": its publisher archived it"
        : result.listing === "draft"
          ? ": its publisher unpublished it"
          : "";
    return { ...of, type: "unlisted", text: `${name} is no longer listed on ${host}${how}. The copy here keeps running.` };
  }

  if (!latest || latest === result.version) return null;
  const runs = ` This instance runs ${result.version}.`;
  if (isDotted(latest) && isDotted(result.version)) {
    if (compareDotted(latest, result.version) <= 0) return null;
    return { ...of, type: "newer", text: `${name} ${latest} is available.${runs}${floor}` };
  }
  const from = result.latestReleasedAt ? `, from ${day(result.latestReleasedAt, now)}` : "";
  return { ...of, type: "newer", text: `${host}'s current release of ${name} is ${latest}${from}.${runs}${floor}` };
}

/**
 * The muted line under the notices: whether this instance checks, and when it
 * last heard from the catalogue.
 */
export function statusLine(
  enabled: boolean,
  state: UpdateCheckState | null,
  host: string,
  now: Date,
): string {
  if (!enabled) return "Update checks are off (MIXOS_UPDATE_CHECK).";
  if (!state?.lastAttemptAt) return "Not checked yet.";
  if (state.lastError) {
    return state.lastSuccessAt
      ? `Couldn't reach ${host} since ${day(state.lastSuccessAt, now)}.`
      : `Not checked yet: couldn't reach ${host}.`;
  }
  return `Checked with ${host} ${ago(state.lastSuccessAt ?? state.lastAttemptAt, now)}.`;
}

export interface NoticesInput {
  /** The page's kind. A withdrawn release shows on every page; the rest on their own kind's. */
  kind: ExtensionKind;
  installs: readonly RegistryInstall[];
  /** `repositoryBaseUrl()`, or null when it can't be read. */
  catalogue: string | null;
  /** MIXOS_UPDATE_CHECK. Off, no answer is shown: nothing keeps it current. */
  enabled: boolean;
  state: UpdateCheckState | null;
  /** An extension's name as this build has it. */
  nameOf: (kind: ExtensionKind, slug: string) => string;
  current?: string;
  now: Date;
}

export interface NoticesView {
  notices: RegistryNotice[];
  /** The muted status line, or null when nothing in this build came from the catalogue. */
  status: string | null;
}

/**
 * Everything an admin page shows under its header about the extensions this
 * build installed from a Registry. An answer counts only while the build still
 * runs the version it was about: after a deploy that changes it, the notice
 * waits for the next check, which a changed set makes due at once.
 */
export function registryNotices(input: NoticesInput): NoticesView {
  const { kind, installs, catalogue, enabled, state, nameOf, now } = input;
  const host = catalogue ? sourceHost(catalogue) : null;
  const fromHere = catalogue ? installs.filter((i) => i.source === catalogue) : [];
  const notices: RegistryNotice[] = [];

  if (enabled && state && host) {
    for (const install of fromHere) {
      const result = state.results.find(
        (r) => r.kind === install.kind && r.slug === install.slug && r.version === install.version,
      );
      if (!result) continue;
      const notice = describeUpdate(result, {
        name: nameOf(install.kind, install.slug),
        host,
        current: input.current,
        now,
      });
      if (notice && (notice.type === "withdrawn" || install.kind === kind)) notices.push(notice);
    }
  }

  for (const install of installs) {
    if (install.kind !== kind) continue;
    const name = nameOf(install.kind, install.slug);
    const from = sourceHost(install.source);
    if (install.modified) {
      notices.push({
        type: "modified",
        kind: install.kind,
        slug: install.slug,
        text:
          `${name} ${install.version} is modified locally: its files have changed since it was ` +
          `installed from ${from}, so they no longer match its install record.`,
      });
    }
    if (catalogue && install.source !== catalogue) {
      notices.push({
        type: "elsewhere",
        kind: install.kind,
        slug: install.slug,
        text: `${name} was installed from ${from}, so it isn't checked here.`,
      });
    }
  }

  notices.sort((a, b) => ORDER[a.type] - ORDER[b.type]);
  return {
    notices,
    status: host && fromHere.length > 0 ? statusLine(enabled, state, host, now) : null,
  };
}
