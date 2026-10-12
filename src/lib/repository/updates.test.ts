/* This Source Code Form is subject to the terms of the Mozilla Public
 * License, v. 2.0. If a copy of the MPL was not distributed with this
 * file, You can obtain one at https://mozilla.org/MPL/2.0/. */

import { describe, test } from "node:test";
import assert from "node:assert/strict";
import type { RegistryInstall } from "./install-record";
import type { ExtensionKind, UpdateItem, UpdateResult } from "./types";
import {
  CHECK_EVERY_MS,
  CHECK_JITTER_MS,
  LONGEST_WAIT_MS,
  MAX_REASON_LENGTH,
  afterFailure,
  afterSuccess,
  checkIsDue,
  cleanReason,
  describeUpdate,
  itemsToCheck,
  keepAnswersFor,
  parseUpdateCheckState,
  registryNotices,
  statusLine,
  type StoredResult,
  type UpdateCheckState,
} from "./updates";

const CATALOGUE = "https://mixos.org";
const MINUTE = 60_000;
const HOUR = 60 * MINUTE;
/** Midday, so the dates read the same in any time zone the tests run in. */
const T0 = new Date("2026-10-05T12:00:00Z");
const after = (ms: number, from: Date = T0) => new Date(from.getTime() + ms);

function install(
  kind: ExtensionKind,
  slug: string,
  version: string,
  { source = CATALOGUE, modified = false }: { source?: string; modified?: boolean } = {},
): RegistryInstall {
  return {
    kind,
    slug,
    version,
    gitTag: null,
    commitSha: "a".repeat(40),
    source,
    repository: { owner: "acme", name: `mixos-${slug}`, subpath: null },
    requiresMixOS: null,
    modified,
  };
}

/** mixos.org's answer for one item, as the client parses it. */
function answer(item: UpdateItem, over: Partial<UpdateResult> = {}): UpdateResult {
  return {
    kind: item.kind,
    slug: item.slug,
    listingStatus: "published",
    installedVersion: item.version,
    installedYanked: false,
    installedYankedReason: null,
    latestVersion: item.version,
    latestReleasedAt: "2026-09-30T12:00:00+00:00",
    latestRequiresMixOS: null,
    differsFromInstalled: false,
    ...over,
  };
}

function result(over: Partial<StoredResult> = {}): StoredResult {
  return {
    kind: "app",
    slug: "files",
    version: "1.2.0",
    listing: "published",
    withdrawn: false,
    reason: null,
    latest: "1.2.0",
    latestReleasedAt: "2026-10-02T12:00:00.000Z",
    latestRequiresMixOS: null,
    ...over,
  };
}

const describeFiles = (r: StoredResult, current = "0.8.2") =>
  describeUpdate(r, { name: "Files", host: "mixos.org", current, now: T0 })?.text ?? null;

// ── what is checked ─────────────────────────────────────────────────────────

describe("what is checked", () => {
  test("only installs from the catalogue asked, as kind, slug and version alone", () => {
    const installs = [
      install("app", "files", "1.2.0"),
      install("app", "notes", "2.0.0", { source: "http://localhost:4321" }),
      install("connector", "relay", "3e1f0a2", { modified: true }),
      install("theme", "dusk", "1.0.0"),
    ];
    const items = itemsToCheck(installs, CATALOGUE);
    assert.deepEqual(items, [
      { kind: "app", slug: "files", version: "1.2.0" },
      { kind: "connector", slug: "relay", version: "3e1f0a2" },
      { kind: "theme", slug: "dusk", version: "1.0.0" },
    ]);
    for (const item of items) assert.deepEqual(Object.keys(item), ["kind", "slug", "version"]);
    assert.deepEqual(itemsToCheck(installs, "https://staging.mixos.example"), []);
  });
});

// ── describeUpdate ──────────────────────────────────────────────────────────

