/* This Source Code Form is subject to the terms of the Mozilla Public
 * License, v. 2.0. If a copy of the MPL was not distributed with this
 * file, You can obtain one at https://mozilla.org/MPL/2.0/. */

import { ExternalLink } from "lucide-react";
import { CARD_SHELL } from "@/components/ui/card";
import Notice from "@/components/ui/notice";
import { StatusPill } from "@/components/ui/status";
import { requireAdmin } from "@/lib/apps/access";
import { formatLastUpdated } from "@/lib/apps/display";
import { requireReadOnlySession } from "@/lib/auth/session";
import { readProposals } from "@/lib/github/proposals";
import { KIND_LABEL, type ExtensionKind } from "@/lib/repository/types";
import { cn } from "@/lib/utils";

/**
 * The GitHub App's open pull requests for one kind, beside the installs
 * waiting on Admin > Apps, Connectors and Themes, with what their checks say
 * (src/lib/github/proposals.ts): installs, and updates and removals of what
 * the build runs, each said as such. Nothing when the App is off or nothing is
 * linked, or when none are open.
 *
 * Read from GitHub on every render, so the pages wrap it in Suspense: the rest
 * of the page doesn't wait for it.
 */
export default async function ProposedPullRequests({ kind }: { kind: ExtensionKind }) {
  const session = await requireReadOnlySession();
  const user = await requireAdmin(session);
  const view = await readProposals({ id: user.id, email: user.email }, kind);
  const heading = `proposed-${kind}`;

  if (view.state === "off") return null;
  if (view.state === "unavailable") {
    return (
      <section aria-labelledby={heading} className="mb-8">
        <h2 id={heading} className="sr-only">
          Pull requests the GitHub App opened
        </h2>
        <Notice tone="neutral">
          <p className="break-words">{view.message}</p>
        </Notice>
      </section>
    );
  }
  if (view.pulls.length === 0) return null;

  const many = KIND_LABEL[kind].many.toLowerCase();
  return (
    <section aria-labelledby={heading} className="mb-8">
      <h2 id={heading} className="text-lg font-medium text-foreground">
        Proposed on GitHub
      </h2>
      <p className="mt-1 text-sm text-muted-foreground">
        Pull requests the GitHub App opened on{" "}
        <a href={view.repositoryUrl} target="_blank" rel="noreferrer noopener" className="underline underline-offset-2">
          {view.repository}
        </a>{" "}
        to add, update or remove {many}. Merging one is the deploy; reverting the merge is the way back.
      </p>
      <ul className="mt-4 grid gap-4 sm:grid-cols-2 lg:grid-cols-3">
        {view.pulls.map((pull) => (
          <li key={pull.number} className={cn(CARD_SHELL, "flex flex-col p-5")}>
            <h3 className="truncate text-lg font-medium text-foreground" title={pull.slug}>
              {pull.slug}
            </h3>
            <div className="mt-2 flex flex-wrap items-center gap-1.5">
              <StatusPill tone={pull.ci.tone}>{pull.ci.label}</StatusPill>
              {pull.changed && <StatusPill tone="warning">Changed since proposed</StatusPill>}
              {pull.unrecorded && <StatusPill tone="warning">Not proposed from here</StatusPill>}
              {pull.action === "install" && pull.version && <StatusPill tone="neutral">Add {pull.version}</StatusPill>}
              {pull.action === "update" && (
                <StatusPill tone="neutral">Update{pull.version ? ` to ${pull.version}` : ""}</StatusPill>
              )}
              {pull.action === "remove" && (
                <StatusPill tone="neutral">Remove{pull.version ? ` ${pull.version}` : ""}</StatusPill>
              )}
            </div>
            {pull.proposedAt && pull.proposedBy && (
              <p className="mt-3 text-xs text-muted-foreground">
                Proposed {formatLastUpdated(Date.parse(pull.proposedAt))} by {pull.proposedBy}
              </p>
            )}
            <p className="mt-1 text-xs text-muted-foreground">
              <code className="break-all font-mono">{pull.branch}</code>
            </p>
            <p className="mt-3 text-sm text-foreground">{pull.ci.detail}</p>
            {pull.changed && (
              <p className="mt-2 text-sm text-foreground">
                Someone pushed to this branch after the App opened it, so it isn&apos;t only what was verified. Read
                those commits before you merge.
              </p>
            )}
            {pull.unrecorded && (
              <p className="mt-2 text-sm text-foreground">
                This instance has no record of proposing it, so nothing here says what it was meant to hold.
              </p>
            )}
            <div className="mt-auto pt-4">
              <a
                href={pull.url}
                target="_blank"
                rel="noreferrer noopener"
                className="inline-flex items-center gap-1 text-sm font-medium text-foreground underline underline-offset-2 hover:no-underline"
              >
                Pull request #{pull.number}
                <ExternalLink className="h-3.5 w-3.5 shrink-0" aria-hidden />
                <span className="sr-only"> (opens in a new tab)</span>
              </a>
            </div>
          </li>
        ))}
      </ul>
      {view.more > 0 && (
        <p className="mt-3 text-sm text-muted-foreground">
          And {view.more} more on GitHub.
        </p>
      )}
    </section>
  );
}
