/* This Source Code Form is subject to the terms of the Mozilla Public
 * License, v. 2.0. If a copy of the MPL was not distributed with this
 * file, You can obtain one at https://mozilla.org/MPL/2.0/. */

"use client";

import Link from "next/link";
import {
  useCallback,
  useEffect,
  useMemo,
  useRef,
  useState,
  type MouseEvent as ReactMouseEvent,
} from "react";
import { ArrowRight, Gift } from "lucide-react";
import AuthorIcon from "@/components/release-notes/author-icon";
import { CARD_SURFACE } from "@/components/ui/card";
import { StatusDot } from "@/components/ui/status";
import { getMyRecentReleaseNotes, markMyReleaseNotesSeen } from "@/lib/release-notes/actions";
import { formatShortNoteDate } from "@/lib/release-notes/format";
import {
  RELEASE_NOTE_KINDS,
  type RecentReleaseNoteGroup,
  type ReleaseNoteKind,
} from "@/lib/release-notes/types";
import { cn } from "@/lib/utils";

/** How long a note is pointed at, or on screen, before it counts as seen. */
const SEEN_AFTER_MS = 1000;

/** How long a mark waits, so the notes seen in one sweep go to the server together. */
const SEND_AFTER_MS = 500;

/** The most ids one call carries: the server refuses more (./actions.ts). */
const SEND_AT_MOST = 200;

/**
 * Each section's heading. MixOS's notes have none: they come first, under
 * MixOS's own name, so a heading would say MixOS twice.
 */
const SECTION_HEADING: Record<ReleaseNoteKind, string | null> = {
  core: null,
  app: "Apps",
  connector: "Connectors",
  theme: "Themes",
};

/**
 * How the open popover decides a note is seen: the pointer resting on it, or,
 * with no pointer to rest (a touch screen, or a popover opened from the
 * keyboard), the note being on screen.
 */
type SeenBy = "hover" | "view";

type Note = RecentReleaseNoteGroup["notes"][number];

/**
 * The menu bar's release notes: a gift, before the name dropdown, with a red
 * count of the notes not yet seen, and a popover listing the last 14 days'
 * notes (RECENT_RELEASE_NOTE_DAYS) for MixOS and for what is on in this
 * person's workspace (src/lib/release-notes/server.ts).
 *
 * With nothing in that window there is no icon at all. A note stops being new
 * after a second under the pointer, or a second on screen where there is no
 * hover; its dot goes at once, and the marks go to the server in batches. Once
 * every note is seen the icon stays, without a count, until the window passes.
 *
 * Loaded once the bar mounts, again on each opening, and when an app is
 * installed or removed (which App Manager announces), since that changes whose
 * notes are listed.
 */
