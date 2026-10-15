/* This Source Code Form is subject to the terms of the Mozilla Public
 * License, v. 2.0. If a copy of the MPL was not distributed with this
 * file, You can obtain one at https://mozilla.org/MPL/2.0/. */

/**
 * The release check's rules, with no I/O: which release counts on each
 * channel, the notice's words and links, the schedule, and the status line.
 * ./release-check.integration.test.ts runs the check against a database and a
 * catalogue; src/components/admin/release-notice.test.ts renders the notice.
 */

import { describe, test } from "node:test";
import assert from "node:assert/strict";
import type { CoreRelease } from "@/lib/repository/types";
import { CHECK_EVERY_MS, CHECK_JITTER_MS, LONGEST_WAIT_MS } from "@/lib/repository/updates";
import {
  UPGRADE_GUIDE_URL,
  afterReleaseCheck,
  afterReleaseCheckFailure,
  describeRelease,
  describeReleaseCheck,
  latestOnChannel,
  parseReleaseCheckState,
  releaseCheckIsDue,
  releasePageUrl,
  releaseStatusLine,
  type ReleaseCheckState,
} from "./releases";

const MINUTE = 60_000;
const HOUR = 60 * MINUTE;
/** Midday, so the dates read the same in any time zone the tests run in. */
const T0 = new Date("2026-10-05T12:00:00Z");
const after = (ms: number, from: Date = T0) => new Date(from.getTime() + ms);

function release(tag: string, over: Partial<CoreRelease> = {}): CoreRelease {
  return {
    tag,
    commitSha: "9f2b4c1d8e7b6a5f4e3d2c1b0a9f8e7d6c5b4a39",
    publishedAt: "2026-10-01T09:00:00Z",
    prerelease: tag.includes("-"),
    notes: `### Fixes\n\n- the notes for ${tag}`,
    ...over,
  };
}

// ── which release ───────────────────────────────────────────────────────────

describe("which release counts", () => {
  // Out of order on purpose: the newest is worked out, not taken from the top.
  const list = [
    release("v0.4.2"),
    release("v0.5.0-rc.2"),
    release("v0.4.10"),
    release("v0.5.0-rc.10"),
    release("v0.4.9"),
  ];

  test("on stable, the newest release by semver; prereleases are left out", () => {
    assert.equal(latestOnChannel(list, "stable")?.tag, "v0.4.10");
  });

  test("on prerelease, prereleases count, in semver order", () => {
    assert.equal(latestOnChannel(list, "prerelease")?.tag, "v0.5.0-rc.10");
    assert.equal(latestOnChannel([...list, release("v0.5.0")], "prerelease")?.tag, "v0.5.0");
  });

  test("on stable, a release marked as a prerelease, or with a suffix, is left out either way", () => {
    const marked = release("v0.6.0", { prerelease: true });
    const suffixed = release("v0.7.0-beta.1", { prerelease: false });
    assert.equal(latestOnChannel([...list, marked, suffixed], "stable")?.tag, "v0.4.10");
    assert.equal(latestOnChannel([...list, marked, suffixed], "prerelease")?.tag, "v0.7.0-beta.1");
  });

  test("nothing on the channel, or no list: none", () => {
    assert.equal(latestOnChannel([release("v0.5.0-rc.1")], "stable"), null);
    assert.equal(latestOnChannel([], "prerelease"), null);
  });
});

// ── what admins are told ────────────────────────────────────────────────────

