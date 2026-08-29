/* This Source Code Form is subject to the terms of the Mozilla Public
 * License, v. 2.0. If a copy of the MPL was not distributed with this
 * file, You can obtain one at https://mozilla.org/MPL/2.0/. */

/**
 * A guide document, cut into the cards it is rendered as.
 *
 * Each `##` starts a new card, and the `id` minted here is what the card
 * carries and what the right-hand rail links to. Splitting on the server means
 * the anchor is decided in exactly one place — the client renders whatever
 * chunk it is handed and never has to re-derive a slug from rendered output to
 * match.
 */

export interface GuideSection {
  /** Anchor id, unique within the document. */
  id: string;
  /** The heading, as plain text, for the rail. */
  text: string;
  /** The section's markdown, heading included. */
  markdown: string;
}

export interface GuideDocument {
  /** Everything before the first `##` — the title and any lede. Rendered
   *  bare above the cards, the way a page `<h1>` sits above its card. */
  intro: string;
  sections: GuideSection[];
}

/**
 * Plain text out of a markdown heading: what a reader sees, not what the
 * author typed. `## \`auth.scopesUrl\`` reads as `auth.scopesUrl`.
 */
function stripInlineMarkdown(text: string): string {
  return text
    .replace(/`([^`]*)`/g, "$1")
    .replace(/\[([^\]]*)\]\([^)]*\)/g, "$1")
    .replace(/[*_~]/g, "")
    .trim();
}

export function slugify(text: string): string {
  return text
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, "-")
    .replace(/^-+|-+$/g, "");
}

function uniqueId(base: string, taken: Set<string>): string {
  const root = base || "section";
  let id = root;
  for (let n = 2; taken.has(id); n += 1) id = `${root}-${n}`;
  taken.add(id);
  return id;
}

/**
 * Cut a guide doc into cards at every `##`.
 *
 * Fenced blocks are tracked so a `## ` inside a shell sample cannot open a
 * card. Only H2 splits — H1 is the document title, which stays in the intro,
 * and H3 would shatter a seventeen-section guide into confetti.
 *
 * A repeated heading gets a `-2` suffix rather than being dropped: the id is
 * minted once, here, and stamped straight onto the card, so nothing downstream
 * has to reproduce the numbering to find its anchor.
 */
export function splitGuideSections(markdown: string): GuideDocument {
  const intro: string[] = [];
  const sections: GuideSection[] = [];
  const taken = new Set<string>();
  let fence: string | null = null;
  let current: { id: string; text: string; lines: string[] } | null = null;

  for (const line of markdown.split("\n")) {
    const fenceMatch = /^\s*(```+|~~~+)/.exec(line);
    if (fenceMatch) {
      if (fence === null) fence = fenceMatch[1][0];
      else if (fenceMatch[1][0] === fence) fence = null;
      (current ? current.lines : intro).push(line);
      continue;
    }

    const heading = fence === null ? /^##\s+(.+?)\s*#*\s*$/.exec(line) : null;
    if (heading) {
      if (current) {
        sections.push({
          id: current.id,
          text: current.text,
          markdown: current.lines.join("\n").trimEnd(),
        });
      }
      const text = stripInlineMarkdown(heading[1]);
      current = { id: uniqueId(slugify(text), taken), text, lines: [line] };
      continue;
    }

    (current ? current.lines : intro).push(line);
  }

  if (current) {
    sections.push({
      id: current.id,
      text: current.text,
      markdown: current.lines.join("\n").trimEnd(),
    });
  }

  return {
    // A doc whose lede ends in `---` would draw that rule immediately above the
    // first card's own border, which reads as a rendering fault rather than a
    // separator. The cards are the separation now.
    intro: intro.join("\n").trimEnd().replace(/\n+(-{3,}|\*{3,}|_{3,})$/, "").trimEnd(),
    sections,
  };
}
