/* This Source Code Form is subject to the terms of the Mozilla Public
 * License, v. 2.0. If a copy of the MPL was not distributed with this
 * file, You can obtain one at https://mozilla.org/MPL/2.0/. */

import type { ReactNode } from "react";
import { ArrowUpCircle } from "lucide-react";
import Notice from "@/components/ui/notice";
import { formatLastUpdated } from "@/lib/apps/display";
import type { UpdateOffer } from "@/lib/github/outcomes";
import {
  UPGRADE_COMMAND,
  WHAT_THE_RELEASE_CHECK_SENDS,
  mergeCommand,
  type ReleaseNotice as ReleaseNoticeData,
} from "@/lib/platform/releases";
import { CopyButton } from "./copy-button";
import ReleaseNotes from "./release-notes";
import UpdatePullRequestButton from "./update-pull-request";

/** The accent notice's links, as the admin pages' other callouts draw theirs. */
const ACCENT_LINK = "font-medium text-primary underline underline-offset-2";

/** A link out of MixOS, in a new tab, saying so to a screen reader. */
function Outbound({
  href,
  className = "underline underline-offset-2 hover:text-foreground",
  children,
}: {
  href: string;
  className?: string;
  children: ReactNode;
}) {
  return (
    <a href={href} target="_blank" rel="noreferrer noopener" className={className}>
      {children}
      <span className="sr-only"> (opens in a new tab)</span>
    </a>
  );
}

/** The full notice's anchor, which the banner on every other page links to (./release-banner.tsx). */
export const RELEASE_NOTICE_ID = "new-release";

/**
 * A newer release of MixOS, at the top of every admin page
 * (../settings/settings-shell.tsx), from the release check's last answer
 * (src/lib/platform/releases.ts says when one shows):
 *
 *   MixOS 0.5.0 is available (this instance runs 0.4.2). A minor release: it
 *   may need changes.
 *   ▸ Release notes
 *   v0.5.0 on mixos.org · How to upgrade
 *   To upgrade, run /mixos upgrade in Claude Code, in your copy of MixOS. [Copy]
 *   ▸ Or merge it by hand
 *
 * The notes stay collapsed until asked for, and their links are text
 * (./release-notes.tsx). The two links are built from the release's tag, never
 * taken from the answer, and so is the merge by hand.
 *
 * Nothing here applies anything. Taking a release is merging its tag into the
 * repository this instance is built from and deploying it, which an admin
 * page can't do and doesn't offer to: `/mixos upgrade` does the merge in the
 * admin's own copy, and the copy button only copies it. With the GitHub App
 * linked, `offer` (src/lib/github/update-pull.ts) adds one thing: on a fork of
 * upstream, a button that opens a pull request for the release, which an admin
 * then merges or not on GitHub; on any other repository, the compare link; and
 * once a pull request was opened from here, a link to it.
 */
export default function ReleaseNotice({ notice, offer = null }: { notice: ReleaseNoticeData; offer?: UpdateOffer | null }) {
  return (
    <section id={RELEASE_NOTICE_ID} aria-label="A new release of MixOS" className="mb-6 scroll-mt-4">
      <Notice tone="accent" icon={<ArrowUpCircle className="h-4 w-4" aria-hidden />}>
        <p>{notice.text}</p>
        {notice.notes.trim() !== "" && (
          <details className="mt-2">
            <summary className="cursor-pointer font-medium">Release notes</summary>
            <ReleaseNotes className="mt-2 border-l-2 border-border pl-3">{notice.notes}</ReleaseNotes>
          </details>
        )}
        <p className="mt-2 flex flex-wrap gap-x-4 gap-y-1">
          <Outbound href={notice.releaseUrl} className={ACCENT_LINK}>
            {notice.tag} on mixos.org
          </Outbound>
          <Outbound href={notice.upgradeUrl} className={ACCENT_LINK}>
            How to upgrade
          </Outbound>
        </p>
        <div className="mt-3 flex flex-wrap items-center gap-x-2 gap-y-1" data-upgrade-command>
          <p>
            To upgrade, run{" "}
            <code className="rounded border border-border bg-background px-1.5 py-0.5 font-mono text-xs">
              {UPGRADE_COMMAND}
            </code>{" "}
            in Claude Code, in your copy of MixOS.
          </p>
          <CopyButton text={UPGRADE_COMMAND} label="Copy" />
        </div>
        {offer && <Offer offer={offer} />}
        <details className="mt-3" data-merge-by-hand>
          <summary className="cursor-pointer font-medium">Or merge it by hand</summary>
          <div className="mt-2 space-y-2">
            <p>On a branch, in a checkout of your repository, as How to upgrade says:</p>
            <pre className="overflow-x-auto rounded-md border border-border bg-background px-3 py-2 font-mono text-xs">
              {mergeCommand(notice.tag)}
            </pre>
            {offer?.kind === "copy" && offer.compareUrl && (
              <p>
                <Outbound href={offer.compareUrl} className={ACCENT_LINK}>
                  What changed, on GitHub
                </Outbound>
              </p>
            )}
          </div>
        </details>
      </Notice>
    </section>
  );
}

/** What the GitHub App adds for the release, beside `/mixos upgrade`. */
function Offer({ offer }: { offer: UpdateOffer }) {
  switch (offer.kind) {
    case "fork":
      return (
        <div className="mt-3" data-update-offer="fork">
          <UpdatePullRequestButton offer={offer} />
        </div>
      );
    case "copy":
      // The merge by hand shows for every repository, with the compare link for this one.
      return null;
    case "proposed":
      return (
        <p className="mt-3" data-update-offer="proposed">
          <Outbound href={offer.url} className={ACCENT_LINK}>
            Pull request #{offer.number}
          </Outbound>{" "}
          for {offer.tag} was opened on{" "}
          {offer.repository} {formatLastUpdated(Date.parse(offer.at), "earlier")} by {offer.by}. Deployment &gt; GitHub App lists
          it with its checks. Merging it is the deploy.
        </p>
      );
  }
}

/**
 * The release check's muted line, under the build's version at the foot of
 * the admin pages: whether this instance checks, and when it last heard from
 * mixos.org, with a link to what it sends.
 */
export function ReleaseCheckStatus({ status }: { status: string }) {
  return (
    <p>
      {status} <Outbound href={WHAT_THE_RELEASE_CHECK_SENDS}>What&apos;s sent</Outbound>
    </p>
  );
}
