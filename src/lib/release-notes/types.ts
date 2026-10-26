/* This Source Code Form is subject to the terms of the Mozilla Public
 * License, v. 2.0. If a copy of the MPL was not distributed with this
 * file, You can obtain one at https://mozilla.org/MPL/2.0/. */

/**
 * Release notes: one line each, for the people who use MixOS and its
 * extensions, about what changed for them.
 *
 * ── WHERE THEY LIVE ─────────────────────────────────────────────────────────
 *
 * An app, a connector or a theme keeps `release-notes.json` beside its
 * manifest, and MixOS keeps one at the root of the repository. Not in the
 * manifest: the Release Notes page keeps the whole history, so notes pile up
 * with every release, and a manifest that grew a changelog would be mostly
 * changelog. The registry generator checks each file (scripts/release-notes.ts)
 * and writes every accepted note to `src/generated/release-notes.ts`.
 *
 * ── WHO SEES WHICH ──────────────────────────────────────────────────────────
 *
 * Everyone sees MixOS's, and each person the notes of what is on in their own
 * workspace: the apps they installed and still hold, the connectors that
 * aren't switched off, and the active theme (./server.ts). The menu bar shows
 * those dated in the last RECENT_RELEASE_NOTE_DAYS, and App Manager's Release
 * Notes page all of them.
 *
 * No server-only imports: the generator reads this from scripts/, and client
 * components take the view types.
 */

import type { ExtensionKind } from "../repository/types";

/** The file, at the root of an extension's folder and of the repository. */
export const RELEASE_NOTES_FILE = "release-notes.json";

/** The longest a note may be, in characters as a person counts them. */
export const RELEASE_NOTE_MAX_LENGTH = 300;

/** The largest file the generator reads: some eight hundred notes of the longest kind. */
export const RELEASE_NOTES_MAX_BYTES = 256 * 1024;

/**
 * How long a note counts as new: its date and the 13 days after it. The menu
 * bar shows the notes in that window, and no icon at all when there are none.
 */
export const RECENT_RELEASE_NOTE_DAYS = 14;

/** Whose note: MixOS's own, or an extension's. */
export type ReleaseNoteKind = "core" | ExtensionKind;

/** The order both surfaces list them in. */
export const RELEASE_NOTE_KINDS: readonly ReleaseNoteKind[] = ["core", "app", "connector", "theme"];

/** The slug MixOS's own notes carry. No extension shares its kind, so none can clash with it. */
export const CORE_SLUG = "mixos";

/** One note, as the generator writes it to `src/generated/release-notes.ts`. */
export interface ReleaseNote {
  /**
   * `<kind>:<slug>:<date>:<hash of the text>`, the same on every build while
   * the note reads the same. Seen state is kept against it, so a note whose
   * text is edited is new again to everyone.
   */
  id: string;
  kind: ReleaseNoteKind;
  /** The app's or theme's folder, the connector's name, or CORE_SLUG. */
  slug: string;
  /** The day the change shipped, `YYYY-MM-DD`. */
  date: string;
  /** The release it shipped in, `X.Y.Z`, when the file says. */
  version: string | null;
  /** One line of plain text, at most RELEASE_NOTE_MAX_LENGTH characters. */
  note: string;
}

/** Who a group of notes belongs to, as both surfaces show it. */
export interface ReleaseNoteAuthor {
  kind: ReleaseNoteKind;
  slug: string;
  name: string;
  /** A Lucide icon name, or the public URL of a connector's own icon. */
  icon: { lucide: string } | { src: string };
  /** Where Go to App opens: an app's page, for an app that has pages. */
  href: string | null;
}

/** A note as the browser gets it. */
export type ReleaseNoteView = Pick<ReleaseNote, "id" | "date" | "version" | "note">;

/** The menu bar's notes for one author, each with whether this person has seen it. */
export interface RecentReleaseNoteGroup extends ReleaseNoteAuthor {
  notes: (ReleaseNoteView & { seen: boolean })[];
}

/** Every note for one person, for App Manager's Release Notes page. */
export interface ReleaseNoteHistory {
  /** Everything on in their workspace, MixOS first, notes or none: the page's filter. */
  authors: ReleaseNoteAuthor[];
  /** Newest first. */
  notes: (ReleaseNoteView & Pick<ReleaseNote, "kind" | "slug">)[];
}
