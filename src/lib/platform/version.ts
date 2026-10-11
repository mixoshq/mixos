/* This Source Code Form is subject to the terms of the Mozilla Public
 * License, v. 2.0. If a copy of the MPL was not distributed with this
 * file, You can obtain one at https://mozilla.org/MPL/2.0/. */

/**
 * What version of MixOS is this, and is it new enough?
 *
 * ── WHY THIS IS NOT A SEMVER DEPENDENCY ─────────────────────────────────────
 *
 * `requiresMixOS` is documented, and rendered to admins, as a FLOOR: the
 * register dialog says "Requires MixOS X or newer". A floor needs a comparison,
 * not a range grammar — and a range grammar is a promise that `^`, `~`, `||`,
 * pre-release precedence and build metadata all behave the way npm does, which
 * is a much larger promise than this field has ever made. Publishers writing
 * `>=0.4` and expecting caret semantics is a worse failure than publishers being
 * told plainly that the field is a minimum.
 *
 * So: `X.Y.Z`, compared numerically, with an optional leading `v`, an optional
 * `>=` that is accepted and ignored because it means what the field already
 * means, and any pre-release or build suffix dropped. Anything else is
 * unparseable and is treated as unknown — see `satisfiesMinimum`.
 *
 * ── THE VERSION IS STAMPED, FROM ONE SOURCE ─────────────────────────────────
 *
 * The version is `package.json`'s. The registry generator stamps it into
 * `src/generated/build-info.ts` as `MIXOS_VERSION`, and every build runs the
 * generator (`prebuild`; the Dockerfile runs `npm run build`), so every host
 * and every checkout knows its version. It is stable for a given checkout, so
 * `predev` rewrites an identical file.
 *
 * No environment variable overrides it. Two sources for one fact drift apart,
 * and `package.json` is the one that is in every build context.
 *
 * A checkout of unreleased work carries the last release's number, so an
 * extension whose floor is newer is refused there too. To try one, bump
 * `package.json` locally, and don't commit it: only a release PR changes the
 * version, and `/mixos deploy` leaves the bump out.
 *
 * ── THE COMMIT IS READ AT RUNTIME ───────────────────────────────────────────
 *
 * The build cannot reliably know it: .dockerignore keeps .git out of the image's
 * build context, and a SHA in the generated file would change on every commit
 * and make `predev` rewrite it each time. So it comes from the environment,
 * where each host names it differently — see `mixosCommit`.
 *
 * Read inside functions rather than at module scope: `next build` loads server
 * modules to collect page data, and nothing in this project may require an
 * environment variable to be present for that to work.
 */

import { EXPECTED_SCHEMA_VERSION, MIXOS_VERSION } from "@/generated/build-info";

export { EXPECTED_SCHEMA_VERSION };

/** The release this code is, e.g. `"0.4.2"`: `package.json`'s version, stamped at build time. */
export function mixosVersion(): string {
  return MIXOS_VERSION;
}

/**
 * Where the commit can come from, in order.
 *
 *   - `MIXOS_COMMIT`: the Docker image's build argument, which
 *     deploy/docker-compose.yml passes from the shell (Coolify maps its own
 *     `SOURCE_COMMIT` to it). The image sets it to an empty string when the
 *     build passed none.
 *   - `VERCEL_GIT_COMMIT_SHA`, `RENDER_GIT_COMMIT`, `RAILWAY_GIT_COMMIT_SHA`:
 *     what those hosts set on a deployment built from git.
 */
const COMMIT_VARIABLES = [
  "MIXOS_COMMIT",
  "VERCEL_GIT_COMMIT_SHA",
  "RENDER_GIT_COMMIT",
  "RAILWAY_GIT_COMMIT_SHA",
] as const;

/** A full SHA-1, or an abbreviation of one. */
const COMMIT_SHA = /^[0-9a-f]{7,40}$/i;

/**
 * The commit this deployment was built from, or null when nothing names one.
 *
 * The first variable that holds a commit SHA, not the first that is set. Render
 * and Railway build the image without an argument, so it carries an empty
 * `MIXOS_COMMIT`, and stopping at the first value that is set would never reach
 * their own variables. A value that is not a SHA is passed over the same way.
 */
export function mixosCommit(
  env: Readonly<Record<string, string | undefined>> = process.env,
): string | null {
  for (const name of COMMIT_VARIABLES) {
    const raw = (env[name] ?? "").trim();
    if (COMMIT_SHA.test(raw)) return raw.toLowerCase();
  }
  return null;
}