describe("describeUpdate", () => {
  test("withdrawn, with the publisher's reason and the current release", () => {
    assert.equal(
      describeFiles(result({ withdrawn: true, reason: "Data loss on upgrade from 1.0.x", latest: "1.2.1" })),
      "Files 1.2.0 was withdrawn by its publisher: “Data loss on upgrade from 1.0.x”. The current release is 1.2.1.",
    );
    assert.equal(describeUpdate(result({ withdrawn: true }), { name: "Files", host: "mixos.org" })?.type, "withdrawn");
  });

  test("withdrawn, with a reason that ends its own sentence: one mark, not two", () => {
    assert.equal(
      describeFiles(result({ withdrawn: true, reason: "Corrupts the same board.", latest: "1.2.1" })),
      "Files 1.2.0 was withdrawn by its publisher: “Corrupts the same board.” The current release is 1.2.1.",
    );
    assert.equal(
      describeFiles(result({ withdrawn: true, reason: "Don't use it!", latest: null })),
      "Files 1.2.0 was withdrawn by its publisher: “Don't use it!” There is no release to move to.",
    );
    assert.equal(
      describeFiles(result({ withdrawn: true, reason: "Why was this published?", latest: "1.2.1" })),
      "Files 1.2.0 was withdrawn by its publisher: “Why was this published?” The current release is 1.2.1.",
    );
    // Any other last character still gets the full stop after the quote.
    assert.equal(
      describeFiles(result({ withdrawn: true, reason: "See the notes for 1.2.1 (the fix)", latest: "1.2.1" })),
      "Files 1.2.0 was withdrawn by its publisher: “See the notes for 1.2.1 (the fix)”. The current release is 1.2.1.",
    );
  });

  test("withdrawn, without a reason", () => {
    assert.equal(
      describeFiles(result({ withdrawn: true, latest: "1.2.1" })),
      "Files 1.2.0 was withdrawn by its publisher. The current release is 1.2.1.",
    );
  });

  test("withdrawn, with nothing to move to", () => {
    const none = "Files 1.2.0 was withdrawn by its publisher: “Unsafe”. There is no release to move to.";
    assert.equal(describeFiles(result({ withdrawn: true, reason: "Unsafe", latest: null })), none);
    // An archived listing installs nothing, whatever its last release was.
    assert.equal(describeFiles(result({ withdrawn: true, reason: "Unsafe", latest: "1.2.1", listing: "archived" })), none);
  });

  test("withdrawn, where the current release needs a newer MixOS", () => {
    assert.equal(
      describeFiles(result({ withdrawn: true, latest: "1.3.0", latestRequiresMixOS: "0.9.0" })),
      "Files 1.2.0 was withdrawn by its publisher. The current release is 1.3.0. " +
        "It needs MixOS 0.9.0 or newer; this instance runs 0.8.2.",
    );
  });

  test("a newer dotted version is available; an older or equal one says nothing", () => {
    assert.equal(
      describeFiles(result({ latest: "1.3.0" })),
      "Files 1.3.0 is available. This instance runs 1.2.0.",
    );
    assert.equal(describeUpdate(result({ latest: "1.3.0" }), { name: "Files", host: "mixos.org" })?.type, "newer");
    assert.equal(describeFiles(result({ latest: "1.10.0", version: "1.9.3" })), "Files 1.10.0 is available. This instance runs 1.9.3.");
    for (const latest of ["1.1.9", "1.2.0", "0.9.0"]) assert.equal(describeFiles(result({ latest })), null, latest);
  });

  test("commit versions are named, never called newer", () => {
    assert.equal(
      describeFiles(result({ version: "3e1f0a2", latest: "9f2b4c1" })),
      "mixos.org's current release of Files is 9f2b4c1, from 2 Oct. This instance runs 3e1f0a2.",
    );
    assert.equal(describeFiles(result({ version: "3e1f0a2", latest: "3e1f0a2" })), null);
    assert.equal(
      describeFiles(result({ version: "3e1f0a2", latest: "9f2b4c1", latestReleasedAt: null })),
      "mixos.org's current release of Files is 9f2b4c1. This instance runs 3e1f0a2.",
    );
  });

  test("an all-digit commit is not a dotted version, either way round", () => {
    assert.equal(
      describeFiles(result({ version: "1.2.0", latest: "1234567" })),
      "mixos.org's current release of Files is 1234567, from 2 Oct. This instance runs 1.2.0.",
    );
    assert.equal(
      describeFiles(result({ version: "1234567", latest: "1.0.0" })),
      "mixos.org's current release of Files is 1.0.0, from 2 Oct. This instance runs 1234567.",
    );
  });

  test("requiresMixOS: blocked, met and unknown", () => {
    assert.equal(
      describeFiles(result({ latest: "1.3.0", latestRequiresMixOS: "0.9.0" }), "0.8.2"),
      "Files 1.3.0 is available. This instance runs 1.2.0. It needs MixOS 0.9.0 or newer; this instance runs 0.8.2.",
    );
    assert.equal(
      describeFiles(result({ latest: "1.3.0", latestRequiresMixOS: "0.8.2" }), "0.8.2"),
      "Files 1.3.0 is available. This instance runs 1.2.0.",
    );
    assert.equal(
      describeFiles(result({ latest: "1.3.0", latestRequiresMixOS: "1.x" }), "0.8.2"),
      "Files 1.3.0 is available. This instance runs 1.2.0. It needs MixOS 1.x or newer.",
    );
  });

  test("a listing that is no longer published", () => {
    assert.equal(
      describeFiles(result({ listing: "archived", latest: "1.3.0" })),
      "Files is no longer listed on mixos.org: its publisher archived it. The copy here keeps running.",
    );
    assert.equal(
      describeFiles(result({ listing: "draft" })),
      "Files is no longer listed on mixos.org: its publisher unpublished it. The copy here keeps running.",
    );
    assert.equal(
      describeFiles(result({ listing: "other" })),
      "Files is no longer listed on mixos.org. The copy here keeps running.",
    );
  });
});

