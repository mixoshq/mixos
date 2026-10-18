/* This Source Code Form is subject to the terms of the Mozilla Public
 * License, v. 2.0. If a copy of the MPL was not distributed with this
 * file, You can obtain one at https://mozilla.org/MPL/2.0/. */

import ReactMarkdown, { type Components } from "react-markdown";
import remarkGfm from "remark-gfm";
import { cn } from "@/lib/utils";

/**
 * The props react-markdown hands a component, minus `node`: the syntax-tree
 * element it came from. That is not an attribute, and spread onto a DOM element
 * it renders as `node="[object Object]"`.
 */
function attrs<P extends { node?: unknown }>(props: P): Omit<P, "node"> {
  const { ...rest } = props;
  delete rest.node;
  return rest;
}

/**
 * The theme's styling, element by element. Classes react-markdown sets itself
 * (GFM's `contains-task-list`, a fenced block's `language-*`) are kept.
 */
const COMPONENTS: Components = {
  h1: (props) => (
    <h1 {...attrs(props)} className={cn("mt-6 text-lg font-semibold first:mt-0", props.className)} />
  ),
  h2: (props) => (
    <h2 {...attrs(props)} className={cn("mt-6 text-base font-semibold first:mt-0", props.className)} />
  ),
  h3: (props) => (
    <h3 {...attrs(props)} className={cn("mt-4 text-sm font-semibold first:mt-0", props.className)} />
  ),
  p: (props) => (
    <p {...attrs(props)} className={cn("mt-3 text-sm text-muted-foreground first:mt-0", props.className)} />
  ),
  ul: (props) => (
    <ul
      {...attrs(props)}
      className={cn(
        "mt-3 list-inside list-disc space-y-1 text-sm text-muted-foreground first:mt-0",
        props.className,
      )}
    />
  ),
  ol: (props) => (
    <ol
      {...attrs(props)}
      className={cn(
        "mt-3 list-inside list-decimal space-y-1 text-sm text-muted-foreground first:mt-0",
        props.className,
      )}
    />
  ),
  li: (props) => <li {...attrs(props)} />,
  a: ({ href, ...props }) => {
    const external = href?.startsWith("http") ?? false;
    return (
      <a
        {...attrs(props)}
        href={href}
        className={cn("underline hover:text-foreground", props.className)}
        target={external ? "_blank" : undefined}
        rel={external ? "noopener noreferrer" : undefined}
      />
    );
  },
  // A URL the transform blanked (`javascript:` and the like) leaves nothing to
  // show, and an empty `src` would make the browser fetch the page itself.
  img: ({ src, alt, ...props }) =>
    src ? (
      // eslint-disable-next-line @next/next/no-img-element -- an arbitrary URL of unknown size; next/image needs both known up front
      <img
        {...attrs(props)}
        src={src}
        alt={alt ?? ""}
        className={cn("inline-block max-w-full rounded-md", props.className)}
        loading="lazy"
        referrerPolicy="no-referrer"
      />
    ) : null,
  strong: (props) => <strong {...attrs(props)} className={cn("text-foreground", props.className)} />,
  blockquote: (props) => (
    <blockquote
      {...attrs(props)}
      className={cn(
        "mt-3 rounded-md border border-border p-3 text-sm text-muted-foreground first:mt-0 [&_p]:mt-0",
        props.className,
      )}
    />
  ),
  hr: (props) => <hr {...attrs(props)} className={cn("my-4 border-border", props.className)} />,
  pre: (props) => (
    <pre
      {...attrs(props)}
      className={cn(
        "mt-3 overflow-x-auto rounded-md border border-border bg-muted p-3 text-sm first:mt-0",
        props.className,
      )}
    />
  ),
  code: ({ className, ...props }) => (
    <code
      {...attrs(props)}
      className={
        /language-/.test(className ?? "")
          ? className
          : "rounded bg-muted px-1.5 py-0.5 text-sm"
      }
    />
  ),
  table: (props) => (
    <div className="mt-3 overflow-x-auto rounded-md border border-border first:mt-0">
      <table {...attrs(props)} className={cn("w-full text-sm", props.className)} />
    </div>
  ),
  th: (props) => (
    <th
      {...attrs(props)}
      className={cn("border-b border-border px-3 py-2 text-left font-semibold", props.className)}
    />
  ),
  td: (props) => (
    <td
      {...attrs(props)}
      className={cn("border-b border-border px-3 py-2 text-muted-foreground", props.className)}
    />
  ),
};

/**
 * Markdown, rendered safely: the way an app puts formatted text it did not
 * write on the page.
 *
 * Apps may not render raw markup. `dangerouslySetInnerHTML`, `innerHTML` and
 * the rest are refused by lint and by the registry generator's containment scan
 * (scripts/app-containment.ts), and no escape lets an app do its own
 * sanitizing.
 * Text from a CMS connector, a README or a person's notes comes through here:
 *
 *  - Raw HTML tags in the Markdown are DROPPED (`skipHtml`) and never become
 *    elements: `<script>`, `<img onerror>` and `<iframe>` included, whatever
 *    the source. Text between two dropped tags stays, as text.
 *  - Link and image URLs go through react-markdown's default `urlTransform`,
 *    which keeps http(s), mailto and relative URLs and blanks `javascript:` and
 *    the other script-bearing schemes. An image left with no URL is not
 *    rendered.
 *  - External links open in a new tab, with `noopener noreferrer`. Images load
 *    lazily and without a referrer, so the host of a pasted image does not
 *    learn which page it was viewed on.
 *
 * No hooks, so it renders in a server page and in a client widget alike. Type
 * stays at body sizes; colours are the theme's tokens, so it reads right under
 * every theme.
 */
export function Markdown({
  children,
  className,
}: {
  /** The Markdown source. Raw HTML in it is dropped, not rendered. */
  children: string;
  className?: string;
}) {
  return (
    <div className={cn("min-w-0 break-words", className)}>
      <ReactMarkdown remarkPlugins={[remarkGfm]} skipHtml components={COMPONENTS}>
        {children}
      </ReactMarkdown>
    </div>
  );
}
