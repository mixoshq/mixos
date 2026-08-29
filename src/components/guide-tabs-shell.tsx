/* This Source Code Form is subject to the terms of the Mozilla Public
 * License, v. 2.0. If a copy of the MPL was not distributed with this
 * file, You can obtain one at https://mozilla.org/MPL/2.0/. */

"use client";

import { useCallback, useEffect, useMemo, useRef, useState } from "react";
import { useSearchParams } from "next/navigation";
import ReactMarkdown, { type Components } from "react-markdown";
import remarkGfm from "remark-gfm";
import {
  GuideRailHorizontal,
  GuideRailVertical,
} from "@/components/guide-rail";
import { Card } from "@/components/ui/card";
import type { GuideDocument } from "@/lib/guides/sections";

export interface GuideTabDef extends GuideDocument {
  id: string;
  label: string;
  /** Optional extra content, shown as a final card (e.g. the live registry). */
  append?: React.ReactNode;
}

/**
 * The card every guide section sits in: the shell Account and Preferences use,
 * with their padding and shadow. `md:w-1/2` is deliberately not carried over —
 * that is those forms narrowing a column of short inputs, not part of the card.
 */
const SECTION_CARD = "p-4 shadow-sm";

const MARKDOWN_COMPONENTS: Components = {
  // A tier above the `##` card headings below it, and a tier below the page
  // title in the header block — the document title is the middle rung of that
  // ladder, and reading as the same size as its own sections flattened it.
  h1: (props) => <h1 className="text-xl font-semibold" {...props} />,
  // No `id` here: each section is its own card now, and the card carries the
  // anchor. Two ids for one section would be one too many for getElementById.
  h2: (props) => (
    <h2 className="mt-8 text-lg font-semibold first:mt-0" {...props} />
  ),
  h3: (props) => <h3 className="mt-6 text-sm font-semibold" {...props} />,
  p: (props) => <p className="mt-3 text-sm text-muted-foreground" {...props} />,
  ul: (props) => (
    <ul
      className="mt-3 list-inside list-disc space-y-1 text-sm text-muted-foreground"
      {...props}
    />
  ),
  ol: (props) => (
    <ol
      className="mt-3 list-inside list-decimal space-y-2 text-sm text-muted-foreground"
      {...props}
    />
  ),
  li: (props) => <li {...props} />,
  a: (props) => (
    <a
      className="underline hover:text-foreground"
      target={props.href?.startsWith("http") ? "_blank" : undefined}
      rel={props.href?.startsWith("http") ? "noopener noreferrer" : undefined}
      {...props}
    />
  ),
  strong: (props) => <strong className="text-foreground" {...props} />,
  blockquote: (props) => (
    <blockquote
      className="mt-4 rounded-md border border-border bg-muted/40 p-3 text-xs text-muted-foreground [&_p]:mt-0 [&_p]:text-xs"
      {...props}
    />
  ),
  pre: (props) => (
    <pre
      className="mt-3 overflow-x-auto rounded-lg border border-border bg-muted p-4 text-sm"
      {...props}
    />
  ),
  code: ({ className, children, ...rest }) => {
    const isBlock = /language-/.test(className ?? "");
    if (isBlock) {
      return (
        <code className={className} {...rest}>
          {children}
        </code>
      );
    }
    return (
      <code className="rounded bg-muted px-1.5 py-0.5 text-sm" {...rest}>
        {children}
      </code>
    );
  },
  table: (props) => (
    <div className="mt-4 overflow-x-auto rounded-lg border border-border">
      <table className="w-full text-sm" {...props} />
    </div>
  ),
  thead: (props) => <thead className="bg-muted/40" {...props} />,
  tr: (props) => (
    <tr className="border-b border-border last:border-b-0" {...props} />
  ),
  th: (props) => (
    <th
      className="px-4 py-2 text-left text-xs font-semibold uppercase tracking-wide"
      {...props}
    />
  ),
  td: (props) => (
    <td
      className="px-4 py-2 align-top text-sm text-muted-foreground"
      {...props}
    />
  ),
  hr: () => <hr className="my-6 border-border" />,
};

/**
 * A guide: its heading block, one section of prose at a time, and a rail of
 * every other section pinned alongside.
 *
 * WHY THE URL HOLDS THE SECTION. These are the pages the registry screens and
 * the slash-command docs point people at, and "read the Widgets guide" was not
 * something anyone could link to while the section lived in `useState`. The
 * section is written with `window.history.pushState`, which Next integrates
 * into its router: `useSearchParams` re-reads it, back and forward work, and
 * none of it costs a request for markdown the client already holds.
 *
 * WHY THE RAIL IS STICKY, NOT FIXED. The scrolling element on these pages is
 * `<main>` in the app layout, not the window. A `position: fixed` rail would
 * be measured against the viewport instead — floating over the header and
 * ignoring the page grid at every width. `sticky` pins against the same
 * ancestor that scrolls, which is what "always reachable" actually needs.
 */