// ── what is kept of an answer ───────────────────────────────────────────────

describe("keepAnswersFor", () => {
  const files: UpdateItem = { kind: "app", slug: "files", version: "1.2.0" };

  test("answers for items not sent, or at another version, are ignored", () => {
    const kept = keepAnswersFor(
      [files],
      [
        answer({ kind: "app", slug: "other", version: "1.0.0" }, { installedYanked: true }),
        answer({ kind: "connector", slug: "files", version: "1.2.0" }, { installedYanked: true }),
        answer({ ...files, version: "1.1.0" }, { installedYanked: true }),
        answer(files, { latestVersion: "1.3.0" }),
      ],
    );
    assert.deepEqual(kept, [
      {
        kind: "app",
        slug: "files",
        version: "1.2.0",
        listing: "published",
        withdrawn: false,
        reason: null,
        latest: "1.3.0",
        latestReleasedAt: "2026-09-30T12:00:00.000Z",
        latestRequiresMixOS: null,
      },
    ]);
    assert.deepEqual(keepAnswersFor([files], []), []);
  });

  test("the reason is cleaned: line breaks, controls and bidi characters", () => {
    const [kept] = keepAnswersFor(
      [files],
      [answer(files, { installedYanked: true, installedYankedReason: "  Data\nloss\u0007 on\r\nupgrade \u202Efrom 1.0.x\u0000  " })],
    );
    assert.equal(kept.reason, "Data loss on upgrade from 1.0.x");
    assert.equal(cleanReason(" \n\t "), null);
    assert.equal(cleanReason(null), null);
  });

  test("the reason is capped at 500 characters, without splitting a character", () => {
    const capped = cleanReason("é".repeat(400) + "🙂".repeat(400)) ?? "";
    assert.equal(Array.from(capped).length, MAX_REASON_LENGTH);
    assert.ok(capped.endsWith("…"));
    assert.ok(!/[\uD800-\uDBFF]…$/.test(capped), "no lone surrogate before the ellipsis");
    assert.equal(cleanReason("x".repeat(MAX_REASON_LENGTH)), "x".repeat(MAX_REASON_LENGTH));
  });

  test("a reason sent for a release that isn't withdrawn is dropped", () => {
    const [kept] = keepAnswersFor([files], [answer(files, { installedYankedReason: "Not withdrawn" })]);
    assert.equal(kept.reason, null);
  });

  test("a latest version install couldn't record, a floor that isn't one and a bad date are unknown", () => {
    for (const latestVersion of ["<b>1.3.0</b>", "v1.3.0", "1.3", "latest", "1.3.0\nx"]) {
      const [kept] = keepAnswersFor([files], [answer(files, { latestVersion })]);
      assert.equal(kept.latest, null, latestVersion);
    }
    const [kept] = keepAnswersFor(
      [files],
      [answer(files, { latestVersion: "9f2b4c1", latestRequiresMixOS: "0.9.0\nrm -rf", latestReleasedAt: "yesterday", listingStatus: "deleted" })],
    );
    assert.equal(kept.latest, "9f2b4c1");
    assert.equal(kept.latestRequiresMixOS, null);
    assert.equal(kept.latestReleasedAt, null);
    assert.equal(kept.listing, "other");
  });
});

