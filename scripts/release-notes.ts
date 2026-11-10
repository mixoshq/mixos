/* This Source Code Form is subject to the terms of the Mozilla Public
 * License, v. 2.0. If a copy of the MPL was not distributed with this
 * file, You can obtain one at https://mozilla.org/MPL/2.0/. */

/**
 * Reading one `release-notes.json`: an extension's, beside its manifest, or
 * MixOS's own, at the root of the repository (src/lib/release-notes/types.ts).
 *
 *   {
 *     "$schema": "https://mixos.org/schemas/release-notes/v1.json",
 *     "notes": [
 *       { "date": "2026-10-20", "version": "1.1.0", "note": "Reads attachments too." },
 *       { "date": "2026-08-28", "note": "First release: ..." }
 *     ]
 *   }
 *
 * An object, not the list alone, so there is somewhere to say which shape it is
 * (`$schema`, src/lib/extensions/schema-urls.ts).
 *
 * The registry generator reads it for every extension it checks, a Registry
 * install's `--check` included, so a file that breaks a rule is refused before
 * the extension lands, and stops a build as a bad manifest does. Each rule is
 * about what the menu bar would otherwise show:
 *
 *  - One line of plain text, trimmed, 1 to 300 characters. The popover and the
 *    page print it as it is, and a note that runs to a paragraph is a changelog
 *    entry, which CHANGELOG.md or the extension's README is for.
 *  - A real date, no later than tomorrow. A typo'd year would keep a note "new"
 *    for a year; tomorrow is allowed because an author ahead of UTC writes
 *    tomorrow's date today.
 *  - A version, when there is one, as three numbers: `1.2.0`, no `v`.
 *  - Newest first, so the file reads as the list it becomes, and no note twice.
 *
 * A missing file is no notes, not an error.
 *
 * Library only, with no import a script can't load.
 */

import { createHash } from "node:crypto";
import fs from "node:fs";
import path from "node:path";
import { z } from "zod";
import { FatalManifestError } from "./manifest-errors";
import { formatZodError } from "./manifest-schemas";
import { schemaProblem, schemaUrl } from "../src/lib/extensions/schema-urls";
import {
  RELEASE_NOTES_FILE,
  RELEASE_NOTES_MAX_BYTES,
  RELEASE_NOTE_MAX_LENGTH,
  type ReleaseNote,
  type ReleaseNoteKind,
} from "../src/lib/release-notes/types";

/** One note as the file has it. */
export interface ReleaseNoteEntry {
  date: string;
  version: string | null;
  note: string;
}

const GRAPHEMES = new Intl.Segmenter("en", { granularity: "grapheme" });

/** A note's length as a person counts it: an accented letter or an emoji is one character. */
export function noteLength(note: string): number {
  return [...GRAPHEMES.segment(note)].length;
}

/** Semantic versioning's three numbers, and an optional prerelease. */
const VERSION = /^(?:0|[1-9]\d*)\.(?:0|[1-9]\d*)\.(?:0|[1-9]\d*)(?:-[0-9A-Za-z-]+(?:\.[0-9A-Za-z-]+)*)?$/;

const LINE_BREAK = /[\n\r\u2028\u2029]/;

/** Control characters, and the bidi controls that change how the text around them prints. */
const CONTROL = /[\p{Cc}\u200E\u200F\u202A-\u202E\u2066-\u2069]/u;

const noteSchema = z.string().superRefine((note, ctx) => {
  if (note.trim() === "") {
    ctx.addIssue({ code: "custom", message: "is empty" });
  } else if (LINE_BREAK.test(note)) {
    ctx.addIssue({ code: "custom", message: "runs over more than one line; a note is one line" });
  } else if (CONTROL.test(note)) {
    ctx.addIssue({ code: "custom", message: "has a control or bidi character in it" });
  } else if (note !== note.trim()) {
    ctx.addIssue({ code: "custom", message: "starts or ends with a space" });
  } else if (noteLength(note) > RELEASE_NOTE_MAX_LENGTH) {
    ctx.addIssue({
      code: "custom",
      message: `is ${noteLength(note)} characters; a note is ${RELEASE_NOTE_MAX_LENGTH} or fewer`,
    });
  }
});

const entrySchema = z.strictObject({
  /** The day the change shipped. */
  date: z.iso.date('expected the day the change shipped, as "2026-10-20"'),
  version: z.string().regex(VERSION, 'a version is three numbers, "1.2.0", with no "v"').optional(),
  note: noteSchema,
});

