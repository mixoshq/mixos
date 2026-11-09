/* This Source Code Form is subject to the terms of the Mozilla Public
 * License, v. 2.0. If a copy of the MPL was not distributed with this
 * file, You can obtain one at https://mozilla.org/MPL/2.0/. */

"use client";

import { useState } from "react";
import { useRouter } from "next/navigation";
import { ExternalLink, GitPullRequest } from "lucide-react";
import { Button } from "@/components/ui/button";
import { Dialog } from "@/components/ui/dialog";
import Notice from "@/components/ui/notice";
import type { UpdateOffer, UpdateOutcome } from "@/lib/github/outcomes";
import { proposeMixOSUpdateAction } from "@/lib/github/update-pull-actions";
import WithCode from "./pending/with-code";

/**
 * "Open an update pull request": the one thing the release notice offers to
 * do, on a built deployment whose linked repository is a fork of upstream
 * MixOS. An explicit act: the button opens a dialog that says what will
 * happen, and the dialog's button runs it. The server checks everything again
 * (src/lib/github/update-pull.ts) and opens a pull request; nothing here, or
 * there, merges one.
 */
export default function UpdatePullRequestButton({ offer }: { offer: Extract<UpdateOffer, { kind: "fork" }> }) {
  const [open, setOpen] = useState(false);
  return (
    <div className="space-y-2">
      <Button
        variant="secondary"
        size="sm"
        icon={<GitPullRequest className="h-4 w-4" aria-hidden />}
        disabled={offer.off !== null}
        onClick={() => setOpen(true)}
      >
        Open an update pull request
      </Button>
      {offer.off && (
        <p className="text-muted-foreground">Opening one is off for now. {offer.off}</p>
      )}
      {open && <UpdateDialog offer={offer} onClose={() => setOpen(false)} />}
    </div>
  );
}

const UNREACHED: UpdateOutcome = {
  ok: false,
  code: "error",
  message: "That didn't reach the server. Try again.",
  tone: "warning",
};

function UpdateDialog({ offer, onClose }: { offer: Extract<UpdateOffer, { kind: "fork" }>; onClose: () => void }) {
  const [busy, setBusy] = useState(false);
  const [outcome, setOutcome] = useState<UpdateOutcome | null>(null);
  const router = useRouter();

  const run = async () => {
    setBusy(true);
    try {
      setOutcome(await proposeMixOSUpdateAction({ tag: offer.tag }));
    } catch {
      setOutcome(UNREACHED);
    } finally {
      setBusy(false);
    }
  };
  const close = () => {
    onClose();
    // The notice now says what was opened, from the server's record of it.
    if (outcome?.ok) router.refresh();
  };
  const again = outcome !== null && !outcome.ok && outcome.code === "busy";

  return (
    <Dialog
      open
      onClose={busy ? () => {} : close}
      title={outcome?.ok ? "Pull request opened" : "Open an update pull request"}
      icon={<GitPullRequest className="h-5 w-5" aria-hidden />}
      subtitle={`${offer.tag} · to ${offer.repository}`}
      size="md"
      footer={
        outcome && !again ? (
          <>
            {outcome.ok && (
              <a
                href={outcome.pullRequest.url}
                target="_blank"
                rel="noreferrer noopener"
                className="inline-flex h-9 items-center gap-1.5 rounded-md bg-secondary px-3 text-sm font-medium text-secondary-foreground hover:bg-secondary/80"
              >
                Pull request #{outcome.pullRequest.number}
                <ExternalLink className="h-4 w-4" aria-hidden />
                <span className="sr-only"> (opens in a new tab)</span>
              </a>
            )}
            <Button variant="primary" onClick={close}>
              Done
            </Button>
          </>
        ) : (
          <>
            <Button variant="ghost" onClick={close} disabled={busy}>
              Cancel
            </Button>
            <Button variant="primary" busy={busy} busyLabel="Checking with GitHub…" onClick={run}>
              {again ? "Try again" : "Open pull request"}
            </Button>
          </>
        )
      }
    >
      {outcome ? (
        <Outcome outcome={outcome} />
      ) : (
        <div className="space-y-4 text-sm">
          <p className="text-foreground">
            This creates the branch <code className="font-mono text-xs">{offer.branch}</code> in {offer.repository} at
            the release&apos;s commit, and opens a pull request from it into {offer.defaultBranch}. Nothing is merged:
            merging the pull request is the deploy.
          </p>
          <p className="text-muted-foreground">
            Before it writes anything, the instance asks GitHub, with a read-only token, whether upstream&apos;s tag{" "}
            {offer.tag} is at that commit and on mixoshq/mixos&apos;s main, whether the release changes a workflow,
            which the App can&apos;t push, and whether the branch exists already. If GitHub can&apos;t confirm the
            tag, nothing is opened, and you can merge the release by hand instead.
          </p>
          <dl className="grid grid-cols-1 gap-x-4 gap-y-1 sm:grid-cols-[8rem_1fr] sm:gap-y-2">
            <Row label="Release">{offer.tag}</Row>
            <Row label="Commit">
              <code className="break-all font-mono text-xs">{offer.commitSha}</code>
            </Row>
            <Row label="Branch">
              <code className="break-all font-mono text-xs">{offer.branch}</code>
            </Row>
            <Row label="Into">
              <code className="font-mono text-xs">{offer.defaultBranch}</code>
            </Row>
            <Row label="Title">
              <span className="break-words">{offer.title}</span>
            </Row>
          </dl>
        </div>
      )}
    </Dialog>
  );
}

