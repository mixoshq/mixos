/* This Source Code Form is subject to the terms of the Mozilla Public
 * License, v. 2.0. If a copy of the MPL was not distributed with this
 * file, You can obtain one at https://mozilla.org/MPL/2.0/. */

"use client";

import type { GuideSection } from "@/lib/guides/sections";

export interface GuideRailSection {
  id: string;
  label: string;
  /** The section cards inside this guide section, as anchors. */
  headings: Pick<GuideSection, "id" | "text">[];
}

interface GuideRailProps {
  sections: GuideRailSection[];
  activeId: string;
  activeHeadingId: string | null;
  onSelect: (id: string) => void;
  onSelectHeading: (headingId: string) => void;
}

/**
 * The guide's own table of contents, kept apart from the settings sidebar on
 * the left.
 *
 * DELIBERATELY NOT `bg-brand`. The left sidebar owns that fill for "the page
 * you are on"; a second nav shouting the same colour would read as two
 * competing locations. A rule down the left edge and a weight change is the
 * documentation-TOC idiom, and it stays legible under every theme because it
 * leans on `border` and `foreground` rather than a fill that has to earn its
 * own contrast pair.
 */
export function GuideRailVertical({
  sections,
  activeId,
  activeHeadingId,
  onSelect,
  onSelectHeading,
}: GuideRailProps) {
  return (
    <nav aria-labelledby="guide-rail-label" className="text-sm">
      <h2
        id="guide-rail-label"
        className="mb-2 px-3 text-xs font-semibold uppercase tracking-widest text-muted-foreground"
      >
        On this page
      </h2>
      <ul className="border-l border-border">
        {sections.map((section) => {
          const isActive = section.id === activeId;
          return (
            <li key={section.id}>
              <button
                type="button"
                onClick={() => onSelect(section.id)}
                aria-current={isActive ? "page" : undefined}
                className={`-ml-px block w-full border-l-2 px-3 py-1.5 text-left transition-colors ${
                  isActive
                    ? "border-brand font-medium text-foreground"
                    : "border-transparent text-muted-foreground hover:border-border hover:text-foreground"
                }`}
              >
                {section.label}
              </button>

              {isActive && section.headings.length > 0 && (
                <ul className="mb-1">
                  {section.headings.map((heading) => (
                    <li key={heading.id}>
                      <button
                        type="button"
                        onClick={() => onSelectHeading(heading.id)}
                        // `location` rather than `page`: the section is the
                        // page you are on, the heading is where you are inside
                        // it. Two `aria-current="page"` in one nav is a lie.
                        aria-current={
                          heading.id === activeHeadingId ? "location" : undefined
                        }
                        className={`-ml-px block w-full border-l-2 py-1 pl-6 pr-3 text-left text-xs transition-colors ${
                          heading.id === activeHeadingId
                            ? "border-brand/60 text-foreground"
                            : "border-transparent text-muted-foreground hover:text-foreground"
                        }`}
                      >
                        {heading.text}
                      </button>
                    </li>
                  ))}
                </ul>
              )}
            </li>
          );
        })}
      </ul>
    </nav>
  );
}

/**
 * The same sections below `xl`, as the horizontal strip the guides had before.
 *
 * Sub-headings are dropped here on purpose. They are the part that only pays
 * for itself while it stays in view next to the prose — laid out in a row they
 * are a second scroller full of fragments, above a page that already has one.
 */
export function GuideRailHorizontal({
  sections,
  activeId,
  onSelect,
}: Pick<GuideRailProps, "sections" | "activeId" | "onSelect">) {
  return (
    <nav
      aria-label="Guide sections"
      className="flex gap-1 overflow-x-auto border-b border-border"
    >
      {sections.map((section) => {
        const isActive = section.id === activeId;
        return (
          <button
            key={section.id}
            type="button"
            onClick={() => onSelect(section.id)}
            aria-current={isActive ? "page" : undefined}
            className={`whitespace-nowrap px-4 py-2 text-sm font-medium transition-colors ${
              isActive
                ? "border-b-2 border-brand text-foreground"
                : "text-muted-foreground hover:text-foreground"
            }`}
          >
            {section.label}
          </button>
        );
      })}
    </nav>
  );
}
