/* This Source Code Form is subject to the terms of the Mozilla Public
 * License, v. 2.0. If a copy of the MPL was not distributed with this
 * file, You can obtain one at https://mozilla.org/MPL/2.0/. */

import type { ReactNode } from "react";
import { ArrowUpCircle } from "lucide-react";
import Notice from "@/components/ui/notice";
import { formatLastUpdated } from "@/lib/apps/display";
import type { UpdateOffer } from "@/lib/github/outcomes";
import { WHAT_THE_RELEASE_CHECK_SENDS, type ReleaseNotice as ReleaseNoticeData } from "@/lib/platform/releases";
import ReleaseNotes from "./release-notes";
import UpdatePullRequestButton from "./update-pull-request";

/** A link out of MixOS, in a new tab, saying so to a screen reader. */
function Outbound({ href, children }: { href: string; children: ReactNode }) {
  return (
    <a
      href={href}
      target="_blank"
      rel="noreferrer noopener"
      className="underline underline-offset-2 hover:text-foreground"
    >
      {children}
      <span className="sr-only"> (opens in a new tab)</span>
    </a>
  );
}

/**
 * A newer release of MixOS, at the top of every admin page
 * (../settings/settings-shell.tsx), from the release check's last answer
 * (src/lib/platform/releases.ts says when one shows):
 *
 *   MixOS 0.5.0 is available (this instance runs 0.4.2). A minor release: it
 *   may need changes.
 *   ▸ Release notes
 *   v0.5.0 on mixos.org · How to upgrade
 *
 * The notes stay collapsed until asked for, and their links are text
 * (./release-notes.tsx). The two links are built from the release's tag, never
 * taken from the answer.
 *
 * Nothing here applies anything. Taking a release is merging its tag into the
 * repository this instance is built from and deploying it, which an admin
 * page can't do and doesn't offer to. With the GitHub App linked, `offer`
 * (src/lib/github/update-pull.ts) adds one thing under the links: on a fork
 * of upstream, a button that opens a pull request for the release, which an
 * admin then merges or not on GitHub; on any other repository, the merge by
 * hand; and once a pull request was opened from here, a link to it. Without
 * the App, the notice is as above.
 */
export default function ReleaseNotice({ notice, offer = null }: { notice: ReleaseNoticeData; offer?: UpdateOffer | null }) {
  return (
    <section aria-label="A new release of MixOS" className="mb-6">
      <Notice tone="neutral" icon={<ArrowUpCircle className="h-4 w-4" aria-hidden />}>
        <p>{notice.text}</p>
        {notice.notes.trim() !== "" && (
          <details className="mt-2">
            <summary className="cursor-pointer font-medium">Release notes</summary>
            <ReleaseNotes className="mt-2 border-l-2 border-border pl-3">{notice.notes}</ReleaseNotes>
          </details>
        )}
        <p className="mt-2 flex flex-wrap gap-x-4 gap-y-1">
          <Outbound href={notice.releaseUrl}>{notice.tag} on mixos.org</Outbound>
          <Outbound href={notice.upgradeUrl}>How to upgrade</Outbound>
        </p>
        {offer && <Offer offer={offer} />}
      </Notice>
    </section>
  );
}

/** What the GitHub App offers for the release, under the links. */
function Offer({ offer }: { offer: UpdateOffer }) {
  switch (offer.kind) {
    case "fork":
      return (
        <div className="mt-3" data-update-offer="fork">
          <UpdatePullRequestButton offer={offer} />
        </div>
      );
    case "copy":
      return (
        <div className="mt-3 space-y-2" data-update-offer="copy">
          <p>
            {offer.repository} isn&apos;t a fork of mixoshq/mixos, so the GitHub App can&apos;t open an update pull
            request there. Merge the release by hand, on a branch:
          </p>
          <pre className="overflow-x-auto rounded-md border border-border bg-background px-3 py-2 font-mono text-xs">
            {offer.command}
          </pre>
          {offer.compareUrl && (
            <p>
              <Outbound href={offer.compareUrl}>What changed, on GitHub</Outbound>
            </p>
          )}
        </div>
      );
    case "proposed":
      return (
        <p className="mt-3" data-update-offer="proposed">
          <Outbound href={offer.url}>Pull request #{offer.number}</Outbound> for {offer.tag} was opened on{" "}
          {offer.repository} {formatLastUpdated(Date.parse(offer.at), "earlier")} by {offer.by}. Admin &gt; GitHub lists
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