describe("the notice", () => {
  const notice = (tag: string, current: string, over: Partial<CoreRelease> = {}, channel: "stable" | "prerelease" = "prerelease") =>
    describeRelease(release(tag, over), channel, current);

  test("a minor release under 0.x may need changes, as the bump rule makes one", () => {
    assert.deepEqual(notice("v0.5.0", "0.4.2", {}, "stable"), {
      tag: "v0.5.0",
      commitSha: "9f2b4c1d8e7b6a5f4e3d2c1b0a9f8e7d6c5b4a39",
      text: "MixOS 0.5.0 is available (this instance runs 0.4.2). A minor release: it may need changes.",
      notes: "### Fixes\n\n- the notes for v0.5.0",
      releaseUrl: "https://mixos.org/docs/releases/v0.5.0",
      upgradeUrl: "https://mixos.org/docs/install/after-you-install/upgrading",
    });
  });

  test("major, minor and patch, in words", () => {
    assert.equal(notice("v0.4.3", "0.4.2")?.text, "MixOS 0.4.3 is available (this instance runs 0.4.2). A patch release: fixes.");
    assert.equal(notice("v1.0.0", "0.4.2")?.text, "MixOS 1.0.0 is available (this instance runs 0.4.2). A major release: it may need changes.");
    assert.equal(notice("v2.0.0", "1.4.2")?.text, "MixOS 2.0.0 is available (this instance runs 1.4.2). A major release: it may need changes.");
    // Past 0.x a minor release is semver's: new features, nothing removed.
    assert.equal(notice("v1.5.0", "1.4.2")?.text, "MixOS 1.5.0 is available (this instance runs 1.4.2). A minor release: new features.");
    assert.equal(notice("v1.4.3", "1.4.2")?.text, "MixOS 1.4.3 is available (this instance runs 1.4.2). A patch release: fixes.");
  });

  test("a prerelease says so, and a step within one names the version", () => {
    assert.equal(
      notice("v0.5.0-rc.1", "0.4.2")?.text,
      "MixOS 0.5.0-rc.1 is available (this instance runs 0.4.2). A minor release: it may need changes. " +
        "It's a prerelease, for trying it before it's final.",
    );
    assert.equal(notice("v0.5.0", "0.5.0-rc.1")?.text, "MixOS 0.5.0 is available (this instance runs 0.5.0-rc.1). The final release of 0.5.0.");
    assert.equal(
      notice("v0.5.0-rc.2", "0.5.0-rc.1")?.text,
      "MixOS 0.5.0-rc.2 is available (this instance runs 0.5.0-rc.1). A later prerelease of 0.5.0.",
    );
  });

  test("the same release, an older one, or one this build can't compare with: no notice", () => {
    assert.equal(notice("v0.4.2", "0.4.2"), null);
    assert.equal(notice("v0.4.1", "0.4.2"), null);
    assert.equal(notice("v0.5.0-rc.1", "0.5.0"), null);
    assert.equal(notice("v0.5.0", "main"), null);
    assert.equal(describeRelease(null, "stable", "0.4.2"), null);
  });

  test("a prerelease kept from the prerelease channel shows nothing on stable", () => {
    assert.equal(notice("v0.5.0-rc.1", "0.4.2", {}, "stable"), null);
    assert.equal(notice("v0.5.0", "0.4.2", { prerelease: true }, "stable"), null);
  });

  test("both links are built here, from the tag, and nothing in the answer becomes one", () => {
    const n = notice("v0.5.0-rc.1", "0.4.2", { notes: "See https://evil.example/upgrade and [this](https://evil.example/)" });
    assert.equal(n?.releaseUrl, "https://mixos.org/docs/releases/v0.5.0-rc.1");
    assert.equal(n?.upgradeUrl, UPGRADE_GUIDE_URL);
    assert.equal(UPGRADE_GUIDE_URL, "https://mixos.org/docs/install/after-you-install/upgrading");
    for (const bad of ["v0.5", "../../admin", "v1.0.0/../../x", "https://evil.example/v1.0.0", "1.0.0"]) {
      assert.equal(releasePageUrl(bad), null, bad);
    }
  });
});

// ── what is kept, and when ──────────────────────────────────────────────────

