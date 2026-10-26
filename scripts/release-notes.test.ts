/* This Source Code Form is subject to the terms of the Mozilla Public
 * License, v. 2.0. If a copy of the MPL was not distributed with this
 * file, You can obtain one at https://mozilla.org/MPL/2.0/. */

/**
 * scripts/release-notes.ts: what a release-notes.json may hold, and the ids
 * its notes get. Each test writes a file to a folder of its own.
 */

import { after, test } from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { FatalManifestError } from "./manifest-errors";
import { noteLength, readReleaseNotes, releaseNoteId, releaseNotesOf } from "./release-notes";

const root = fs.mkdtempSync(path.join(os.tmpdir(), "mixos-release-notes-"));
after(() => fs.rmSync(root, { recursive: true, force: true }));

const TODAY = new Date("2026-10-25T15:00:00Z");
let folders = 0;

/** A folder holding `contents` as its release-notes.json: JSON for a value, as it is for a string. */
function folder(contents?: unknown): string {
  const dir = path.join(root, `ext-${folders++}`);
  fs.mkdirSync(dir);
  if (contents !== undefined) {
    const text = typeof contents === "string" ? contents : JSON.stringify(contents);
    fs.writeFileSync(path.join(dir, "release-notes.json"), text);
  }
  return dir;
}

function read(contents?: unknown) {
  return readReleaseNotes(folder(contents), "apps/x/release-notes.json", TODAY);
}

/** The message a file is refused with. */
function refusal(contents: unknown): string {
  try {
    read(contents);
  } catch (err) {
    assert.ok(err instanceof FatalManifestError, "refused as a bad manifest is");
    assert.match(err.message, /^apps\/x\/release-notes\.json/);
    return err.message;
  }
  assert.fail("the file was accepted");
}

test("no file is no notes", () => {
  assert.deepEqual(read(), []);
});

test("notes come back as written, newest first, with a version where there is one", () => {
  assert.deepEqual(
    read([
      { date: "2026-10-20", version: "1.1.0", note: "Reads attachments too." },
      { date: "2026-10-20", note: "Faster search." },
      { date: "2026-08-28", note: "First release: a shared inbox." },
    ]),
    [
      { date: "2026-10-20", version: "1.1.0", note: "Reads attachments too." },
      { date: "2026-10-20", version: null, note: "Faster search." },
      { date: "2026-08-28", version: null, note: "First release: a shared inbox." },
    ],
  );
  assert.deepEqual(read([]), []);
});

test("a note is at most 300 characters, counted as a person counts them", () => {
  assert.equal(read([{ date: "2026-10-01", note: "a".repeat(300) }]).length, 1);
  assert.match(refusal([{ date: "2026-10-01", note: "a".repeat(301) }]), /0\.note: is 301 characters; a note is 300 or fewer/);
  // Each is one character to a reader, and more than one to String.length.
  assert.equal(noteLength("é"), 1);
  assert.equal(noteLength("👩\u200D💻"), 1);
  assert.equal(read([{ date: "2026-10-01", note: "👩\u200D💻".repeat(300) }]).length, 1);
});

test("a note is one trimmed line of plain text", () => {
  assert.match(refusal([{ date: "2026-10-01", note: "" }]), /0\.note: is empty/);
  assert.match(refusal([{ date: "2026-10-01", note: "   " }]), /0\.note: is empty/);
  assert.match(refusal([{ date: "2026-10-01", note: "One.\nTwo." }]), /more than one line/);
  assert.match(refusal([{ date: "2026-10-01", note: "One.\u2028Two." }]), /more than one line/);
  assert.match(refusal([{ date: "2026-10-01", note: "Tab\there." }]), /control or bidi character/);
  assert.match(refusal([{ date: "2026-10-01", note: "abc\u202Edef" }]), /control or bidi character/);
  assert.match(refusal([{ date: "2026-10-01", note: " Leading space." }]), /starts or ends with a space/);
});