/** `1 commit`, `2 commits`. Here and not imported: the server module is never bundled for the browser. */
const count = (n: number, one: string) => `${n} ${n === 1 ? one : `${one}s`}`;

function Row({ label, children }: { label: string; children: React.ReactNode }) {
  return (
    <>
      <dt className="text-muted-foreground">{label}</dt>
      <dd className="min-w-0 text-foreground">{children}</dd>
    </>
  );
}

function Outcome({ outcome }: { outcome: UpdateOutcome }) {
  if (outcome.ok) {
    return (
      <div className="space-y-4">
        <Notice tone="success">
          <p className="break-words">{outcome.message}</p>
        </Notice>
        <dl className="grid grid-cols-1 gap-x-4 gap-y-1 text-sm sm:grid-cols-[8rem_1fr] sm:gap-y-2">
          <Row label="Pull request">
            <a href={outcome.pullRequest.url} target="_blank" rel="noreferrer noopener" className="underline underline-offset-2">
              #{outcome.pullRequest.number}
            </a>
          </Row>
          <Row label="Branch">
            <code className="break-all font-mono text-xs">{outcome.pullRequest.branch}</code>
          </Row>
          <Row label="Head commit">
            <code className="break-all font-mono text-xs">{outcome.pullRequest.head}</code>
          </Row>
          <Row label="Against the base">
            {count(outcome.compare.ahead, "commit")} ahead, {outcome.compare.behind} behind,{" "}
            {count(outcome.compare.files, "file")} changed
          </Row>
        </dl>
        <p className="text-sm text-muted-foreground">
          Deployment &gt; GitHub App lists it with its checks. Back up the database before you merge: migrations only go
          forward.
        </p>
      </div>
    );
  }
  return (
    <Notice tone={outcome.tone}>
      <p className="break-words">
        <WithCode text={outcome.message} />
      </p>
      {outcome.links && outcome.links.length > 0 && (
        <p className="mt-2 flex flex-wrap gap-x-4 gap-y-1">
          {outcome.links.map((l) => (
            <a key={l.href} href={l.href} target="_blank" rel="noreferrer noopener" className="underline underline-offset-2">
              {l.label}
            </a>
          ))}
        </p>
      )}
    </Notice>
  );
}