export const ReleaseNotesFileSchema = z.strictObject({
  /** Which shape the file is: src/lib/extensions/schema-urls.ts. */
  $schema: z.literal(schemaUrl("release-notes")),
  notes: z.array(entrySchema),
});

/** `date` plus `days`, both `YYYY-MM-DD` in UTC. */
function addDays(date: string, days: number): string {
  const d = new Date(`${date}T00:00:00Z`);
  d.setUTCDate(d.getUTCDate() + days);
  return d.toISOString().slice(0, 10);
}

/**
 * The notes in `dir`'s release-notes.json, newest first, or none when it has
 * no such file. Throws FatalManifestError for a file that breaks a rule, each
 * message starting with `where`, the file as the reader should look for it:
 * `apps/<slug>/release-notes.json`, say.
 *
 * `today` is for tests.
 */
export function readReleaseNotes(dir: string, where: string, today: Date = new Date()): ReleaseNoteEntry[] {
  const file = path.join(dir, RELEASE_NOTES_FILE);
  let stat: fs.Stats;
  try {
    stat = fs.lstatSync(file);
  } catch {
    return [];
  }
  // lstat, so a link to a file outside the extension is not read as its notes.
  if (!stat.isFile()) {
    throw new FatalManifestError(`${where} is not a file. Release notes are a JSON file, ${RELEASE_NOTES_FILE}.`);
  }
  if (stat.size > RELEASE_NOTES_MAX_BYTES) {
    throw new FatalManifestError(
      `${where} is ${Math.ceil(stat.size / 1024)} KB, above the ${RELEASE_NOTES_MAX_BYTES / 1024} KB limit.`,
    );
  }

  let raw: unknown;
  try {
    raw = JSON.parse(fs.readFileSync(file, "utf-8"));
  } catch (err) {
    throw new FatalManifestError(
      `${where} is not valid JSON: ${err instanceof Error ? err.message : String(err)}`,
    );
  }

  // The list on its own is the shape before `$schema`: say what it is now,
  // rather than that a list has no "$schema".
  if (Array.isArray(raw)) {
    throw new FatalManifestError(
      `${where} is a list of notes. It is an object now: { "$schema": "${schemaUrl("release-notes")}", "notes": [ …the list… ] }.`,
    );
  }
  const shape = schemaProblem("release-notes", (raw as { $schema?: unknown } | null)?.$schema, where);
  if (shape) throw new FatalManifestError(shape);

  const parsed = ReleaseNotesFileSchema.safeParse(raw);
  if (!parsed.success) {
    throw new FatalManifestError(
      `${where} failed validation (each note is { "date", "version"?, "note" }):\n${formatZodError(parsed.error)}`,
    );
  }
  const notes = parsed.data.notes;

  const latest = addDays(today.toISOString().slice(0, 10), 1);
  const problems: string[] = [];
  const seen = new Map<string, number>();
  notes.forEach((entry, i) => {
    if (entry.date > latest) {
      problems.push(`  - notes.${i}.date: ${entry.date} is after today; a note is dated the day its change shipped`);
    }
    const previous = notes[i - 1];
    if (previous && entry.date > previous.date) {
      problems.push(`  - notes.${i}.date: ${entry.date} comes after ${previous.date}; list the newest note first`);
    }
    const key = `${entry.date}\n${entry.note}`;
    const first = seen.get(key);
    if (first !== undefined) {
      problems.push(`  - notes.${i}: the same note as notes.${first}, on the same day`);
    } else {
      seen.set(key, i);
    }
  });
  if (problems.length > 0) {
    throw new FatalManifestError(`${where} failed validation:\n${problems.join("\n")}`);
  }

  return notes.map((entry) => ({
    date: entry.date,
    version: entry.version ?? null,
    note: entry.note,
  }));
}

/**
 * A note's id: whose it is, its day, and a hash of its text. Stable across
 * builds, so the seen state kept against it holds; a note whose text is edited
 * gets a new one, and is new again.
 */
export function releaseNoteId(kind: ReleaseNoteKind, slug: string, date: string, note: string): string {
  const hash = createHash("sha256").update(note).digest("hex").slice(0, 12);
  return `${kind}:${slug}:${date}:${hash}`;
}

/** The notes in `dir` as the generated module carries them. */
export function releaseNotesOf(
  kind: ReleaseNoteKind,
  slug: string,
  dir: string,
  where: string,
  today?: Date,
): ReleaseNote[] {
  return readReleaseNotes(dir, where, today).map((entry) => ({
    id: releaseNoteId(kind, slug, entry.date, entry.note),
    kind,
    slug,
    ...entry,
  }));
}