test("a date is a real day, written as one, and not after tomorrow", () => {
  assert.match(refusal([{ date: "2026-02-30", note: "No such day." }]), /0\.date: expected the day the change shipped/);
  assert.match(refusal([{ date: "10/20/2026", note: "Not ISO." }]), /0\.date/);
  assert.match(refusal([{ date: "2026-10-20T10:00:00Z", note: "A time." }]), /0\.date/);
  // Tomorrow is someone's today ahead of UTC.
  assert.equal(read([{ date: "2026-10-26", note: "From the future, just." }]).length, 1);
  assert.match(refusal([{ date: "2026-10-27", note: "Too far." }]), /0\.date: 2026-10-27 is after today/);
  assert.match(refusal([{ date: "2027-10-20", note: "A typo'd year." }]), /is after today/);
});

test("a version is three numbers, with no v", () => {
  assert.equal(read([{ date: "2026-10-01", version: "1.0.0-beta.1", note: "A prerelease." }])[0].version, "1.0.0-beta.1");
  assert.match(refusal([{ date: "2026-10-01", version: "v1.0.0", note: "With a v." }]), /0\.version: a version is three numbers/);
  assert.match(refusal([{ date: "2026-10-01", version: "1.0", note: "Two numbers." }]), /0\.version/);
});

test("newest first, and no note twice on one day", () => {
  assert.match(
    refusal([
      { date: "2026-08-28", note: "Older." },
      { date: "2026-10-20", note: "Newer." },
    ]),
    /1\.date: 2026-10-20 comes after 2026-08-28; list the newest note first/,
  );
  assert.match(
    refusal([
      { date: "2026-10-20", note: "Twice." },
      { date: "2026-10-20", note: "Twice." },
    ]),
    /1: the same note as 0, on the same day/,
  );
  // The same words on another day are another note.
  assert.equal(
    read([
      { date: "2026-10-20", note: "Again." },
      { date: "2026-10-01", note: "Again." },
    ]).length,
    2,
  );
});

test("the shape is a list of { date, version?, note }, and nothing else", () => {
  assert.match(refusal({ notes: [] }), /failed validation/);
  assert.match(refusal([{ date: "2026-10-01", note: "x", title: "An extra key." }]), /Unrecognized key/);
  assert.match(refusal([{ date: "2026-10-01" }]), /0\.note/);
  assert.match(refusal("[{"), /is not valid JSON/);
});

test("a file too large, or not a file, is refused", () => {
  const big = [{ date: "2026-10-01", note: "x".repeat(300) }];
  const padded = `${JSON.stringify(big)}${" ".repeat(256 * 1024)}`;
  assert.match(refusal(padded), /KB, above the 256 KB limit/);

  const dir = folder();
  fs.mkdirSync(path.join(dir, "release-notes.json"));
  assert.throws(() => readReleaseNotes(dir, "apps/x/release-notes.json", TODAY), /is not a file/);

  const linked = folder();
  const target = path.join(folder([{ date: "2026-10-01", note: "Elsewhere." }]), "release-notes.json");
  fs.symlinkSync(target, path.join(linked, "release-notes.json"));
  assert.throws(() => readReleaseNotes(linked, "apps/x/release-notes.json", TODAY), /is not a file/);
});

test("an id names whose note it is and its day, and changes with its text", () => {
  const id = releaseNoteId("app", "wall-e", "2026-09-23", "Hourly quotes.");
  assert.match(id, /^app:wall-e:2026-09-23:[0-9a-f]{12}$/);
  assert.equal(releaseNoteId("app", "wall-e", "2026-09-23", "Hourly quotes."), id);
  assert.notEqual(releaseNoteId("app", "wall-e", "2026-09-23", "Hourly quotes!"), id);
  assert.notEqual(releaseNoteId("theme", "wall-e", "2026-09-23", "Hourly quotes."), id);

  const dir = folder([{ date: "2026-09-23", note: "Hourly quotes." }]);
  assert.deepEqual(releaseNotesOf("app", "wall-e", dir, "apps/wall-e/release-notes.json", TODAY), [
    { id, kind: "app", slug: "wall-e", date: "2026-09-23", version: null, note: "Hourly quotes." },
  ]);
});
