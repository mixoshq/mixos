/* This Source Code Form is subject to the terms of the Mozilla Public
 * License, v. 2.0. If a copy of the MPL was not distributed with this
 * file, You can obtain one at https://mozilla.org/MPL/2.0/. */

"use client";

import { usePathname, useSearchParams } from "next/navigation";
import { useEffect, useMemo, useState } from "react";
import AuthorIcon from "@/components/release-notes/author-icon";
import { EmptyState } from "@/components/ui/app-states";
import { Badge } from "@/components/ui/badge";
import { CARD_SHELL } from "@/components/ui/card";
import { Field } from "@/components/ui/field";
import { formatNoteDay } from "@/lib/release-notes/format";
import { groupByDay } from "@/lib/release-notes/select";
import type { ReleaseNoteAuthor, ReleaseNoteHistory, ReleaseNoteKind } from "@/lib/release-notes/types";
import { cn } from "@/lib/utils";

/**
 * What the filter shows: everything, MixOS's own, a whole kind of extension,
 * or one extension, `<kind>:<slug>`. In the URL as `?show=`, so a filtered
 * list survives a reload and Back.
 */
type Show = "all" | "core" | ExtensionGroup | `${Exclude<ReleaseNoteKind, "core">}:${string}`;
type ExtensionGroup = "apps" | "connectors" | "themes";

const GROUPS: { kind: Exclude<ReleaseNoteKind, "core">; value: ExtensionGroup; label: string; noun: string }[] = [
  { kind: "app", value: "apps", label: "Apps", noun: "apps" },
  { kind: "connector", value: "connectors", label: "Connectors", noun: "connectors" },
  { kind: "theme", value: "themes", label: "Themes", noun: "themes" },
];

/** The badge beside a note's author. MixOS's own notes say Core, since the name already says MixOS. */
const KIND_LABEL: Record<ReleaseNoteKind, string> = {
  core: "Core",
  app: "App",
  connector: "Connector",
  theme: "Theme",
};

const authorKey = (a: Pick<ReleaseNoteAuthor, "kind" | "slug">) => `${a.kind}:${a.slug}`;

/**
 * App Manager's Release Notes page, below its heading: every note for MixOS and
 * for what is on in this person's workspace, newest first and by day, and the
 * filter over them.
 *
 * The filter lists MixOS Core, then each kind of extension: the whole kind, or
 * one extension in it. Each extension that is on is listed, with notes or
 * without, so the list says what it covers.
 */
