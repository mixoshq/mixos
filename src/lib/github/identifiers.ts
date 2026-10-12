/* This Source Code Form is subject to the terms of the Mozilla Public
 * License, v. 2.0. If a copy of the MPL was not distributed with this
 * file, You can obtain one at https://mozilla.org/MPL/2.0/. */

/**
 * What the GitHub link accepts as an identifier, and the one repository it
 * never links.
 *
 * Every value here ends up in a GitHub API path or a github.com link, so each
 * is checked against GitHub's own rules before it is stored, and paths are
 * built only from stored values (./api.ts, ./repository.ts).
 *
 * No imports: the page's client components read the patterns too.
 */

/**
 * Upstream MixOS, `mixoshq/mixos`, by its GitHub repository id.
 *
 * The link refuses this repository, at link time and on every operation. It is
 * compared by id and never by name: an id survives a rename and a transfer, and
 * a name can be taken by any repository once the old one moves. The repository
 * is private today, so its id can't be looked up anonymously; this is the id
 * GitHub gives it.
 */
export const UPSTREAM_REPOSITORY_ID = 1345491436;

/** Whether `id` is upstream MixOS's repository. */
export function isUpstream(id: number): boolean {
  return id === UPSTREAM_REPOSITORY_ID;
}

/** A GitHub id: a positive whole number JavaScript holds exactly. */
export function isGitHubId(value: unknown): value is number {
  return typeof value === "number" && Number.isSafeInteger(value) && value > 0;
}

/**
 * A user or organisation login: letters, digits and single hyphens, not at
 * either end, at most 39 characters. Older accounts can have a hyphen at the
 * end or two in a row, so those are accepted; nothing else is.
 */
const LOGIN = /^[A-Za-z0-9](?:[A-Za-z0-9-]{0,38})$/;

export function isLogin(value: unknown): value is string {
  return typeof value === "string" && LOGIN.test(value);
}

/** A repository name: letters, digits, `.`, `_` and `-`, at most 100, never `.` or `..`. */
const REPOSITORY_NAME = /^[A-Za-z0-9._-]{1,100}$/;

export function isRepositoryName(value: unknown): value is string {
  return typeof value === "string" && REPOSITORY_NAME.test(value) && value !== "." && value !== "..";
}

/** An App's slug, as GitHub derives it from the App's name: lower case, digits and hyphens. */
const APP_SLUG = /^[a-z0-9](?:[a-z0-9-]{0,99})$/;

export function isAppSlug(value: unknown): value is string {
  return typeof value === "string" && APP_SLUG.test(value);
}

/**
 * A branch name, as git's ref rules allow it, narrowed to what a default
 * branch reasonably is: printable ASCII without spaces or the characters git
 * forbids, no `..`, no empty or dot-led segment, not ending in `.lock` or `/`.
 * A stranger name is refused rather than escaped into a path.
 */
export function isBranchName(value: unknown): value is string {
  if (typeof value !== "string" || value.length === 0 || value.length > 255) return false;
  if (!/^[A-Za-z0-9._\/-]+$/.test(value)) return false;
  if (value.includes("..") || value.includes("//") || value.endsWith("/") || value.endsWith(".lock")) {
    return false;
  }
  if (value.startsWith("-")) return false;
  return value.split("/").every((segment) => segment.length > 0 && !segment.startsWith("."));
}

/**
 * The code GitHub hands back after an App is created from a manifest, to
 * exchange for the App. A query parameter, so the one value from a request that
 * reaches an API path: it is checked here and percent-encoded there.
 */
const MANIFEST_CODE = /^[A-Za-z0-9_-]{8,128}$/;

export function isManifestCode(value: unknown): value is string {
  return typeof value === "string" && MANIFEST_CODE.test(value);
}

/** An App's name as GitHub allows it: 1 to 34 characters, none of them control or bidi characters. */
export function isAppName(value: unknown): value is string {
  if (typeof value !== "string") return false;
  const trimmed = value.trim();
  if (trimmed.length === 0 || trimmed.length > 34 || trimmed !== value) return false;
  return !/[\u0000-\u001f\u007f-\u009f\u200e\u200f\u202a-\u202e\u2066-\u2069]/.test(value);
}
