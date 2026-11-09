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
import { mixosUpdateOffer } from "@/lib/github/update-pull";
import { releaseCheckView } from "@/lib/platform/release-check";
import { cn } from "@/lib/utils";
import UpdatePullRequestButton from "../update-pull-request";

/**
 * The GitHub App's open MixOS update pull requests, on Developers > GitHub App, with
 * what their checks say (src/lib/github/proposals.ts): "No CI ran" and
 * "Changed since proposed" as for an extension's. Here and not on the release
 * notice, which is on every admin page: this reads GitHub, and the notice
 * reads only what this instance stores.
 *
 * When the pull request this instance opened for the current release is no
 * longer open here (closed, or merged and not yet deployed), the notice still
 * names it; this section says so and offers to open another. Nothing when the
 * App is off or nothing is linked, or when there is nothing to say.
 *
 * Read from GitHub on every render, so the page wraps it in Suspense.
 */
export default async function UpdatePullRequests() {
  const session = await requireReadOnlySession();
  const user = await requireAdmin(session);
  const view = await readProposals({ id: user.id, email: user.email }, "mixos");
  if (view.state === "off") return null;

  const heading = "proposed-mixos";
  if (view.state === "unavailable") {
    return (
      <section aria-labelledby={heading} className="space-y-4">
        <h2 id={heading} className="text-lg font-medium text-foreground">
          MixOS update pull requests
        </h2>
        <Notice tone="neutral">
          <p className="break-words">{view.message}</p>
        </Notice>
      </section>
    );
  }

  // The current release, and the pull request this instance recorded for it.
  const releases = await releaseCheckView();
  const recorded = releases.notice ? await mixosUpdateOffer(releases.notice) : null;
  const gone =
    recorded?.kind === "proposed" && !view.pulls.some((pull) => pull.number === recorded.number) ? recorded : null;
  const again = gone && releases.notice ? await mixosUpdateOffer(releases.notice, { evenIfProposed: true }) : null;

  if (view.pulls.length === 0 && !gone) return null;

  return (
    <section aria-labelledby={heading} className="space-y-4">
      <div>
        <h2 id={heading} className="text-lg font-medium text-foreground">
          MixOS update pull requests
        </h2>
        <p className="mt-1 text-sm text-muted-foreground">
          Pull requests the GitHub App opened on{" "}
          <a href={view.repositoryUrl} target="_blank" rel="noreferrer noopener" className="underline underline-offset-2">
            {view.repository}
          </a>{" "}
          to update MixOS to a release. Merging one is the deploy; nothing here merges.
        </p>
      </div>
      {gone && (
        <Notice tone="info">
          <p className="break-words">
            Pull request #{gone.number} for {gone.tag}, opened from here{" "}
            {formatLastUpdated(Date.parse(gone.at), "earlier")} by {gone.by}, isn&apos;t open on {gone.repository} any
            more. If it was merged, the next deploy carries the release. If it was closed, delete its branch on GitHub,
            then open another.
          </p>
          {again?.kind === "fork" && (
            <div className="mt-3">
              <UpdatePullRequestButton offer={again} />
            </div>
          )}
        </Notice>
      )}
      {view.pulls.length > 0 && (
        <ul className="grid gap-4 sm:grid-cols-2 lg:grid-cols-3">
          {view.pulls.map((pull) => (
            <li key={pull.number} className={cn(CARD_SHELL, "flex flex-col p-5")}>
              <h3 className="truncate text-lg font-medium text-foreground" title={pull.slug}>
                Update MixOS to {pull.slug}
              </h3>
              <div className="mt-2 flex flex-wrap items-center gap-1.5">
                <StatusPill tone={pull.ci.tone}>{pull.ci.label}</StatusPill>
                {pull.changed && <StatusPill tone="warning">Changed since proposed</StatusPill>}
                {pull.unrecorded && <StatusPill tone="warning">Not opened from here</StatusPill>}
              </div>
              {pull.proposedAt && pull.proposedBy && (
                <p className="mt-3 text-xs text-muted-foreground">
                  Opened {formatLastUpdated(Date.parse(pull.proposedAt))} by {pull.proposedBy}
                </p>
              )}
              <p className="mt-1 text-xs text-muted-foreground">
                <code className="break-all font-mono">{pull.branch}</code>
              </p>
              <p className="mt-3 text-sm text-foreground">{pull.ci.detail}</p>
              {pull.changed && (
                <p className="mt-2 text-sm text-foreground">
                  Someone pushed to this branch after the App opened it, so it isn&apos;t only the release&apos;s commit
                  GitHub confirmed. Read those commits before you merge.
                </p>
              )}
              {pull.unrecorded && (
                <p className="mt-2 text-sm text-foreground">
                  This instance has no record of opening it, so nothing here says its commit was confirmed as the
                  release&apos;s.
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
      )}
      {view.more > 0 && <p className="text-sm text-muted-foreground">And {view.more} more on GitHub.</p>}
    </section>
  );
}