describe("the stored state", () => {
  test("round trips, and a value that isn't one is never checked", () => {
    const state = afterReleaseCheck([release("v0.5.0")], "stable", T0, () => 0.5);
    assert.deepEqual(parseReleaseCheckState(JSON.stringify(state)), state);
    for (const text of [null, "", "not json", "{}", JSON.stringify({ ...state, channel: "beta" })]) {
      assert.equal(parseReleaseCheckState(text), null, String(text));
    }
  });

  test("a stored release whose tag isn't one is refused, so no link is built from it", () => {
    const state = afterReleaseCheck([release("v0.5.0")], "stable", T0, () => 0.5);
    for (const tag of ["v0.5.0/../../admin", "javascript:alert(1)", "v05.0.0", "v0.5.0 "]) {
      const tampered = JSON.stringify({ ...state, latest: { ...state.latest, tag } });
      assert.equal(parseReleaseCheckState(tampered), null, tag);
    }
  });

  test("a check keeps the newest release on its channel, whether or not it is newer than this build", () => {
    const list = [release("v0.1.0"), release("v0.2.0-rc.1")];
    const stable = afterReleaseCheck(list, "stable", T0, () => 0);
    assert.equal(stable.channel, "stable");
    assert.equal(stable.latest?.tag, "v0.1.0");
    assert.equal(afterReleaseCheck(list, "prerelease", T0, () => 0).latest?.tag, "v0.2.0-rc.1");
    assert.equal(afterReleaseCheck([], "stable", T0, () => 0).latest, null);
  });
});

describe("scheduling", () => {
  const checked = (random: number, at: Date = T0) => afterReleaseCheck([release("v0.5.0")], "stable", at, () => random);

  /** The first tick, every `every` ms from `from`, at which a check is due. */
  function firstDue(state: ReleaseCheckState, every: number, from: Date = T0): number {
    for (let t = every; t <= 3 * 24 * HOUR; t += every) {
      if (releaseCheckIsDue(state, "stable", after(t, from))) return t;
    }
    return Infinity;
  }

  test("due with no state", () => {
    assert.equal(releaseCheckIsDue(null, "stable", T0), true);
  });

  test("after a success: 21 hours plus up to an hour", () => {
    for (const random of [0, 0.5, 0.999999]) {
      const state = checked(random);
      const next = Date.parse(state.nextCheckAt ?? "");
      assert.ok(next >= T0.getTime() + CHECK_EVERY_MS && next < T0.getTime() + CHECK_EVERY_MS + CHECK_JITTER_MS);
      assert.equal(releaseCheckIsDue(state, "stable", after(CHECK_EVERY_MS - MINUTE)), false);
      assert.equal(releaseCheckIsDue(state, "stable", after(CHECK_EVERY_MS + CHECK_JITTER_MS)), true);
      assert.equal(state.lastSuccessAt, T0.toISOString());
      assert.equal(state.lastError, null);
    }
  });

  test("with a 5-minute tick the first due one is 21 to 22 hours on; a daily tick, 23 hours on as on Vercel Hobby, checks", () => {
    for (const random of [0, 0.25, 0.5, 0.999999]) {
      const t = firstDue(checked(random), 5 * MINUTE);
      assert.ok(t >= 21 * HOUR && t <= 22 * HOUR, `${random}: ${t / HOUR} hours`);
      assert.equal(firstDue(checked(random), 24 * HOUR), 24 * HOUR);
      assert.equal(releaseCheckIsDue(checked(random), "stable", after(23 * HOUR)), true);
    }
  });

  test("after a failure: the last answer kept, and an hour's wait", () => {
    const good = checked(0.5);
    const failedAt = after(30 * HOUR);
    const failed = afterReleaseCheckFailure(good, "stable", "Could not reach https://mixos.org: fetch failed", undefined, failedAt);
    assert.deepEqual(failed.latest, good.latest);
    assert.equal(failed.channel, "stable");
    assert.equal(failed.lastSuccessAt, good.lastSuccessAt);
    assert.equal(failed.lastAttemptAt, failedAt.toISOString());
    assert.equal(failed.lastError, "Could not reach https://mixos.org: fetch failed");
    assert.equal(firstDue(failed, 5 * MINUTE, failedAt), HOUR);

    const first = afterReleaseCheckFailure(null, "prerelease", "The repository answered 500 for /api/v1/mixos/releases.", undefined, T0);
    assert.deepEqual([first.channel, first.latest, first.lastSuccessAt], ["prerelease", null, null]);
  });

  test("after a failure with Retry-After: that long, but never more than a day", () => {
    const wait = (seconds: number | undefined) =>
      Date.parse(afterReleaseCheckFailure(null, "stable", "The repository answered 429.", seconds, T0).nextCheckAt ?? "") - T0.getTime();
    assert.equal(wait(7200), 2 * HOUR);
    assert.equal(wait(90), 90_000);
    assert.equal(wait(10 * 24 * 3600), LONGEST_WAIT_MS);
    assert.equal(wait(undefined), HOUR);
  });

  test("a changed channel is due at once, unless a failure's wait holds", () => {
    const good = checked(0.5);
    assert.equal(releaseCheckIsDue(good, "stable", after(5 * MINUTE)), false);
    assert.equal(releaseCheckIsDue(good, "prerelease", after(5 * MINUTE)), true);

    const failed = afterReleaseCheckFailure(good, "prerelease", "The repository answered 503.", 7200, after(HOUR));
    assert.equal(failed.channel, "stable");
    assert.equal(releaseCheckIsDue(failed, "prerelease", after(HOUR + 5 * MINUTE)), false);
    assert.equal(releaseCheckIsDue(failed, "prerelease", after(3 * HOUR)), true);
  });

  test("a stored schedule further away than any this writes is due", () => {
    const far = { ...checked(0.5), nextCheckAt: after(LONGEST_WAIT_MS + HOUR).toISOString() };
    assert.equal(releaseCheckIsDue(far, "stable", T0), true);
  });
});

