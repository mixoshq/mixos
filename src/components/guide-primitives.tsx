"use client";

import { useState } from "react";
import { ChevronDown, ChevronRight } from "lucide-react";

export function Section({
  title,
  children,
}: {
  title: string;
  children: React.ReactNode;
}) {
  return (
    <section>
      <h2 className="text-lg font-semibold">{title}</h2>
      <div className="mt-3 space-y-3">{children}</div>
    </section>
  );
}

export function Code({ children }: { children: React.ReactNode }) {
  return (
    <code className="rounded bg-muted px-1.5 py-0.5 text-sm">{children}</code>
  );
}

export function Pre({ children }: { children: React.ReactNode }) {
  return (
    <pre className="mt-3 overflow-x-auto rounded-lg border border-border bg-muted p-4 text-sm">
      {children}
    </pre>
  );
}

export function Expander({
  title,
  defaultOpen = false,
  children,
}: {
  title: string;
  defaultOpen?: boolean;
  children: React.ReactNode;
}) {
  const [open, setOpen] = useState(defaultOpen);

  return (
    <div className="rounded-lg border border-border">
      <button
        onClick={() => setOpen(!open)}
        className="flex w-full items-center gap-2 px-4 py-3 text-left text-sm font-medium hover:bg-accent"
      >
        {open ? (
          <ChevronDown className="h-4 w-4 text-muted-foreground" />
        ) : (
          <ChevronRight className="h-4 w-4 text-muted-foreground" />
        )}
        {title}
      </button>
      {open && (
        <div className="border-t border-border px-4 py-3">{children}</div>
      )}
    </div>
  );
}

export function ManifestField({
  name,
  required,
  description,
  example,
}: {
  name: string;
  required?: boolean;
  description: React.ReactNode;
  example?: string;
}) {
  return (
    <div className="px-4 py-3">
      <div className="flex items-center gap-2">
        <p className="font-mono text-sm font-medium">{name}</p>
        {required && (
          <span className="rounded bg-destructive/10 px-1.5 py-0.5 text-xs font-medium text-destructive">
            required
          </span>
        )}
      </div>
      <p className="mt-0.5 text-sm text-muted-foreground">{description}</p>
      {example && (
        <code className="mt-1 block text-xs text-muted-foreground">{example}</code>
      )}
    </div>
  );
}
