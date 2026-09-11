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
 * ── UNKNOWN IS NOT A FAILURE ────────────────────────────────────────────────
 *
 * The version is null outside a tagged build, which is every developer checkout
 * and every non-release CI run. Refusing installs there would make the gate's
 * first effect "nothing can be installed in development", which is how a safety
 * check gets an escape hatch bolted on and then left open. Unknown resolves to
 * `allowed: true` with a reason the caller can surface.
 *
 * ── WHY THIS READS THE ENVIRONMENT AND NOT A GENERATED CONSTANT ─────────────
 *
 * `MIXOS_RELEASE` already exists, already carries the tag, and is already the
 * thing `src/lib/repository/client.ts` uses to decide whether this is a release
 * build. It is stamped into the RUNNER stage of the image. Generating a second
 * copy at build time would put the authoritative value and a stale duplicate of
 * it in two files — and the duplicate would be the stale one, because the
 * builder stage never sees the runner stage's ARG.
 *
 * Read inside functions rather than at module scope: `next build` loads server
 * modules to collect page data, and nothing in this project may require an
 * environment variable to be present for that to work.
 */

import { EXPECTED_SCHEMA_VERSION } from "@/generated/build-info";

export { EXPECTED_SCHEMA_VERSION };

/**
 * The release this instance is running, e.g. `"0.4.2"`, or null when this is
 * not a tagged build.
 *
 * Normalised off the `vX.Y.Z` tag form that `MIXOS_RELEASE` carries, because
 * every manifest and every comparison in the codebase speaks `X.Y.Z`.
 */
export function mixosVersion(): string | null {
  const raw = (process.env.MIXOS_RELEASE ?? "").trim();
  if (!raw) return null;
  return raw.replace(/^v/i, "");
}

/** The commit this image was built from, when the build supplied one. */
export function mixosCommit(): string | null {
  const raw = (process.env.MIXOS_COMMIT ?? "").trim();
  return /^[0-9a-f]{7,40}$/i.test(raw) ? raw.toLowerCase() : null;
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
  /** Whether the caller may proceed. Unknown versions allow. */
  allowed: boolean;
  /** True only when both sides parsed and the comparison actually happened. */
  checked: boolean;
  /** Present when `allowed` is false, or when `checked` is false and the caller should say why. */
  reason?: string;
}

/**
 * Is this instance at or above `required`?
 *
 * Three outcomes, and the middle one is the interesting one:
 *
 *   - Both sides parse and the instance is new enough → allowed, checked.
 *   - Either side is unknown or unparseable → allowed, NOT checked, with a
 *     reason. The caller decides whether to surface it; nothing is blocked.
 *   - Both sides parse and the instance is too old → refused, with a message
 *     naming both versions, because "incompatible" without the numbers sends
 *     the reader to the changelog to work out what this function already knew.
 */
export function satisfiesMinimum(
  // Nullable because the repository sends an absent requirement as an explicit
  // `null`, the same way it does for `subpath`.
  required: string | null | undefined,
  // A default expression, not a module constant: it must be evaluated per call
  // so that the environment is read at request time rather than at import time.
  current: string | null = mixosVersion(),
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

  if (!current) {
    return {
      allowed: true,
      checked: false,
      reason:
        `The listing requires MixOS ${required} or newer. This build is not a ` +
        `tagged release, so it has no version to compare and the requirement ` +
        `was not enforced.`,
    };
  }

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

/** Short, human-facing build identity. Used in admin surfaces and diagnostics. */
export function describeBuild(): string {
  const version = mixosVersion() ?? "untagged build";
  const commit = mixosCommit();
  return commit ? `${version} (${commit.slice(0, 12)})` : version;
}