// ── when ────────────────────────────────────────────────────────────────────

describe("scheduling", () => {
  const items: UpdateItem[] = [{ kind: "app", slug: "files", version: "1.2.0" }];
  const checked = (random: number, at: Date = T0) => afterSuccess(items, [answer(items[0])], at, () => random);

  /** The first tick, every `every` ms from `from`, at which a check is due. */
  function firstDue(state: UpdateCheckState, every: number, from: Date = T0, set = items): number {
    for (let t = every; t <= 3 * 24 * HOUR; t += every) {
      if (checkIsDue(state, set, after(t, from))) return t;
    }
    return Infinity;
  }

  test("due with no state, or a stored value that doesn't parse", () => {
    assert.equal(checkIsDue(null, items, T0), true);
    assert.equal(parseUpdateCheckState("not json"), null);
    assert.equal(parseUpdateCheckState(JSON.stringify({ sent: 3 })), null);
    assert.equal(parseUpdateCheckState(null), null);
    assert.deepEqual(parseUpdateCheckState(JSON.stringify(checked(0.5))), checked(0.5));
  });

  test("after a success: 21 hours plus up to an hour", () => {
    for (const random of [0, 0.5, 0.999999]) {
      const state = checked(random);
      const next = Date.parse(state.nextCheckAt ?? "");
      assert.ok(next >= T0.getTime() + CHECK_EVERY_MS, String(random));
      assert.ok(next < T0.getTime() + CHECK_EVERY_MS + CHECK_JITTER_MS, String(random));
      assert.equal(checkIsDue(state, items, after(CHECK_EVERY_MS - MINUTE)), false, String(random));
      assert.equal(checkIsDue(state, items, after(CHECK_EVERY_MS + CHECK_JITTER_MS)), true, String(random));
    }
  });

  test("with a 5-minute tick, the first due tick is between 21 and 22 hours on", () => {
    for (const random of [0, 0.25, 0.5, 0.999999]) {
      const t = firstDue(checked(random), 5 * MINUTE);
      assert.ok(t >= 21 * HOUR && t <= 22 * HOUR, `${random}: ${t / HOUR} hours`);
    }
  });

  test("with a daily tick, the next one checks: 24 hours on, or 23 on Vercel Hobby", () => {
    for (const random of [0, 0.5, 0.999999]) {
      assert.equal(firstDue(checked(random), 24 * HOUR), 24 * HOUR, String(random));
      // Hobby fires anywhere within its hour, so two ticks can be 23 hours apart.
      assert.equal(checkIsDue(checked(random), items, after(23 * HOUR)), true, String(random));
    }
  });

  test("after a failure: the last answer kept, and an hour's wait", () => {
    const good = checked(0.5);
    const failedAt = after(30 * HOUR);
    const failed = afterFailure(good, "Could not reach https://mixos.org: fetch failed", undefined, failedAt);
    assert.deepEqual(failed.results, good.results);
    assert.deepEqual(failed.sent, good.sent);
    assert.equal(failed.lastSuccessAt, good.lastSuccessAt);
    assert.equal(failed.lastAttemptAt, failedAt.toISOString());
    assert.equal(failed.lastError, "Could not reach https://mixos.org: fetch failed");
    assert.equal(checkIsDue(failed, items, after(HOUR - MINUTE, failedAt)), false);
    assert.equal(checkIsDue(failed, items, after(HOUR, failedAt)), true);
    assert.equal(firstDue(failed, 5 * MINUTE, failedAt), HOUR);

    // The first check failing keeps nothing, and says so.
    const first = afterFailure(null, "The repository answered 500 for /api/v1/updates.", undefined, T0);
    assert.deepEqual([first.sent, first.results, first.lastSuccessAt], [null, [], null]);
  });

  test("after a failure with Retry-After: that long, but never more than a day", () => {
    const at = (seconds: number | undefined) =>
      Date.parse(afterFailure(null, "The repository answered 503.", seconds, T0).nextCheckAt ?? "") - T0.getTime();
    assert.equal(at(7200), 2 * HOUR);
    assert.equal(at(300), 5 * MINUTE);
    assert.equal(at(0), 0);
    assert.equal(at(10 * 24 * 3600), LONGEST_WAIT_MS);
    assert.equal(at(Number.MAX_SAFE_INTEGER), LONGEST_WAIT_MS);
    assert.equal(at(undefined), HOUR);
  });

  test("a changed installed set is due at once, unless a failure's wait holds", () => {
    const good = checked(0.5);
    const upgraded: UpdateItem[] = [{ kind: "app", slug: "files", version: "1.2.1" }];
    const added: UpdateItem[] = [...items, { kind: "theme", slug: "dusk", version: "1.0.0" }];
    for (const set of [upgraded, added, []]) {
      assert.equal(checkIsDue(good, set, after(5 * MINUTE)), true, JSON.stringify(set));
    }
    // The same set in another order is not a change.
    const two = afterSuccess(added, [], T0, () => 0.5);
    assert.equal(checkIsDue(two, [...added].reverse(), after(5 * MINUTE)), false);

    const failed = afterFailure(good, "The repository answered 503.", 7200, after(HOUR));
    assert.equal(checkIsDue(failed, upgraded, after(HOUR + 5 * MINUTE)), false);
    assert.equal(checkIsDue(failed, upgraded, after(3 * HOUR)), true);
  });

  test("a stored schedule further away than any this writes is due", () => {
    const good = checked(0.5);
    const far = { ...good, nextCheckAt: after(LONGEST_WAIT_MS + HOUR).toISOString() };
    assert.equal(checkIsDue(far, items, T0), true);
    assert.equal(checkIsDue({ ...good, nextCheckAt: "never" }, items, after(MINUTE)), true);
  });
});

