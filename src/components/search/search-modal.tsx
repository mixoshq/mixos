/* This Source Code Form is subject to the terms of the Mozilla Public
 * License, v. 2.0. If a copy of the MPL was not distributed with this
 * file, You can obtain one at https://mozilla.org/MPL/2.0/. */

"use client";

import Link from "next/link";
import { useRouter } from "next/navigation";
import {
  useCallback,
  useEffect,
  useId,
  useMemo,
  useRef,
  useState,
  type KeyboardEvent as ReactKeyboardEvent,
  type MouseEvent as ReactMouseEvent,
} from "react";
import { ChevronDown, CornerDownLeft, Loader2, Search, Settings, X } from "lucide-react";
import LucideIcon from "@/components/lucide-icon";
import { CARD_SURFACE } from "@/components/ui/card";
import { Skeleton } from "@/components/ui/skeleton";
import {
  MAX_QUERY,
  MIN_OBJECT_QUERY,
  MORE_PAGE,
  type SearchGroup,
  type SearchHit,
  type SearchMoreResponse,
  type SearchResponse,
} from "@/lib/search/types";
import { cn } from "@/lib/utils";
import { useSearch } from "./search-context";

/** How long typing has to pause before the query goes out. */
const DEBOUNCE_MS = 150;

type Status = "idle" | "loading" | "done" | "error";

/** One row the arrow keys can land on: a result, or a section's Show more. */
type Row =
  | { kind: "hit"; key: string; hit: SearchHit; group: SearchGroup; section: number }
  | { kind: "more"; key: string; group: SearchGroup; section: number };

const sectionKey = (source: string, object: string) => `${source}\u0000${object}`;

/**
 * The global search modal: an input over a list of results grouped by app,
 * in the middle of the screen.
 *
 * KEYBOARD. Focus stays in the input the whole time; the arrow keys move a
 * highlight through every row (results and Show more alike), which the input
 * names with `aria-activedescendant`: the ARIA combobox-with-listbox pattern,
 * so a screen reader announces the highlighted row as it moves. Enter opens
 * it, or loads ten more; ⌘/Ctrl+Enter opens a result in a new tab; Escape
 * closes; Tab stays inside the panel.
 *
 * HEIGHT. Fixed, so the input never moves under the person typing as results
 * come and go.
 */
