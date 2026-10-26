/* This Source Code Form is subject to the terms of the Mozilla Public
 * License, v. 2.0. If a copy of the MPL was not distributed with this
 * file, You can obtain one at https://mozilla.org/MPL/2.0/. */

/**
 * src/lib/release-notes/select.ts: the window, whose notes a workspace shows,
 * and the order both surfaces list them in.
 */

import { test } from "node:test";
import assert from "node:assert/strict";
import {
  daysSince,
  groupByAuthor,
  groupByDay,
  inWorkspace,
  isRecent,
  newestFirst,
  windowStart,
  type Workspace,
} from "./select";
import type { ReleaseNote } from "./types";

/** Late in the day in UTC, so a test that ignored UTC would land on the wrong day. */
const TODAY = new Date("2026-10-25T23:30:00Z");

function note(kind: ReleaseNote["kind"], slug: string, date: string, text = `${slug} ${date}`): ReleaseNote {
  return { id: `${kind}:${slug}:${date}:${text}`, kind, slug, date, version: null, note: text };
}

test("days are counted in whole UTC days", () => {
  assert.equal(daysSince("2026-10-25", TODAY), 0);
  assert.equal(daysSince("2026-10-24", TODAY), 1);
  assert.equal(daysSince("2026-10-26", TODAY), -1);
  // Across a month, a year and a daylight-saving change elsewhere.
  assert.equal(daysSince("2026-09-30", new Date("2026-10-01T00:00:00Z")), 1);
  assert.equal(daysSince("2025-12-31", new Date("2026-01-01T12:00:00Z")), 1);
  assert.equal(daysSince("2026-03-07", new Date("2026-03-09T12:00:00Z")), 2);
});

test("a note is new for 14 days: its own and the 13 after it", () => {
  assert.equal(isRecent({ date: "2026-10-25" }, TODAY), true);
  assert.equal(isRecent({ date: "2026-10-12" }, TODAY), true);
  assert.equal(isRecent({ date: "2026-10-11" }, TODAY), false);
  // Dated tomorrow by someone ahead of UTC: new, not out of the window.
  assert.equal(isRecent({ date: "2026-10-26" }, TODAY), true);
  // The window's first day is the oldest date still new.
  assert.equal(windowStart(TODAY), "2026-10-12");
  assert.equal(isRecent({ date: windowStart(TODAY) }, TODAY), true);
});

test("a workspace shows MixOS's notes and those of what is on in it", () => {
  const workspace: Workspace = {
    apps: new Set(["careers"]),
    connectors: new Set(["gmail"]),
    theme: "mixos-dark",
  };
  assert.equal(inWorkspace(note("core", "mixos", "2026-10-25"), workspace), true);
  assert.equal(inWorkspace(note("app", "careers", "2026-10-25"), workspace), true);
  assert.equal(inWorkspace(note("app", "key-numbers", "2026-10-25"), workspace), false);
  assert.equal(inWorkspace(note("connector", "gmail", "2026-10-25"), workspace), true);
  assert.equal(inWorkspace(note("connector", "google-sheets", "2026-10-25"), workspace), false);
  assert.equal(inWorkspace(note("theme", "mixos-dark", "2026-10-25"), workspace), true);
  // The light theme is installed, but it isn't the one on.
  assert.equal(inWorkspace(note("theme", "mixos", "2026-10-25"), workspace), false);
  // A theme and an app may share a slug; each is judged as its own kind.
  assert.equal(inWorkspace(note("app", "mixos-dark", "2026-10-25"), workspace), false);
});

test("newest first; on one day MixOS, apps, connectors, themes, and each file's order", () => {
  const notes = [
    note("theme", "mixos", "2026-10-20"),
    note("app", "wall-e", "2026-10-20", "second"),
    note("connector", "gmail", "2026-10-20"),
    note("app", "careers", "2026-10-20"),
    note("core", "mixos", "2026-10-20"),
    note("app", "wall-e", "2026-10-25", "newest"),
    note("app", "wall-e", "2026-10-20", "third"),
  ];
  assert.deepEqual(
    newestFirst(notes).map((n) => `${n.kind}:${n.slug}:${n.date}:${n.note}`),
    [
      "app:wall-e:2026-10-25:newest",
      "core:mixos:2026-10-20:mixos 2026-10-20",
      "app:careers:2026-10-20:careers 2026-10-20",
      "app:wall-e:2026-10-20:second",
      "app:wall-e:2026-10-20:third",
      "connector:gmail:2026-10-20:gmail 2026-10-20",
      "theme:mixos:2026-10-20:mixos 2026-10-20",
    ],
  );
});

test("grouped by whose: kinds in order, then the newest extension first", () => {
  const groups = groupByAuthor([
    note("connector", "gmail", "2026-10-15"),
    note("app", "careers", "2026-10-15"),
    note("app", "wall-e", "2026-10-20"),
    note("core", "mixos", "2026-10-12"),
    note("app", "careers", "2026-10-22"),
    note("app", "key-numbers", "2026-10-22"),
  ]);
  assert.deepEqual(
    groups.map((g) => `${g.kind}:${g.slug} ${g.notes.map((n) => n.date).join(",")}`),
    [
      "core:mixos 2026-10-12",
      "app:careers 2026-10-22,2026-10-15",
      "app:key-numbers 2026-10-22",
      "app:wall-e 2026-10-20",
      "connector:gmail 2026-10-15",
    ],
  );
  assert.deepEqual(groupByAuthor([]), []);
});

test("grouped by day for the page, newest first", () => {
  const days = groupByDay([
    note("app", "careers", "2026-09-10"),
    note("core", "mixos", "2026-10-25"),
    note("theme", "mixos", "2026-09-10"),
    note("app", "wall-e", "2026-10-25"),
  ]);
  assert.deepEqual(
    days.map((d) => `${d.date}: ${d.notes.map((n) => `${n.kind}:${n.slug}`).join(", ")}`),
    ["2026-10-25: core:mixos, app:wall-e", "2026-09-10: app:careers, theme:mixos"],
  );
});
