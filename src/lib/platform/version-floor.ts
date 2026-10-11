/* This Source Code Form is subject to the terms of the Mozilla Public
 * License, v. 2.0. If a copy of the MPL was not distributed with this
 * file, You can obtain one at https://mozilla.org/MPL/2.0/. */

/**
 * A release's `requiresMixOS`, the oldest MixOS it runs on, against a
 * version: the comparison, and the words the dialogs use for it.
 *
 * It reads no build stamp, unlike ./version.ts, for two readers that can't
 * import that file. The registry generator writes the stamp, and checks every
 * install's floor against the version it stamps. The install and review
 * dialogs are client components, and this build's version must not go into
 * a bundle anyone can download (docs/security-architecture.md §18), so they
 * get a verdict from the server and word it with describeFloor().
 *
 * Install, Register and every build compare a floor the same way, with
 * checkFloor() (D15 in docs/plans/20261008_2300-extension-lifecycle.md).
 *
 * ── WHY THIS IS NOT A SEMVER DEPENDENCY ─────────────────────────────────────
 *
 * `requiresMixOS` is documented, and rendered to admins, as a FLOOR: the
 * dialogs say "Requires MixOS X or newer". A floor needs a comparison, not a
 * range grammar — and a range grammar is a promise that `^`, `~`, `||`,
 * pre-release precedence and build metadata all behave the way npm does, which
 * is a much larger promise than this field has ever made. Publishers writing
 * `>=0.4` and expecting caret semantics is a worse failure than publishers being
 * told plainly that the field is a minimum.
 *
 * So: `X.Y.Z`, compared numerically, with an optional leading `v`, an optional
 * `>=` that is accepted and ignored because it means what the field already
 * means, and any pre-release or build suffix dropped. Anything else is
 * unparseable and is treated as unknown — see `checkFloor`.
 */

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
 * Is `current` at or above `required`?
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
export function checkFloor(
  // Nullable because the repository sends an absent requirement as an explicit
  // `null`, the same way it does for `subpath`.
  required: string | null | undefined,
  current: string,
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
 * A release's floor against this build's version, worked out on the server
 * (floorVerdict() in ./version.ts) and shown by a dialog.
 */
export interface FloorVerdict {
  /** The floor as the release declares it, or null for none. */
  declared: string | null;
  /** This build's version, which it was compared with. */
  current: string;
  /** What runs that version: a checkout, or a built deployment. */
  where: "checkout" | "deployment";
  /** False when install and Register refuse it, and a build that carries it fails. */
  met: boolean;
  /** Whether a comparison happened: false for no floor, or one that isn't a version. */
  checked: boolean;
  reason: string | null;
}

/**
 * The verdict as the install and review dialogs say it, for example
 * "Requires MixOS 0.2.0 or newer. This checkout runs 0.1.0, which doesn't
 * meet it." The update dialog should say it the same way, for the release it
 * would update to.
 */
export function describeFloor(floor: FloorVerdict): string {
  const here = `This ${floor.where} runs ${floor.current}`;
  if (!floor.declared) return `No minimum MixOS version. ${here}.`;
  if (!floor.checked) {
    // Only a version a build didn't stamp fails to parse: the generator
    // refuses any other.
    return parseVersion(floor.declared)
      ? `Requires MixOS ${floor.declared} or newer. This ${floor.where} runs "${floor.current}", which isn't a version, so it isn't checked.`
      : `Its minimum MixOS version, "${floor.declared}", isn't a version, so it isn't checked. ${here}.`;
  }
  return `Requires MixOS ${floor.declared} or newer. ${here}, which ${floor.met ? "meets" : "doesn't meet"} it.`;
}