export default function SearchModal({ onClose }: { onClose: () => void }) {
  const router = useRouter();
  const { shortcutLabel, prefs } = useSearch();
  const listId = useId();
  const optionId = (index: number) => `${listId}-option-${index}`;

  const [query, setQuery] = useState("");
  const [status, setStatus] = useState<Status>("idle");
  const [results, setResults] = useState<SearchResponse | null>(null);
  const [loadingMore, setLoadingMore] = useState<Record<string, boolean>>({});
  const [moreErrors, setMoreErrors] = useState<Record<string, string>>({});
  const [active, setActive] = useState(0);

  const inputRef = useRef<HTMLInputElement>(null);
  const panelRef = useRef<HTMLDivElement>(null);
  const timer = useRef<number | null>(null);
  const inflight = useRef<AbortController | null>(null);

  // Focus in on open, back to whatever had it on close. A DOM side effect,
  // not state.
  useEffect(() => {
    const restoreTo = document.activeElement as HTMLElement | null;
    inputRef.current?.focus();
    return () => restoreTo?.focus?.();
  }, []);

  // Nothing outlives the modal: a pending debounce, or a request in flight.
  useEffect(
    () => () => {
      if (timer.current !== null) window.clearTimeout(timer.current);
      inflight.current?.abort();
    },
    [],
  );

  const run = useCallback(async (q: string) => {
    inflight.current?.abort();
    const controller = new AbortController();
    inflight.current = controller;
    setStatus("loading");
    try {
      const res = await fetch(`/api/search?q=${encodeURIComponent(q)}`, {
        signal: controller.signal,
        headers: { Accept: "application/json" },
      });
      if (!res.ok) throw new Error(`search answered ${res.status}`);
      const body = (await res.json()) as SearchResponse;
      if (controller.signal.aborted) return;
      setResults(body);
      setLoadingMore({});
      setMoreErrors({});
      setActive(0);
      setStatus("done");
    } catch (err) {
      if (controller.signal.aborted) return;
      console.error("[search] the search failed:", err);
      setStatus("error");
    }
  }, []);

  function onQueryChange(next: string) {
    setQuery(next);
    if (timer.current !== null) window.clearTimeout(timer.current);
    const q = next.trim();
    if (!q) {
      inflight.current?.abort();
      setResults(null);
      setStatus("idle");
      setActive(0);
      return;
    }
    timer.current = window.setTimeout(() => {
      timer.current = null;
      void run(q);
    }, DEBOUNCE_MS);
  }

  // Every row the highlight can rest on, in the order they are drawn.
  const rows = useMemo<Row[]>(() => {
    if (!results) return [];
    const out: Row[] = [];
    for (const group of results.groups) {
      group.sections.forEach((section, i) => {
        for (const hit of section.hits) {
          out.push({ kind: "hit", key: `${group.source}:${section.object}:${hit.id}`, hit, group, section: i });
        }
        if (section.hasMore) {
          out.push({ kind: "more", key: `${group.source}:${section.object}:more`, group, section: i });
        }
      });
    }
    return out;
  }, [results]);

  // Where each row sits in `rows`, by its key, for the render below.
  const indexOf = useMemo(() => new Map(rows.map((row, i) => [row.key, i])), [rows]);

  const activeIndex = rows.length === 0 ? -1 : Math.min(active, rows.length - 1);
  const activeRow = activeIndex >= 0 ? rows[activeIndex] : null;

  // Keep the highlighted row in view as the arrows move it.
  useEffect(() => {
    if (activeIndex < 0) return;
    document.getElementById(`${listId}-option-${activeIndex}`)?.scrollIntoView({ block: "nearest" });
  }, [activeIndex, listId]);

  function open(hit: SearchHit, newTab: boolean) {
    if (newTab) {
      window.open(hit.href, "_blank", "noopener");
      return;
    }
    onClose();
    router.push(hit.href);
  }

  async function loadMore(group: SearchGroup, sectionIndex: number) {
    if (!results) return;
    const section = group.sections[sectionIndex];
    const key = sectionKey(group.source, section.object);
    if (loadingMore[key]) return;
    const forQuery = results.query;
    setLoadingMore((m) => ({ ...m, [key]: true }));
    setMoreErrors((m) => {
      const rest = { ...m };
      delete rest[key];
      return rest;
    });
    try {
      const params = new URLSearchParams({
        q: forQuery,
        source: group.source,
        object: section.object,
        offset: String(section.hits.length),
      });
      const res = await fetch(`/api/search?${params}`, { headers: { Accept: "application/json" } });
      if (!res.ok) throw new Error(`search answered ${res.status}`);
      const page = (await res.json()) as SearchMoreResponse;
      if (page.error) throw new Error(page.error);
      setResults((current) => {
        // A new search replaced these results while the page was on its way.
        if (!current || current.query !== forQuery) return current;
        return {
          ...current,
          groups: current.groups.map((g) =>
            g.source !== group.source
              ? g
              : {
                  ...g,
                  sections: g.sections.map((s) => {
                    if (s.object !== section.object) return s;
                    const have = new Set(s.hits.map((h) => h.id));
                    return {
                      ...s,
                      hits: [...s.hits, ...page.hits.filter((h) => !have.has(h.id))],
                      hasMore: page.hasMore,
                    };
                  }),
                },
          ),
        };
      });
    } catch (err) {
      console.error("[search] could not load more:", err);
      setMoreErrors((m) => ({ ...m, [key]: "Couldn't load more. Try again." }));
    } finally {
      setLoadingMore((m) => ({ ...m, [key]: false }));
    }
  }

  function activate(row: Row, newTab = false) {
    if (row.kind === "hit") open(row.hit, newTab);
    else void loadMore(row.group, row.section);
  }

  function onInputKeyDown(e: ReactKeyboardEvent<HTMLInputElement>) {
    if (e.nativeEvent.isComposing) return;
    if (e.key === "ArrowDown" || e.key === "ArrowUp") {
      if (rows.length === 0) return;
      e.preventDefault();
      const step = e.key === "ArrowDown" ? 1 : -1;
      setActive((rows.length + Math.max(activeIndex, 0) + step) % rows.length);
      return;
    }
    if (e.key === "Enter" && activeRow) {
      e.preventDefault();
      activate(activeRow, e.metaKey || e.ctrlKey);
    }
  }

  // Escape closes, and Tab stays inside the panel.
  useEffect(() => {
    const onKey = (e: globalThis.KeyboardEvent) => {
      if (e.key === "Escape") {
        e.preventDefault();
        onClose();
        return;
      }
      if (e.key !== "Tab") return;
      const root = panelRef.current;
      if (!root) return;
      const items = Array.from(
        root.querySelectorAll<HTMLElement>('a[href], button:not([disabled]), input, [tabindex]:not([tabindex="-1"])'),
      ).filter((el) => el.offsetParent !== null);
      if (items.length === 0) return;
      const first = items[0];
      const last = items[items.length - 1];
      if (e.shiftKey && document.activeElement === first) {
        e.preventDefault();
        last.focus();
      } else if (!e.shiftKey && document.activeElement === last) {
        e.preventDefault();
        first.focus();
      }
    };
    document.addEventListener("keydown", onKey);
    return () => document.removeEventListener("keydown", onKey);
  }, [onClose]);

  const trimmed = query.trim();
  const showSkeleton = status === "loading" && !results;

  return (
    <div
      className="fixed inset-0 z-50 flex items-center justify-center p-4"
      role="presentation"
      onMouseDown={(e) => {
        if (e.target === e.currentTarget) onClose();
      }}
    >
      <div aria-hidden className="absolute inset-0 bg-black/70" />
      <div
        ref={panelRef}
        role="dialog"
        aria-modal="true"
        aria-label="Search"
        className={cn(
          "mix-modal",
          CARD_SURFACE,
          "relative flex h-[min(34rem,calc(100vh-2rem))] w-full max-w-2xl flex-col overflow-hidden shadow-xl",
        )}
      >
        <div className="flex items-center gap-2 border-b border-border px-4">
          {status === "loading" ? (
            <Loader2 className="h-4 w-4 shrink-0 animate-spin text-muted-foreground" aria-hidden />
          ) : (
            <Search className="h-4 w-4 shrink-0 text-muted-foreground" aria-hidden />
          )}
          <input
            ref={inputRef}
            type="text"
            role="combobox"
            aria-expanded={rows.length > 0}
            aria-controls={listId}
            aria-autocomplete="list"
            aria-activedescendant={activeRow ? optionId(activeIndex) : undefined}
            aria-label="Search apps and what's in them"
            placeholder="Search apps and what's in them…"
            autoComplete="off"
            spellCheck={false}
            maxLength={MAX_QUERY}
            value={query}
            onChange={(e) => onQueryChange(e.target.value)}
            onKeyDown={onInputKeyDown}
            className="h-14 min-w-0 flex-1 bg-transparent text-base text-foreground placeholder:text-muted-foreground focus:outline-none"
          />
          <button
            type="button"
            onClick={onClose}
            aria-label="Close search"
            className="shrink-0 rounded-md p-1 text-muted-foreground transition hover:bg-muted hover:text-foreground focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-ring"
          >
            <X className="h-4 w-4" aria-hidden />
          </button>
        </div>

        <div className="min-h-0 flex-1 overflow-y-auto py-2" aria-busy={status === "loading" || undefined}>
          {status === "idle" && (
            <Hint
              title="Search your apps"
              body={
                prefs.shortcutEnabled
                  ? `Find an app by its name, or what's inside the apps you use. ${shortcutLabel} opens this from anywhere.`
                  : "Find an app by its name, or what's inside the apps you use."
              }
            />
          )}

          {showSkeleton && <ResultsSkeleton />}

          {status === "error" && (
            <div className="px-6 py-10 text-center">
              <p className="text-sm font-medium text-foreground">Search isn&apos;t working right now.</p>
              <button
                type="button"
                onClick={() => trimmed && void run(trimmed)}
                className="mt-3 rounded-md border border-border px-3 py-1.5 text-sm font-medium text-foreground transition-colors hover:bg-muted focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-ring"
              >
                Try again
              </button>
            </div>
          )}

          {results && status !== "error" && results.groups.length === 0 && status !== "loading" && (
            results.query.length < MIN_OBJECT_QUERY ? (
              <Hint title="Keep typing" body="Type at least two letters to search inside your apps." />
            ) : (
              <Hint
                title={`Nothing matches “${results.query}”`}
                body="Search looks in the apps you've installed. Choose which ones in Search settings."
              />
            )
          )}

          {results && status !== "error" && results.groups.length > 0 && (
            <div id={listId} role="listbox" aria-label="Search results">
              {results.groups.map((group) => {
                const headingId = `${listId}-group-${group.source.replace(/[^a-zA-Z0-9_-]/g, "_")}`;
                const titled = group.sections.length > 1;
                return (
                  <div key={group.source} role="group" aria-labelledby={headingId} className="pb-2">
                    <div
                      id={headingId}
                      className="sticky top-0 z-10 flex items-center gap-2 bg-card px-4 pb-1 pt-2 text-xs font-semibold uppercase tracking-wider text-muted-foreground"
                    >
                      <LucideIcon name={group.icon} className="h-3.5 w-3.5" aria-hidden />
                      {group.name}
                    </div>
                    {group.sections.map((section, sectionIndex) => {
                      const key = sectionKey(group.source, section.object);
                      return (
                        <div key={section.object}>
                          {titled && (
                            <div className="px-4 pb-0.5 pt-1.5 text-xs font-medium text-muted-foreground" aria-hidden>
                              {section.label}
                            </div>
                          )}
                          {section.error && (
                            <p className="px-4 py-1.5 text-sm text-muted-foreground">
                              {titled ? section.label : group.name}: {section.error}
                            </p>
                          )}
                          {section.hits.map((hit) => {
                            const i = indexOf.get(`${group.source}:${section.object}:${hit.id}`) ?? -1;
                            const isActive = i === activeIndex;
                            return (
                              <div
                                key={hit.id}
                                id={optionId(i)}
                                role="option"
                                aria-selected={isActive}
                                onMouseMove={() => i !== activeIndex && setActive(i)}
                                onMouseDown={(e) => e.preventDefault()}
                                onClick={(e: ReactMouseEvent) => open(hit, e.metaKey || e.ctrlKey)}
                                className={cn(
                                  "mx-2 flex cursor-pointer items-center gap-3 rounded-md border-l-2 px-2.5 py-2",
                                  isActive ? "border-primary bg-muted/50" : "border-transparent",
                                )}
                              >
                                <span className="flex h-7 w-7 shrink-0 items-center justify-center rounded-md border border-border text-muted-foreground">
                                  <LucideIcon name={hit.icon ?? section.icon} className="h-4 w-4" aria-hidden />
                                </span>
                                <span className="min-w-0 flex-1">
                                  <span className="block truncate text-sm text-foreground">
                                    <Highlight text={hit.title} query={results.query} />
                                  </span>
                                  {hit.subtitle && (
                                    <span className="block truncate text-xs text-muted-foreground">{hit.subtitle}</span>
                                  )}
                                </span>
                                {isActive && (
                                  <CornerDownLeft className="h-3.5 w-3.5 shrink-0 text-muted-foreground" aria-hidden />
                                )}
                              </div>
                            );
                          })}
                          {section.hasMore &&
                            (() => {
                              const i = indexOf.get(`${group.source}:${section.object}:more`) ?? -1;
                              const isActive = i === activeIndex;
                              const busy = loadingMore[key] === true;
                              return (
                                <div
                                  id={optionId(i)}
                                  role="option"
                                  aria-selected={isActive}
                                  aria-busy={busy || undefined}
                                  onMouseMove={() => i !== activeIndex && setActive(i)}
                                  onMouseDown={(e) => e.preventDefault()}
                                  onClick={() => void loadMore(group, sectionIndex)}
                                  className={cn(
                                    "mx-2 flex cursor-pointer items-center gap-3 rounded-md border-l-2 px-2.5 py-1.5 text-sm text-foreground",
                                    isActive ? "border-primary bg-muted/50" : "border-transparent",
                                  )}
                                >
                                  <span className="flex h-7 w-7 shrink-0 items-center justify-center text-muted-foreground">
                                    {busy ? (
                                      <Loader2 className="h-4 w-4 animate-spin" aria-hidden />
                                    ) : (
                                      <ChevronDown className="h-4 w-4" aria-hidden />
                                    )}
                                  </span>
                                  Show {MORE_PAGE} more {titled ? section.label.toLowerCase() : `from ${group.name}`}
                                </div>
                              );
                            })()}
                          {moreErrors[key] && (
                            <p className="px-4 py-1 text-xs text-muted-foreground">{moreErrors[key]}</p>
                          )}
                        </div>
                      );
                    })}
                  </div>
                );
              })}
            </div>
          )}
          {results && status !== "error" && results.groups.length > 0 && results.query.length < MIN_OBJECT_QUERY && (
            <p className="px-4 pb-2 pt-1 text-xs text-muted-foreground">
              Type another letter to search inside your apps too.
            </p>
          )}
        </div>

        <div className="flex items-center justify-between gap-3 border-t border-border px-4 py-2 text-xs text-muted-foreground">
          <span className="hidden items-center gap-3 sm:flex" aria-hidden>
            <span>
              <Kbd>↑</Kbd> <Kbd>↓</Kbd> to move
            </span>
            <span>
              <Kbd>↵</Kbd> to open
            </span>
            <span>
              <Kbd>esc</Kbd> to close
            </span>
          </span>
          <Link
            href="/account/search"
            onClick={onClose}
            className="ml-auto inline-flex items-center gap-1.5 rounded-md px-2 py-1 font-medium text-foreground transition-colors hover:bg-muted focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-ring"
          >
            <Settings className="h-3.5 w-3.5" aria-hidden />
            Search settings
          </Link>
        </div>
      </div>
    </div>
  );
}