// ── what admins are told ────────────────────────────────────────────────────

describe("statusLine", () => {
  const items: UpdateItem[] = [{ kind: "app", slug: "files", version: "1.2.0" }];

  test("off, not checked yet, checked, and couldn't reach", () => {
    const good = afterSuccess(items, [], T0, () => 0);
    assert.equal(statusLine(false, good, "mixos.org", T0), "Update checks are off (MIXOS_UPDATE_CHECK).");
    assert.equal(statusLine(true, null, "mixos.org", T0), "Not checked yet.");
    assert.equal(statusLine(true, good, "mixos.org", after(3 * HOUR)), "Checked with mixos.org 3 hours ago.");
    assert.equal(statusLine(true, good, "mixos.org", after(20 * 1000)), "Checked with mixos.org just now.");
    assert.equal(statusLine(true, good, "mixos.org", after(5 * MINUTE)), "Checked with mixos.org 5 mins ago.");
    assert.equal(statusLine(true, good, "mixos.org", after(50 * HOUR)), "Checked with mixos.org 2 days ago.");

    const failed = afterFailure(good, "fetch failed", undefined, after(30 * HOUR));
    assert.equal(statusLine(true, failed, "mixos.org", after(31 * HOUR)), "Couldn't reach mixos.org since 5 Oct.");
    const never = afterFailure(null, "fetch failed", undefined, T0);
    assert.equal(statusLine(true, never, "mixos.org", after(HOUR)), "Not checked yet: couldn't reach mixos.org.");
  });
});