export default function ReleaseNotesBrowser({ authors, notes }: ReleaseNoteHistory) {
  const pathname = usePathname();
  const searchParams = useSearchParams();

  const valid = useMemo(() => {
    const values = new Set<string>(["all", "core", ...GROUPS.map((g) => g.value)]);
    for (const author of authors) if (author.kind !== "core") values.add(authorKey(author));
    return values;
  }, [authors]);

  // A value the filter doesn't offer (an extension since turned off, say)
  // reads as everything.
  const [show, setShow] = useState<Show>(() => {
    const asked = searchParams.get("show");
    return asked && valid.has(asked) ? (asked as Show) : "all";
  });

  // The one place the URL is written: every change goes through setShow. The
  // history API rather than the router, which would render the page again on
  // the server for a filter the browser applies.
  useEffect(() => {
    const params = new URLSearchParams(window.location.search);
    if (show === "all") params.delete("show");
    else params.set("show", show);
    const query = params.toString();
    if (query === window.location.search.replace(/^\?/, "")) return;
    window.history.replaceState(null, "", query ? `${pathname}?${query}` : pathname);
  }, [show, pathname]);

  const byKey = useMemo(() => new Map(authors.map((a) => [authorKey(a), a])), [authors]);

  const shown = useMemo(() => {
    const group = GROUPS.find((g) => g.value === show);
    return notes.filter((note) => {
      if (show === "all") return true;
      if (show === "core") return note.kind === "core";
      if (group) return note.kind === group.kind;
      return authorKey(note) === show;
    });
  }, [notes, show]);

  const days = useMemo(() => groupByDay(shown), [shown]);

  return (
    <>
      <div className="mb-6 flex flex-col gap-4 sm:flex-row sm:items-end sm:justify-between">
        <div>
          <h1 className="text-2xl font-bold text-foreground">Release Notes</h1>
          <p className="mt-1 text-sm text-muted-foreground">
            What changed in MixOS, and in the apps, connectors and theme on in your workspace.
          </p>
        </div>
        <Field label="Show" className="w-full shrink-0 sm:w-64">
          {(field) => (
            // Grouped, which the Select primitive doesn't do. Styled as it is.
            <select
              {...field}
              value={show}
              onChange={(e) => setShow(e.target.value as Show)}
              className="mix-input h-10 w-full rounded-md border border-input bg-background px-3 text-sm text-foreground focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-ring focus-visible:ring-offset-1 focus-visible:ring-offset-background"
            >
              <option value="all">All release notes</option>
              <option value="core">MixOS Core</option>
              {GROUPS.map((group) => (
                <optgroup key={group.value} label={group.label}>
                  <option value={group.value}>All {group.noun}</option>
                  {authors
                    .filter((author) => author.kind === group.kind)
                    .map((author) => (
                      <option key={authorKey(author)} value={authorKey(author)}>
                        {author.name}
                      </option>
                    ))}
                </optgroup>
              ))}
            </select>
          )}
        </Field>
      </div>

      {notes.length === 0 ? (
        <EmptyState
          cause="no-data"
          title="No release notes yet"
          body="When MixOS, or an app, connector or theme you use, ships a change, it is described here."
        />
      ) : days.length === 0 ? (
        <EmptyState
          cause="no-match"
          title="No release notes"
          body={emptyBody(show, authors, byKey)}
          action={{ label: "Show all release notes", onClick: () => setShow("all") }}
        />
      ) : (
        <div className={cn(CARD_SHELL, "divide-y divide-border")}>
          {days.map((day) => (
            <section key={day.date} aria-labelledby={`day-${day.date}`} className="p-5">
              <h2 id={`day-${day.date}`} className="text-sm font-semibold text-foreground">
                <time dateTime={day.date}>{formatNoteDay(day.date)}</time>
              </h2>
              <ul className="mt-3 space-y-4">
                {day.notes.map((note) => {
                  const author = byKey.get(authorKey(note));
                  return (
                    <li key={note.id} className="flex gap-3">
                      <span className="mt-0.5 flex h-5 items-center">
                        <AuthorIcon icon={author?.icon ?? { lucide: "box" }} />
                      </span>
                      <div className="min-w-0 flex-1">
                        <div className="flex flex-wrap items-center gap-x-2 gap-y-1">
                          <span className="text-sm font-medium text-foreground">{author?.name ?? note.slug}</span>
                          <Badge>{KIND_LABEL[note.kind]}</Badge>
                          {note.version && (
                            <span className="text-xs text-muted-foreground">v{note.version}</span>
                          )}
                        </div>
                        <p className="mt-1 text-sm text-foreground">{note.note}</p>
                      </div>
                    </li>
                  );
                })}
              </ul>
            </section>
          ))}
        </div>
      )}
    </>
  );
}

/** Why a filter shows nothing, in the words of what it filters to. */
function emptyBody(show: Show, authors: ReleaseNoteAuthor[], byKey: Map<string, ReleaseNoteAuthor>): string {
  if (show === "core") return "MixOS has no release notes yet.";
  const group = GROUPS.find((g) => g.value === show);
  if (group) {
    return authors.some((a) => a.kind === group.kind)
      ? `None of your ${group.noun} has release notes yet.`
      : `No ${group.noun} are on in your workspace.`;
  }
  return `${byKey.get(show)?.name ?? "This extension"} has no release notes yet.`;
}