// ── the status line ─────────────────────────────────────────────────────────

describe("the status line", () => {
  test("off, not checked yet, checked on each channel, and couldn't reach", () => {
    const good = afterReleaseCheck([release("v0.5.0")], "stable", T0, () => 0);
    const line = (enabled: boolean, state: ReleaseCheckState | null, at: Date, channel: "stable" | "prerelease" = "stable") =>
      releaseStatusLine(enabled, state, channel, "mixos.org", at);

    assert.equal(line(false, good, T0), "Release checks are off (MIXOS_UPDATE_CHECK).");
    assert.equal(line(true, null, T0), "Not checked for new releases yet.");
    assert.equal(line(true, good, after(3 * HOUR)), "Checked mixos.org for new releases 3 hours ago.");
    assert.equal(line(true, good, after(20_000)), "Checked mixos.org for new releases just now.");
    assert.equal(line(true, good, after(3 * HOUR), "prerelease"), "Checked mixos.org for new releases and prereleases 3 hours ago.");

    const failed = afterReleaseCheckFailure(good, "stable", "fetch failed", undefined, after(30 * HOUR));
    assert.equal(line(true, failed, after(31 * HOUR)), "Couldn't reach mixos.org for new releases since 5 Oct.");
    const never = afterReleaseCheckFailure(null, "stable", "fetch failed", undefined, T0);
    assert.equal(line(true, never, after(HOUR)), "Not checked for new releases yet: couldn't reach mixos.org.");
  });

  test("with checks off, no answer shows, whatever was kept; with no catalogue, no line", () => {
    const state = afterReleaseCheck([release("v0.5.0")], "stable", T0, () => 0);
    const input = { enabled: true, channel: "stable" as const, state, current: "0.4.2", host: "mixos.org", now: after(HOUR) };
    assert.equal(describeReleaseCheck(input).notice?.tag, "v0.5.0");
    assert.equal(describeReleaseCheck(input).status, "Checked mixos.org for new releases 1 hour ago.");
    assert.deepEqual(describeReleaseCheck({ ...input, enabled: false }), {
      notice: null,
      status: "Release checks are off (MIXOS_UPDATE_CHECK).",
    });
    assert.equal(describeReleaseCheck({ ...input, host: null }).status, null);
    assert.equal(describeReleaseCheck({ ...input, current: "0.5.0" }).notice, null);
  });
});