describe("registryNotices", () => {
  const installs = [
    install("app", "files", "1.2.0"),
    install("connector", "relay", "2.0.0"),
    install("theme", "dusk", "1.0.0", { modified: true }),
    install("app", "notes", "1.0.0", { source: "http://localhost:4321" }),
  ];
  const names: Record<string, string> = { files: "Files", relay: "Relay", dusk: "Dusk", notes: "Notes" };
  const items = itemsToCheck(installs, CATALOGUE);
  const state = afterSuccess(
    items,
    [
      answer(items[0], { installedYanked: true, installedYankedReason: "Data loss", latestVersion: "1.2.1" }),
      answer(items[1], { latestVersion: "2.1.0" }),
      answer(items[2], { listingStatus: "archived" }),
    ],
    T0,
    () => 0,
  );
  const view = (kind: ExtensionKind, over: Partial<Parameters<typeof registryNotices>[0]> = {}) =>
    registryNotices({
      kind,
      installs,
      catalogue: CATALOGUE,
      enabled: true,
      state,
      nameOf: (_kind, slug) => names[slug] ?? slug,
      current: "0.1.0",
      now: after(3 * HOUR),
      ...over,
    });
  const lines = (kind: ExtensionKind, over = {}) => view(kind, over).notices.map((n) => `${n.type} ${n.slug}`);

  test("a withdrawn release shows on every page; the rest on their kind's page", () => {
    assert.deepEqual(lines("app"), ["withdrawn files", "elsewhere notes"]);
    assert.deepEqual(lines("connector"), ["withdrawn files", "newer relay"]);
    assert.deepEqual(lines("theme"), ["withdrawn files", "unlisted dusk", "modified dusk"]);
    for (const kind of ["app", "connector", "theme"] as const) {
      assert.equal(view(kind).status, "Checked with mixos.org 3 hours ago.");
    }
  });

  test("the muted lines say what they mean", () => {
    const theme = view("theme").notices.find((n) => n.type === "modified");
    assert.equal(
      theme?.text,
      "Dusk 1.0.0 is modified locally: its files have changed since it was installed from mixos.org, " +
        "so they no longer match its install record.",
    );
    const elsewhere = view("app").notices.find((n) => n.type === "elsewhere");
    assert.equal(elsewhere?.text, "Notes was installed from localhost:4321, so it isn't checked here.");
  });

  test("with checks off, no answer shows, and the line says why", () => {
    assert.deepEqual(lines("app", { enabled: false }), ["elsewhere notes"]);
    assert.deepEqual(lines("theme", { enabled: false }), ["modified dusk"]);
    assert.equal(view("app", { enabled: false }).status, "Update checks are off (MIXOS_UPDATE_CHECK).");
  });

  test("an answer about a version this build no longer runs is dropped", () => {
    const upgraded = installs.map((i) => (i.slug === "files" ? { ...i, version: "1.2.1" } : i));
    assert.deepEqual(lines("app", { installs: upgraded }), ["elsewhere notes"]);
  });

  test("nothing from the catalogue: no line; nothing stored yet: not checked yet", () => {
    const local = [install("app", "notes", "1.0.0", { source: "http://localhost:4321" })];
    assert.equal(view("app", { installs: local }).status, null);
    assert.equal(view("app", { installs: [] }).status, null);
    assert.deepEqual(view("app", { installs: [] }).notices, []);
    assert.equal(view("app", { state: null }).status, "Not checked yet.");
    assert.deepEqual(lines("app", { state: null }), ["elsewhere notes"]);
  });
});