/** A parsed `X.Y.Z`. Missing minor/patch read as 0, so "1" is "1.0.0". */
interface Parsed {
  major: number;
  minor: number;
  patch: number;
}

/**
 * Parse a version string, or null if it is not one.
 *
 * Accepts `1`, `1.2`, `1.2.3`, `v1.2.3`, `>=1.2.3`, `1.2.3-beta.1`, `1.2.3+abc`.
 */
export function parseVersion(raw: string): Parsed | null {
  const cleaned = raw
    .trim()
    .replace(/^[>=~^\s]+/, "")
    .replace(/^v/i, "")
    // Drop pre-release and build metadata: this comparison is coarse by design,
    // and ranking `1.2.3-rc.1` against `1.2.3` is precisely the semver subtlety
    // the doc comment above declines to take on.
    .replace(/[-+].*$/, "");

  const m = /^(\d+)(?:\.(\d+))?(?:\.(\d+))?$/.exec(cleaned);
  if (!m) return null;

  return {
    major: Number(m[1]),
    minor: Number(m[2] ?? 0),
    patch: Number(m[3] ?? 0),
  };
}

/** -1, 0 or 1. Both arguments must already be parsed. */
function compare(a: Parsed, b: Parsed): number {
  if (a.major !== b.major) return a.major < b.major ? -1 : 1;
  if (a.minor !== b.minor) return a.minor < b.minor ? -1 : 1;
  if (a.patch !== b.patch) return a.patch < b.patch ? -1 : 1;
  return 0;
}

export interface MinimumCheck {
  /** Whether the caller may proceed. A floor that cannot be compared allows. */
  allowed: boolean;
  /** True only when both sides parsed and the comparison actually happened. */
  checked: boolean;
  /** Present when `allowed` is false, or when `checked` is false and the caller should say why. */
  reason?: string;
}

/**
 * Is this instance at or above `required`?
 *
 * Three outcomes:
 *
 *   - Both sides parse and the instance is new enough → allowed, checked.
 *   - The floor is not a version → allowed, NOT checked, with a reason. The
 *     caller decides whether to surface it; nothing is blocked over a field
 *     this code cannot read.
 *   - Both sides parse and the instance is too old → refused, with a message
 *     naming both versions, because "incompatible" without the numbers sends
 *     the reader to the changelog to work out what this function already knew.
 */
export function satisfiesMinimum(
  // Nullable because the repository sends an absent requirement as an explicit
  // `null`, the same way it does for `subpath`.
  required: string | null | undefined,
  // This build's stamped version unless a caller compares another.
  current: string = mixosVersion(),
): MinimumCheck {
  if (!required || !required.trim()) {
    return { allowed: true, checked: false };
  }

  const want = parseVersion(required);
  if (!want) {
    return {
      allowed: true,
      checked: false,
      reason:
        `The listing declares "requires MixOS ${required}", which is not a ` +
        `version this instance can compare against. It was not enforced.`,
    };
  }

  // The generator refuses a `package.json` version it cannot parse, so a build's
  // own version always gets past this; a caller's argument might not.
  const have = parseVersion(current);
  if (!have) {
    return {
      allowed: true,
      checked: false,
      reason:
        `The listing requires MixOS ${required} or newer, but this instance ` +
        `reports version "${current}", which could not be parsed. The ` +
        `requirement was not enforced.`,
    };
  }

  if (compare(have, want) < 0) {
    return {
      allowed: false,
      checked: true,
      reason:
        `This instance is running MixOS ${current}, and this release requires ` +
        `${required} or newer. Update MixOS before registering it — installing ` +
        `it now would put code on this instance that expects platform features ` +
        `it does not have.`,
    };
  }

  return { allowed: true, checked: true };
}

/**
 * The build as admins see it: `MixOS 0.4.2 · commit 3e1f0a2`, or
 * `commit unknown` when no source names one.
 *
 * Admin pages only. Nothing unauthenticated reports the version or the commit
 * (docs/security-architecture.md §18).
 */
export function describeBuild(
  version: string = mixosVersion(),
  commit: string | null = mixosCommit(),
): string {
  return `MixOS ${version} · commit ${commit ? commit.slice(0, 7) : "unknown"}`;
}
