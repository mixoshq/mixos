/* This Source Code Form is subject to the terms of the Mozilla Public
 * License, v. 2.0. If a copy of the MPL was not distributed with this
 * file, You can obtain one at https://mozilla.org/MPL/2.0/. */

"use client";

/** The small pieces Admin > GitHub's components share. */

import type { ReactNode } from "react";
import { ExternalLink } from "lucide-react";
import Notice from "@/components/ui/notice";
import { formatLastUpdated } from "@/lib/apps/display";
import type { GitHubOutcome } from "@/lib/github/outcomes";

/** A link to GitHub, opening in a new tab. */
export function GitHubLink({ href, children }: { href: string; children: ReactNode }) {
  return (
    <a
      href={href}
      target="_blank"
      rel="noreferrer noopener"
      className="inline-flex items-center gap-1 font-medium text-foreground underline underline-offset-2 hover:no-underline"
    >
      {children}
      <ExternalLink className="h-3.5 w-3.5 shrink-0" aria-hidden />
      <span className="sr-only"> (opens in a new tab)</span>
    </a>
  );
}

/** What an action answered, with its links. */
export function OutcomeNotice({ outcome }: { outcome: GitHubOutcome }) {
  return (
    <Notice tone={outcome.ok ? "success" : outcome.tone}>
      <p className="break-words">{outcome.message}</p>
      {outcome.links && outcome.links.length > 0 && (
        <p className="mt-2 flex flex-wrap gap-x-4 gap-y-1">
          {outcome.links.map((l) => (
            <GitHubLink key={l.href} href={l.href}>
              {l.label}
            </GitHubLink>
          ))}
        </p>
      )}
    </Notice>
  );
}

/** A fact and its value, one row of a card. */
export function Fact({ label, children }: { label: string; children: ReactNode }) {
  return (
    <div className="grid grid-cols-1 gap-0.5 py-2 sm:grid-cols-[160px_1fr] sm:gap-4">
      <dt className="text-sm text-muted-foreground">{label}</dt>
      <dd className="min-w-0 break-words text-sm text-foreground">{children}</dd>
    </div>
  );
}

export const when = (iso: string | null) => (iso ? formatLastUpdated(Date.parse(iso), "never") : "never");

export const OVERRIDE_TEXT = {
  "classic-protection": "Classic branch protection requires pull requests on this branch.",
  "free-private":
    "This private repository is on GitHub Free, which can't require pull requests. Only MixOS keeps the App's writes off this branch.",
} as const;

/** The permissions the App asks for, as GitHub's settings name them. */
const ASKS_FOR = [
  ["Contents", "Read and write"],
  ["Pull requests", "Read and write"],
  ["Checks", "Read"],
  ["Commit statuses", "Read"],
  ["Metadata", "Read"],
] as const;

export function PermissionsList() {
  return (
    <dl className="divide-y divide-border">
      {ASKS_FOR.map(([name, level]) => (
        <Fact key={name} label={name}>
          {level}
        </Fact>
      ))}
      <Fact label="Not asked for">Workflows, administration, and every webhook event</Fact>
    </dl>
  );
}
