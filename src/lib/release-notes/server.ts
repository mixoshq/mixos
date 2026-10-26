/* This Source Code Form is subject to the terms of the Mozilla Public
 * License, v. 2.0. If a copy of the MPL was not distributed with this
 * file, You can obtain one at https://mozilla.org/MPL/2.0/. */

/**
 * A person's release notes: whose they see, and which they have seen.
 *
 * Server only. It reads the whole of `src/generated/release-notes.ts` and the
 * database, and hands a caller one person's share: the menu bar's through
 * ./actions.ts, App Manager's Release Notes page directly.
 */

import { appRegistry } from "@/generated/app-registry";
import { connectorRegistry } from "@/generated/connector-registry";
import { releaseNotes } from "@/generated/release-notes";
import { themeRegistry } from "@/generated/theme-registry";
import { getUserApps } from "@/lib/apps/access";
import { getDisabledConnectors } from "@/lib/connectors/switch";
import { createServiceClient } from "@/lib/db/server";
import { getActiveTheme } from "@/lib/themes/active";
import {
  groupByAuthor,
  inWorkspace,
  isRecent,
  newestFirst,
  windowStart,
  type Workspace,
} from "./select";
import {
  CORE_SLUG,
  type RecentReleaseNoteGroup,
  type ReleaseNote,
  type ReleaseNoteAuthor,
  type ReleaseNoteHistory,
  type ReleaseNoteKind,
} from "./types";

/**
 * What is on in this person's workspace: the apps they installed and still
 * hold (active, and granted or global), the connectors not switched off, and
 * the active theme.
 *
 * A connector switch that can't be read leaves the connectors out rather than
 * guessing they are on: these are notes, and a missing one costs nothing.
 */
export async function workspaceOf(userId: string): Promise<Workspace> {
  const names = connectorRegistry.map((c) => c.name);
  const [apps, disabled, { theme }] = await Promise.all([
    getUserApps(userId),
    getDisabledConnectors(names).catch((err: unknown) => {
      console.error("[release-notes] could not read the connector switches; leaving connectors out:", err);
      return null;
    }),
    getActiveTheme(),
  ]);
  return {
    apps: new Set(apps),
    connectors: new Set(disabled ? names.filter((name) => !disabled.has(name)) : []),
    theme: theme.slug,
  };
}

/** Who a note is by, as the menu bar and the page name them. */
function authorOf(kind: ReleaseNoteKind, slug: string): ReleaseNoteAuthor {
  switch (kind) {
    case "core":
      return { kind, slug, name: "MixOS", icon: { lucide: "sparkles" }, href: null };
    case "app": {
      const app = appRegistry.find((a) => a.slug === slug);
      return {
        kind,
        slug,
        name: app?.name ?? slug,
        icon: { lucide: app?.icon ?? "box" },
        href: app?.hasPages ? `/apps/${slug}` : null,
      };
    }
    case "connector": {
      const connector = connectorRegistry.find((c) => c.name === slug);
      return {
        kind,
        slug,
        name: connector?.displayName ?? slug,
        icon: connector?.icon ? { src: connector.icon } : { lucide: "plug" },
        href: null,
      };
    }
    case "theme":
      return {
        kind,
        slug,
        name: themeRegistry.find((t) => t.slug === slug)?.name ?? slug,
        icon: { lucide: "palette" },
        href: null,
      };
  }
}

/** The ids among `ids` this person has marked seen. */
async function seenAmong(userId: string, ids: readonly string[]): Promise<Set<string>> {
  if (ids.length === 0) return new Set();
  const { data, error } = await createServiceClient()
    .from("release_notes_seen")
    .select("note_id")
    .eq("user_id", userId)
    .in("note_id", ids);
  if (error) throw new Error(`Failed to read the release notes seen: ${error.message}`);
  return new Set((data as { note_id: string }[]).map((row) => row.note_id));
}

/**
 * The menu bar's notes for this person: MixOS's and their workspace's, dated
 * in the window, grouped by whose, each with whether they have seen it. Empty
 * when nothing is in the window, and then the menu bar shows no icon.
 */
export async function recentReleaseNotesFor(
  userId: string,
  today: Date = new Date(),
): Promise<RecentReleaseNoteGroup[]> {
  const workspace = await workspaceOf(userId);
  const recent = releaseNotes.filter((note) => isRecent(note, today) && inWorkspace(note, workspace));
  if (recent.length === 0) return [];
  const seen = await seenAmong(
    userId,
    recent.map((note) => note.id),
  );
  return groupByAuthor(recent).map((group) => ({
    ...authorOf(group.kind, group.slug),
    notes: group.notes.map((note) => ({
      id: note.id,
      date: note.date,
      version: note.version,
      note: note.note,
      seen: seen.has(note.id),
    })),
  }));
}

/**
 * Every note for this person, for App Manager's Release Notes page, and
 * everything on in their workspace, with notes or without, for its filter.
 */
export async function releaseNoteHistoryFor(userId: string): Promise<ReleaseNoteHistory> {
  const workspace = await workspaceOf(userId);
  const byName = (a: ReleaseNoteAuthor, b: ReleaseNoteAuthor) => a.name.localeCompare(b.name);
  const authors = [
    authorOf("core", CORE_SLUG),
    ...[...workspace.apps].map((slug) => authorOf("app", slug)).sort(byName),
    ...[...workspace.connectors].map((slug) => authorOf("connector", slug)).sort(byName),
    authorOf("theme", workspace.theme),
  ];
  return {
    authors,
    notes: newestFirst(releaseNotes.filter((note) => inWorkspace(note, workspace))).map((note) => ({
      id: note.id,
      kind: note.kind,
      slug: note.slug,
      date: note.date,
      version: note.version,
      note: note.note,
    })),
  };
}

/**
 * Record that this person has seen the notes `ids` names. Only notes in this
 * build and still in the window are recorded, so a caller can store no more
 * than one window's notes; anything else is dropped without a word. Then their
 * rows for notes older than the window go.
 */
export async function markReleaseNotesSeen(
  userId: string,
  ids: readonly string[],
  today: Date = new Date(),
): Promise<void> {
  const wanted = new Set(ids);
  const notes: ReleaseNote[] = releaseNotes.filter((note) => wanted.has(note.id) && isRecent(note, today));
  const db = createServiceClient();
  if (notes.length > 0) {
    const { error } = await db.from("release_notes_seen").upsert(
      notes.map((note) => ({ user_id: userId, note_id: note.id, note_date: note.date })),
      { onConflict: "user_id,note_id", ignoreDuplicates: true },
    );
    if (error) throw new Error(`Failed to record the release notes seen: ${error.message}`);
  }
  const { error } = await db
    .from("release_notes_seen")
    .delete()
    .eq("user_id", userId)
    .lt("note_date", windowStart(today));
  if (error) throw new Error(`Failed to clear the old release notes seen: ${error.message}`);
}