export default function ReleaseNotesMenu() {
  const [groups, setGroups] = useState<RecentReleaseNoteGroup[]>([]);
  const [open, setOpen] = useState(false);
  const [seenBy, setSeenBy] = useState<SeenBy>("hover");
  // The scrolling list, which a note has to be visible in to count as on screen.
  const [list, setList] = useState<HTMLDivElement | null>(null);
  const rootRef = useRef<HTMLDivElement>(null);
  const buttonRef = useRef<HTMLButtonElement>(null);
  const panelRef = useRef<HTMLDivElement>(null);
  const openedFromKeyboard = useRef(false);
  // Every note marked seen while the page has been open. A load that crossed a
  // mark on its way to the server would otherwise bring that note's dot back.
  const seenHere = useRef(new Set<string>());
  const unsent = useRef(new Set<string>());
  const sendTimer = useRef<number | null>(null);

  const load = useCallback(() => {
    getMyRecentReleaseNotes().then(
      (loaded) =>
        setGroups(
          loaded.map((group) => ({
            ...group,
            notes: group.notes.map((note) =>
              seenHere.current.has(note.id) ? { ...note, seen: true } : note,
            ),
          })),
        ),
      (err) => console.error("[release-notes] could not load the release notes:", err),
    );
  }, []);

  useEffect(() => {
    load();
    window.addEventListener("apps:installed-changed", load);
    return () => window.removeEventListener("apps:installed-changed", load);
  }, [load]);

  const send = useCallback(() => {
    if (sendTimer.current !== null) {
      window.clearTimeout(sendTimer.current);
      sendTimer.current = null;
    }
    const ids = [...unsent.current];
    unsent.current.clear();
    for (let i = 0; i < ids.length; i += SEND_AT_MOST) {
      markMyReleaseNotesSeen({ ids: ids.slice(i, i + SEND_AT_MOST) }).catch((err) =>
        console.error("[release-notes] could not record the notes seen:", err),
      );
    }
  }, []);

  // What is still waiting goes when the menu bar does.
  useEffect(() => send, [send]);

  const markSeen = useCallback(
    (id: string) => {
      if (seenHere.current.has(id)) return;
      seenHere.current.add(id);
      unsent.current.add(id);
      setGroups((current) =>
        current.map((group) =>
          group.notes.some((note) => note.id === id)
            ? { ...group, notes: group.notes.map((note) => (note.id === id ? { ...note, seen: true } : note)) }
            : group,
        ),
      );
      sendTimer.current ??= window.setTimeout(send, SEND_AFTER_MS);
    },
    [send],
  );

  const close = useCallback(
    (returnFocus = false) => {
      setOpen(false);
      send();
      if (returnFocus) buttonRef.current?.focus();
    },
    [send],
  );

  function toggle(e: ReactMouseEvent<HTMLButtonElement>) {
    if (open) {
      close();
      return;
    }
    // A click from the keyboard has no pointer position, and `detail` 0.
    openedFromKeyboard.current = e.detail === 0;
    const canHover = window.matchMedia("(hover: hover)").matches;
    setSeenBy(canHover && !openedFromKeyboard.current ? "hover" : "view");
    setOpen(true);
    load();
  }

  // Outside the popover and its button, a press closes it; so does Escape,
  // which hands focus back to the button.
  useEffect(() => {
    if (!open) return;
    const onDown = (e: MouseEvent) => {
      if (!rootRef.current?.contains(e.target as Node)) close();
    };
    const onKey = (e: KeyboardEvent) => {
      if (e.key === "Escape") close(true);
    };
    document.addEventListener("mousedown", onDown);
    document.addEventListener("keydown", onKey);
    return () => {
      document.removeEventListener("mousedown", onDown);
      document.removeEventListener("keydown", onKey);
    };
  }, [open, close]);

  // Opened from the keyboard, focus moves into the popover, so Tab carries on
  // through its links and a screen reader announces it.
  useEffect(() => {
    if (open && openedFromKeyboard.current) panelRef.current?.focus();
  }, [open]);

  const unseen = useMemo(
    () => groups.reduce((count, group) => count + group.notes.filter((note) => !note.seen).length, 0),
    [groups],
  );
  const sections = useMemo(
    () =>
      RELEASE_NOTE_KINDS.map((kind) => ({ kind, groups: groups.filter((g) => g.kind === kind) })).filter(
        (section) => section.groups.length > 0,
      ),
    [groups],
  );

  if (groups.length === 0) return null;

  const label = unseen > 0 ? `Release notes, ${unseen} new` : "Release notes";

  return (
    <div className="relative" ref={rootRef}>
      <button
        ref={buttonRef}
        type="button"
        onClick={toggle}
        aria-expanded={open}
        aria-haspopup="dialog"
        aria-label={label}
        title={label}
        className="relative flex items-center rounded-md p-1.5 text-brand-foreground transition-colors hover:bg-brand-foreground/10"
      >
        <Gift className="h-4 w-4" aria-hidden />
        {unseen > 0 && (
          <span
            aria-hidden
            // Overhangs the icon's corner, ringed in the bar's own colour so it
            // reads as a separate mark on any theme's menu bar.
            className="absolute -right-1 -top-1 flex h-4 min-w-4 items-center justify-center rounded-full bg-destructive px-1 text-[10px] font-bold leading-none tabular-nums text-destructive-foreground ring-2 ring-brand"
          >
            {unseen > 9 ? "9+" : unseen}
          </span>
        )}
      </button>

      {open && (
        <div
          ref={panelRef}
          role="dialog"
          aria-labelledby="release-notes-title"
          tabIndex={-1}
          className={cn(
            "mix-popover",
            CARD_SURFACE,
            // overflow-hidden rounds the header's fill into the panel's corners.
            "absolute right-0 top-full z-50 mt-1 flex w-[min(24rem,calc(100vw-2rem))] flex-col overflow-hidden shadow-lg outline-none",
          )}
        >
          {/* The menu bar's own colours, so the panel reads as coming from it. */}
          <div className="flex items-center gap-2 bg-brand px-4 py-3 text-brand-foreground">
            <Gift className="h-4 w-4 shrink-0" aria-hidden />
            <h2 id="release-notes-title" className="text-sm font-semibold">
              What&apos;s new
            </h2>
          </div>

          <div ref={setList} className="max-h-[min(28rem,65vh)] overflow-y-auto py-1">
            {sections.map((section) => (
              <section
                key={section.kind}
                aria-labelledby={SECTION_HEADING[section.kind] ? `release-notes-${section.kind}` : undefined}
                className="py-1"
              >
                {SECTION_HEADING[section.kind] && (
                  <h3
                    id={`release-notes-${section.kind}`}
                    className="px-4 pb-1 pt-2 text-xs font-semibold uppercase tracking-wider text-muted-foreground"
                  >
                    {SECTION_HEADING[section.kind]}
                  </h3>
                )}
                {section.groups.map((group) => (
                  <div key={`${group.kind}:${group.slug}`} className="px-4 py-1.5">
                    <div className="flex min-h-7 items-center gap-2">
                      <AuthorIcon icon={group.icon} />
                      <span className="min-w-0 flex-1 truncate text-sm font-medium text-foreground">
                        {group.name}
                      </span>
                      {group.href && (
                        <Link
                          href={group.href}
                          onClick={() => close()}
                          className="inline-flex shrink-0 items-center gap-1 rounded-md border border-border px-2 py-1 text-xs font-medium text-foreground transition-colors hover:bg-muted"
                        >
                          Go to App
                          <ArrowRight className="h-3 w-3" aria-hidden />
                        </Link>
                      )}
                    </div>
                    <ul className="mt-1 space-y-2">
                      {group.notes.map((note) => (
                        <NoteRow key={note.id} note={note} seenBy={seenBy} list={list} onSeen={markSeen} />
                      ))}
                    </ul>
                  </div>
                ))}
              </section>
            ))}
          </div>

          <div className="border-t border-border p-2">
            <Link
              href="/apps/release-notes"
              onClick={() => close()}
              className="flex w-full items-center justify-center gap-1.5 rounded-md px-3 py-2 text-sm font-medium text-foreground transition-colors hover:bg-muted"
            >
              See all release notes
              <ArrowRight className="h-4 w-4" aria-hidden />
            </Link>
          </div>
        </div>
      )}
    </div>
  );
}

