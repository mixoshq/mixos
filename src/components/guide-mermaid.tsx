/* This Source Code Form is subject to the terms of the Mozilla Public
 * License, v. 2.0. If a copy of the MPL was not distributed with this
 * file, You can obtain one at https://mozilla.org/MPL/2.0/. */

"use client";

import { useEffect, useRef, useState } from "react";

/**
 * Renders one ```mermaid fence from the guide markdown as a diagram.
 *
 * WHY THIS EXISTS
 * ---------------
 * `docs/apps/*.md` and `docs/connectors/*.md` are rendered in two places: here,
 * in the admin guides, and on mixos.org, which renders them to static SVG at
 * build time. Without this component a diagram authored as ```mermaid would
 * show an admin raw Mermaid source where a picture used to be — so the two
 * renderers have to keep pace with each other.
 *
 * WHY CLIENT-SIDE HERE AND BUILD-TIME THERE
 * -----------------------------------------
 * mixos.org renders at build time because its diagrams have to be readable by
 * crawlers that run no JavaScript. This is an authenticated admin page behind a
 * session check; nothing crawls it, so the 3 MB of Mermaid is better spent as a
 * dynamic import that only the guides pay for than as a build dependency on a
 * page nobody indexes.
 *
 * The import is deliberately inside the effect rather than at module scope, so
 * the cost lands when a guide tab is actually opened.
 */
export function GuideMermaid({ code }: { code: string }) {
  const ref = useRef<HTMLDivElement>(null);
  const [failed, setFailed] = useState(false);

  useEffect(() => {
    let cancelled = false;

    void (async () => {
      try {
        const mermaid = (await import("mermaid")).default;

        mermaid.initialize({
          startOnLoad: false,
          // `neutral` is the one built-in that stays legible on both the light
          // and dark themes. A theme-matched palette would mean re-rendering on
          // every theme change; the diagrams are not worth that coupling.
          theme: "neutral",
          securityLevel: "strict",
          // Labels as SVG <text>, not HTML in a <foreignObject>. MUST MATCH
          // mixos.org (its astro.config.mjs), for the same reason as the width
          // below — one diagram, two renderers.
          //
          // This is not cosmetic. A foreignObject label serializes `<br/>` as
          // `<br></br>`, and the HTML parser treats `</br>` as a START tag — so
          // the string this component assigns to innerHTML would gain a line
          // break per break, and every multi-line label would lose its last
          // line off the bottom of its box.
          //
          // Consequence: a label must not contain `<b>` / `<i>`, which would
          // render literally.
          htmlLabels: false,
          flowchart: {
            htmlLabels: false,
            // MUST MATCH mixos.org's build-time renderer (its astro.config.mjs).
            // These diagrams are authored once, in docs/, and rendered in two
            // places; a width that differs between them means a diagram that
            // reads correctly on the docs site and is clipped here.
            //
            // Mermaid defaults this to 200px and lays a longer label out in a
            // fixed-width div with `white-space: break-spaces`. That wraps prose
            // but cannot break a token like
            // `createAppClient(slug).get('/path')`, which has no space in it —
            // so it overflows and the foreignObject clips it, silently.
            wrappingWidth: 460,
          },
        });

        // A unique id per render: Mermaid keys its internal state on it, and a
        // collision between two diagrams on one tab renders the second as the
        // first.
        const id = `guide-mermaid-${Math.random().toString(36).slice(2)}`;
        const { svg } = await mermaid.render(id, code);

        if (!cancelled && ref.current) ref.current.innerHTML = svg;
      } catch {
        // A malformed diagram must not take the guide down with it. Fall back
        // to the source, which is still the most useful thing we can show.
        if (!cancelled) setFailed(true);
      }
    })();

    return () => {
      cancelled = true;
    };
  }, [code]);

  if (failed) {
    return (
      <pre className="mt-3 overflow-x-auto rounded-lg border border-border bg-muted p-4 text-sm">
        <code>{code}</code>
      </pre>
    );
  }

  return (
    <div
      ref={ref}
      // overflow-x-auto because a wide flowchart must scroll inside its own box
      // rather than widening the whole guide panel.
      className="mt-3 overflow-x-auto rounded-lg border border-border bg-card p-4 [&_svg]:mx-auto [&_svg]:h-auto [&_svg]:max-w-full"
    />
  );
}
