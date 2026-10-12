/* This Source Code Form is subject to the terms of the Mozilla Public
 * License, v. 2.0. If a copy of the MPL was not distributed with this
 * file, You can obtain one at https://mozilla.org/MPL/2.0/. */

/**
 * What version of MixOS is this, and is it new enough?
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
 * ── NEW ENOUGH: A RELEASE'S FLOOR ───────────────────────────────────────────
 *
 * A release may declare `requiresMixOS`, the oldest MixOS it runs on. Install
 * and Register refuse one whose floor is above this version, and the build
 * fails on an installed one whose `.registry.json` says so (the registry
 * generator). All three compare it with checkFloor() in ./version-floor.ts,
 * which reads no stamp; this file supplies the stamped version.
 *
 * A checkout of unreleased work carries the last release's number, so an
 * extension whose floor is newer is refused there too, and a build that
 * carries one fails. To try one, bump `package.json` locally, and don't commit
 * it: only a release PR changes the version, and `/mixos deploy` leaves the
 * bump out.
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
import { isBuiltDeployment } from "./build";
import {
  checkFloor,
  compareRelease,
  type FloorVerdict,
  type MinimumCheck,
  type ReleaseComparison,
} from "./version-floor";

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

/**
 * Is this build at or above `required`? checkFloor() (./version-floor.ts),
 * against this build's stamped version unless a caller compares another.
 */
export function satisfiesMinimum(
  required: string | null | undefined,
  current: string = mixosVersion(),
): MinimumCheck {
  return checkFloor(required, current);
}

/**
 * A release of MixOS, such as the tag `v0.5.0`, against this build: older, the
 * same, or newer and how big a step (`compareRelease()` in ./version-floor.ts).
 * Compared in full, so a prerelease of this version is older and its final
 * release newer. Null when the tag, or this build's version, isn't a version.
 */
export function compareWithThisBuild(
  tag: string,
  current: string = mixosVersion(),
): ReleaseComparison | null {
  return compareRelease(tag, current);
}

/**
 * A release's floor against this build, for a dialog to show with
 * describeFloor() (./version-floor.ts). Worked out here, on the server, so a
 * client component never needs the version itself.
 */
export function floorVerdict(
  required: string | null | undefined,
  current: string = mixosVersion(),
): FloorVerdict {
  const check = checkFloor(required, current);
  return {
    declared: required && required.trim() ? required : null,
    current,
    where: isBuiltDeployment() ? "deployment" : "checkout",
    met: check.allowed,
    checked: check.checked,
    reason: check.reason ?? null,
  };
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