export default function GuideTabsShell({
  tabs,
  header,
}: {
  tabs: GuideTabDef[];
  /** The guide's title, blurb and Claude Code callout, above the prose. */
  header?: React.ReactNode;
}) {
  const searchParams = useSearchParams();
  const fallbackId = tabs[0]?.id ?? "";

  // The URL is the source of truth, but only for a section that exists — a
  // stale or hand-typed `?tab=` falls back to the first rather than rendering
  // an empty page.
  const requestedId = searchParams.get("tab");
  const activeId = tabs.some((t) => t.id === requestedId)
    ? (requestedId as string)
    : fallbackId;
  const active = tabs.find((t) => t.id === activeId) ?? tabs[0];

  const headerRef = useRef<HTMLDivElement>(null);
  const articleRef = useRef<HTMLDivElement>(null);
  // Tagged with the section it was observed in, so switching sections
  // invalidates it by derivation rather than by a reset effect — a stale
  // heading from the previous document can never survive a tab change.
  const [spied, setSpied] = useState<{
    tabId: string;
    headingId: string;
  } | null>(null);
  const activeHeadingId = spied?.tabId === activeId ? spied.headingId : null;

  const railSections = useMemo(
    () =>
      tabs.map((t) => ({
        id: t.id,
        label: t.label,
        headings: t.sections.map((s) => ({ id: s.id, text: s.text })),
      })),
    [tabs],
  );

  // A document with no `##` at all still gets a card — one holding the whole
  // thing — rather than falling out of the card treatment entirely.
  const cards = useMemo(() => {
    if (!active) return [];
    return active.sections.length > 0
      ? active.sections
      : [{ id: "", text: "", markdown: active.intro }];
  }, [active]);
  const intro = active && active.sections.length > 0 ? active.intro : "";

  const selectSection = useCallback(
    (id: string) => {
      const params = new URLSearchParams(searchParams.toString());
      params.set("tab", id);
      window.history.pushState(null, "", `?${params.toString()}`);
      // Section changed, so the reader is at the top of a new document — but
      // only because they asked. Doing this in an effect would also fire on a
      // deep link, fighting the hash we are about to honour.
      headerRef.current?.scrollIntoView({ block: "start" });
    },
    [searchParams],
  );

  const selectHeading = useCallback(
    (headingId: string) => {
      document.getElementById(headingId)?.scrollIntoView({
        behavior: "smooth",
        block: "start",
      });
      // `replaceState`, not push: a reader running down the rail would
      // otherwise have to press back once per heading to leave the page.
      const params = new URLSearchParams(searchParams.toString());
      params.set("tab", activeId);
      window.history.replaceState(
        null,
        "",
        `?${params.toString()}#${headingId}`,
      );
    },
    [searchParams, activeId],
  );

  // A `#heading` in the URL is honoured once the section it belongs to is
  // rendered — the element does not exist until then, so the browser's own
  // fragment scroll on load always misses it. Only the scroll happens here;
  // the observer below reads the position it lands on and lights the rail.
  useEffect(() => {
    const hash = window.location.hash.slice(1);
    if (!hash) return;
    if (!active?.sections.some((sec) => sec.id === hash)) return;
    document.getElementById(hash)?.scrollIntoView({ block: "start" });
  }, [active]);

  // Which section card the reader is on, for the rail.
  //
  // The bottom margin collapses the observation window to the top third of the
  // viewport: without it every card on a short document is intersecting at
  // once, and the rail would light up the last one rather than the one being
  // read. Viewport-rooted works even though `<main>` is what scrolls, because
  // `<main>` fills the viewport below the header.
  useEffect(() => {
    const ids = cards.map((c) => c.id).filter(Boolean);
    const elements = ids
      .map((id) => document.getElementById(id))
      .filter((el): el is HTMLElement => el !== null);
    if (elements.length === 0) return;

    const visible = new Set<string>();
    const observer = new IntersectionObserver(
      (entries) => {
        for (const entry of entries) {
          if (entry.isIntersecting) visible.add(entry.target.id);
          else visible.delete(entry.target.id);
        }
        const current = elements.find((el) => visible.has(el.id));
        if (current) setSpied({ tabId: activeId, headingId: current.id });
      },
      { rootMargin: "0px 0px -66% 0px", threshold: 0 },
    );

    elements.forEach((el) => observer.observe(el));
    return () => observer.disconnect();
  }, [activeId, cards]);

  return (
    <div className="grid gap-8 xl:grid-cols-[minmax(0,1fr)_14rem]">
      <div className="min-w-0">
        <div ref={headerRef} className="scroll-mt-4">
          {header}
        </div>

        <div className="mt-6 xl:hidden">
          <GuideRailHorizontal
            sections={railSections}
            activeId={activeId}
            onSelect={selectSection}
          />
        </div>

        {active && (
          <div ref={articleRef}>
            {intro && (
              <div className="mt-6">
                <ReactMarkdown
                  remarkPlugins={[remarkGfm]}
                  components={MARKDOWN_COMPONENTS}
                >
                  {intro}
                </ReactMarkdown>
              </div>
            )}

            <div className="mt-6 space-y-4">
              {cards.map((card, i) => (
                <Card
                  key={card.id || `card-${i}`}
                  id={card.id || undefined}
                  className={SECTION_CARD}
                >
                  <ReactMarkdown
                    remarkPlugins={[remarkGfm]}
                    components={MARKDOWN_COMPONENTS}
                  >
                    {card.markdown}
                  </ReactMarkdown>
                </Card>
              ))}
              {active.append && (
                <Card className={SECTION_CARD}>{active.append}</Card>
              )}
            </div>
          </div>
        )}
      </div>

      <div className="hidden xl:block">
        <div className="sticky top-4 max-h-[calc(100dvh-9rem)] overflow-y-auto pb-4">
          <GuideRailVertical
            sections={railSections}
            activeId={activeId}
            activeHeadingId={activeHeadingId}
            onSelect={selectSection}
            onSelectHeading={selectHeading}
          />
        </div>
      </div>
    </div>
  );
}
