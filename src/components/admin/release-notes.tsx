/* This Source Code Form is subject to the terms of the Mozilla Public
 * License, v. 2.0. If a copy of the MPL was not distributed with this
 * file, You can obtain one at https://mozilla.org/MPL/2.0/. */

import type { Element, ElementContent } from "hast";
import type { ReactNode } from "react";
import ReactMarkdown, { type Components } from "react-markdown";
import remarkGfm from "remark-gfm";
import { cn } from "@/lib/utils";

/**
 * A MixOS release's notes, rendered by the rule mixos.org's own release pages
 * follow (`renderCoreReleaseNotes` in its src/lib/markdown.ts). Stricter than
 * `Markdown` from @/components/ui/markdown, which keeps links working and
 * images loading:
 *
 *  - Raw HTML is dropped (`skipHtml`). Text between two dropped tags stays.
 *  - Images are dropped, so nothing loads from wherever the notes point. The
 *    CSP allows images from any https host, and a tracking image would
 *    otherwise sit in front of every admin.
 *  - Every link is text: its own text, then its address in brackets, not
 *    clickable. An autolink, whose text is its address, reads once. A link
 *    whose address isn't http(s), mailto or a path, such as `javascript:`,
 *    keeps only its text, and so does a link to a place on the page.
 *  - Headings are bold lines. The notes sit in a notice above the page's own
 *    heading, so they add nothing to its outline.
 *
 * Why so strict: the notes are a section of the core's CHANGELOG.md, written
 * from commit subjects, and a merged pull request titled
 * `fix: [apply the security patch](https://…)` would otherwise be a working
 * link in a notice that speaks for MixOS, on every admin page. The notice's
 * only links are the two it builds itself (./release-notice.tsx).
 *
 * Here and not in src/components/ui, where everything is something an app may
 * import: this is for the admin pages alone.
 */

/** The schemes an address is shown for, as mixos.org's sanitiser allows them. */
const SHOWN_SCHEME = /^(https?|mailto)$/i;

/**
 * Keep an address that is http(s), mailto, or has no scheme, and blank any
 * other. Blanked, its link shows only its text. The address is only ever
 * printed, never followed, so this decides what is worth printing.
 */
export function notesUrl(url: string): string {
  const colon = url.indexOf(":");
  const slash = url.indexOf("/");
  const question = url.indexOf("?");
  const hash = url.indexOf("#");
  // A colon after a `/`, `?` or `#` isn't a scheme's: the address is a path.
  const relative =
    colon === -1 ||
    (slash !== -1 && colon > slash) ||
    (question !== -1 && colon > question) ||
    (hash !== -1 && colon > hash);
  return relative || SHOWN_SCHEME.test(url.slice(0, colon)) ? url : "";
}

/** The text inside a node, as a reader sees it. */
function textOf(node: Element | ElementContent): string {
  if (node.type === "text") return node.value;
  if (node.type === "element") return node.children.map(textOf).join("");
  return "";
}

/** Whether showing `address` after `text` would say the same thing twice. */
function sameAddress(text: string, address: string): boolean {
  return [text, `mailto:${text}`, `http://${text}`, `https://${text}`].includes(address);
}

const heading = ({ children }: { children?: ReactNode }) => (
  <p className="mt-3 font-semibold first:mt-0">{children}</p>
);

const COMPONENTS: Components = {
  a: ({ node, href, children }) => {
    const address = typeof href === "string" ? href : "";
    const shown =
      address && !address.startsWith("#") && !sameAddress(node ? textOf(node) : "", address)
        ? ` (${address})`
        : "";
    return (
      <>
        {children}
        {shown}
      </>
    );
  },
  h1: heading,
  h2: heading,
  h3: heading,
  h4: heading,
  h5: heading,
  h6: heading,
  p: ({ children }) => <p className="mt-2 first:mt-0">{children}</p>,
  ul: ({ children }) => <ul className="mt-2 list-disc space-y-1 pl-5 first:mt-0">{children}</ul>,
  ol: ({ children }) => <ol className="mt-2 list-decimal space-y-1 pl-5 first:mt-0">{children}</ol>,
  blockquote: ({ children }) => (
    <blockquote className="mt-2 border-l-2 border-border pl-3 text-muted-foreground first:mt-0">
      {children}
    </blockquote>
  ),
  hr: () => <hr className="my-3 border-border" />,
  pre: ({ children }) => (
    <pre className="mt-2 overflow-x-auto rounded-md border border-border bg-background p-2 text-xs first:mt-0 [&_code]:bg-transparent [&_code]:p-0">
      {children}
    </pre>
  ),
  code: ({ children }) => <code className="rounded bg-background px-1 py-0.5 text-[0.85em]">{children}</code>,
  table: ({ children }) => (
    <div className="mt-2 overflow-x-auto first:mt-0">
      <table className="w-full text-left">{children}</table>
    </div>
  ),
  th: ({ children }) => <th className="border-b border-border px-2 py-1 font-semibold">{children}</th>,
  td: ({ children }) => <td className="border-b border-border px-2 py-1">{children}</td>,
};

/** A MixOS release's notes, as untrusted Markdown: no HTML, no images, and links as text. */
export default function ReleaseNotes({ children, className }: { children: string; className?: string }) {
  return (
    <div className={cn("min-w-0 [overflow-wrap:anywhere]", className)}>
      <ReactMarkdown
        remarkPlugins={[remarkGfm]}
        skipHtml
        disallowedElements={["img"]}
        urlTransform={notesUrl}
        components={COMPONENTS}
      >
        {children}
      </ReactMarkdown>
    </div>
  );
}