/**
 * One note, with a red dot until it is seen: after SEEN_AFTER_MS under the
 * pointer, or on screen in `list`, as `seenBy` says.
 */
function NoteRow({
  note,
  seenBy,
  list,
  onSeen,
}: {
  note: Note;
  seenBy: SeenBy;
  list: HTMLElement | null;
  onSeen: (id: string) => void;
}) {
  const ref = useRef<HTMLLIElement>(null);
  const timer = useRef<number | null>(null);

  const stop = useCallback(() => {
    if (timer.current !== null) {
      window.clearTimeout(timer.current);
      timer.current = null;
    }
  }, []);

  const start = useCallback(() => {
    if (note.seen || timer.current !== null) return;
    timer.current = window.setTimeout(() => {
      timer.current = null;
      onSeen(note.id);
    }, SEEN_AFTER_MS);
  }, [note.seen, note.id, onSeen]);

  useEffect(() => stop, [stop]);

  useEffect(() => {
    const row = ref.current;
    if (seenBy !== "view" || note.seen || !row) return;
    // Most of the note in view, not a sliver of it at the list's edge.
    const observer = new IntersectionObserver(([entry]) => (entry.isIntersecting ? start() : stop()), {
      root: list,
      threshold: 0.6,
    });
    observer.observe(row);
    return () => {
      observer.disconnect();
      stop();
    };
  }, [seenBy, note.seen, list, start, stop]);

  const hover = seenBy === "hover" && !note.seen;

  return (
    <li
      ref={ref}
      onPointerEnter={hover ? (e) => e.pointerType !== "touch" && start() : undefined}
      onPointerLeave={hover ? stop : undefined}
      className="flex gap-2"
    >
      <span className="flex h-5 w-2.5 shrink-0 items-center">
        {!note.seen && <StatusDot tone="danger" label="New" />}
      </span>
      <div className="min-w-0 flex-1">
        <p className="text-sm text-foreground">{note.note}</p>
        <p className="mt-0.5 text-xs text-muted-foreground">
          {formatShortNoteDate(note.date)}
          {note.version && ` · v${note.version}`}
        </p>
      </div>
    </li>
  );
}