function Hint({ title, body }: { title: string; body: string }) {
  return (
    <div className="px-6 py-10 text-center">
      <p className="text-sm font-medium text-foreground">{title}</p>
      <p className="mx-auto mt-1 max-w-sm text-sm text-muted-foreground">{body}</p>
    </div>
  );
}

function Kbd({ children }: { children: string }) {
  return (
    <kbd className="rounded border border-border px-1.5 py-0.5 font-sans text-[11px] text-foreground">
      {children}
    </kbd>
  );
}

/** The first place the query appears in `text`, in bold. */
function Highlight({ text, query }: { text: string; query: string }) {
  const at = text.toLocaleLowerCase().indexOf(query.toLocaleLowerCase());
  if (!query || at === -1) return <>{text}</>;
  return (
    <>
      {text.slice(0, at)}
      <mark className="bg-transparent font-semibold text-foreground">{text.slice(at, at + query.length)}</mark>
      {text.slice(at + query.length)}
    </>
  );
}

/** Two groups of rows, the shape the results arrive in. */
function ResultsSkeleton() {
  return (
    <div className="space-y-4 px-4 py-2" aria-hidden>
      {[3, 2].map((count, g) => (
        <div key={g} className="space-y-2">
          <Skeleton className="h-3 w-24" />
          {Array.from({ length: count }, (_, i) => (
            <div key={i} className="flex items-center gap-3 py-1">
              <Skeleton className="h-7 w-7 rounded-md" />
              <div className="flex-1 space-y-1.5">
                <Skeleton className="h-3.5 w-2/3" />
                <Skeleton className="h-3 w-1/3" />
              </div>
            </div>
          ))}
        </div>
      ))}
    </div>
  );
}
