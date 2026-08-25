"use client";

import { useState } from "react";
import ReactMarkdown, { type Components } from "react-markdown";
import remarkGfm from "remark-gfm";

export interface GuideTabDef {
  id: string;
  label: string;
  markdown: string;
  /** Optional extra content appended below the rendered markdown (e.g. dynamic lists). */
  append?: React.ReactNode;
}

const MARKDOWN_COMPONENTS: Components = {
  h1: (props) => <h1 className="text-lg font-semibold" {...props} />,
  h2: (props) => <h2 className="mt-8 text-lg font-semibold first:mt-0" {...props} />,
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
  tr: (props) => <tr className="border-b border-border last:border-b-0" {...props} />,
  th: (props) => (
    <th className="px-4 py-2 text-left text-xs font-semibold uppercase tracking-wide" {...props} />
  ),
  td: (props) => (
    <td className="px-4 py-2 align-top text-sm text-muted-foreground" {...props} />
  ),
  hr: () => <hr className="my-6 border-border" />,
};

export default function GuideTabsShell({
  tabs,
  initialTabId,
}: {
  tabs: GuideTabDef[];
  initialTabId?: string;
}) {
  const [activeId, setActiveId] = useState<string>(initialTabId ?? tabs[0]?.id ?? "");
  const active = tabs.find((t) => t.id === activeId) ?? tabs[0];

  return (
    <div className="mt-6">
      <div className="flex gap-1 border-b border-border overflow-x-auto">
        {tabs.map((t) => (
          <button
            key={t.id}
            onClick={() => setActiveId(t.id)}
            className={`px-4 py-2 text-sm font-medium transition-colors whitespace-nowrap ${
              t.id === active?.id
                ? "border-b-2 border-mixnavy text-foreground"
                : "text-muted-foreground hover:text-foreground"
            }`}
          >
            {t.label}
          </button>
        ))}
      </div>

      {active && (
        <div className="mt-6">
          <ReactMarkdown remarkPlugins={[remarkGfm]} components={MARKDOWN_COMPONENTS}>
            {active.markdown}
          </ReactMarkdown>
          {active.append}
        </div>
      )}
    </div>
  );
}
