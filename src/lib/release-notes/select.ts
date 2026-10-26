/* This Source Code Form is subject to the terms of the Mozilla Public
 * License, v. 2.0. If a copy of the MPL was not distributed with this
 * file, You can obtain one at https://mozilla.org/MPL/2.0/. */

/**
 * Which release notes a person sees, and in what order: the rules the menu
 * bar, App Manager's Release Notes page and the seen state share, kept apart
 * from the database so they can be tested as they are.
 *
 * Days are calendar days in UTC, the same on every server. A note's date has
 * no time of day, so "today" has to be one place's today, and the build's
 * check on future dates is in UTC too (scripts/release-notes.ts).
 */

import {
  RECENT_RELEASE_NOTE_DAYS,
  RELEASE_NOTE_KINDS,
  type ReleaseNote,
  type ReleaseNoteKind,
} from "./types";

/** What is on in one person's workspace: whose notes they see, besides MixOS's. */
export interface Workspace {
  /** The apps they installed and still hold. */
  apps: ReadonlySet<string>;
  /** The connectors in the build that aren't switched off. */
  connectors: ReadonlySet<string>;
  /** The install's active theme. */
  theme: string;
}

const DAY_MS = 24 * 60 * 60 * 1000;

/** Whole days from `date` (`YYYY-MM-DD`) to `today`. Negative for a date after today. */
export function daysSince(date: string, today: Date): number {
  const start = Date.parse(`${date}T00:00:00Z`);
  const end = Date.UTC(today.getUTCFullYear(), today.getUTCMonth(), today.getUTCDate());
  return Math.round((end - start) / DAY_MS);
}

/**
 * Whether a note is still new: dated today or in the days before it, within
 * the window. A date after today, from an author ahead of UTC, is new too.
 */
export function isRecent(note: Pick<ReleaseNote, "date">, today: Date): boolean {
  return daysSince(note.date, today) < RECENT_RELEASE_NOTE_DAYS;
}

/** The oldest date still in the window, `YYYY-MM-DD`. A seen row for an older note can go. */
export function windowStart(today: Date): string {
  const start = new Date(Date.UTC(today.getUTCFullYear(), today.getUTCMonth(), today.getUTCDate()));
  start.setUTCDate(start.getUTCDate() - (RECENT_RELEASE_NOTE_DAYS - 1));
  return start.toISOString().slice(0, 10);
}

/** Whether a note's author is MixOS or is on in `workspace`. */
export function inWorkspace(note: Pick<ReleaseNote, "kind" | "slug">, workspace: Workspace): boolean {
  switch (note.kind) {
    case "core":
      return true;
    case "app":
      return workspace.apps.has(note.slug);
    case "connector":
      return workspace.connectors.has(note.slug);
    case "theme":
      return workspace.theme === note.slug;
  }
}

function kindOrder(kind: ReleaseNoteKind): number {
  return RELEASE_NOTE_KINDS.indexOf(kind);
}

type Dated = Pick<ReleaseNote, "kind" | "slug" | "date">;

/**
 * Notes newest first. On one day: MixOS, then apps, connectors and themes,
 * each by slug. The sort is stable, so one extension's notes of one day keep
 * the order of its file.
 */
export function newestFirst<N extends Dated>(notes: readonly N[]): N[] {
  return [...notes].sort(
    (a, b) =>
      b.date.localeCompare(a.date) || kindOrder(a.kind) - kindOrder(b.kind) || a.slug.localeCompare(b.slug),
  );
}

/** One extension's notes, newest first. */
export interface AuthorNotes<N> {
  kind: ReleaseNoteKind;
  slug: string;
  notes: N[];
}

/**
 * Notes grouped by whose they are, for the menu bar: MixOS first, then apps,
 * connectors and themes, and within a kind the extension with the newest note
 * first, then by slug.
 */
export function groupByAuthor<N extends Dated>(notes: readonly N[]): AuthorNotes<N>[] {
  const groups = new Map<string, AuthorNotes<N>>();
  for (const note of newestFirst(notes)) {
    const key = `${note.kind}:${note.slug}`;
    let group = groups.get(key);
    if (!group) {
      group = { kind: note.kind, slug: note.slug, notes: [] };
      groups.set(key, group);
    }
    group.notes.push(note);
  }
  return [...groups.values()].sort(
    (a, b) =>
      kindOrder(a.kind) - kindOrder(b.kind) ||
      b.notes[0].date.localeCompare(a.notes[0].date) ||
      a.slug.localeCompare(b.slug),
  );
}

/** One day's notes. */
export interface DayNotes<N> {
  date: string;
  notes: N[];
}

/** Notes by day, newest first, for the Release Notes page. */
export function groupByDay<N extends Dated>(notes: readonly N[]): DayNotes<N>[] {
  const days: DayNotes<N>[] = [];
  for (const note of newestFirst(notes)) {
    const last = days[days.length - 1];
    if (last?.date === note.date) last.notes.push(note);
    else days.push({ date: note.date, notes: [note] });
  }
  return days;
}
