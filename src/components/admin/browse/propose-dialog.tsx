/* This Source Code Form is subject to the terms of the Mozilla Public
 * License, v. 2.0. If a copy of the MPL was not distributed with this
 * file, You can obtain one at https://mozilla.org/MPL/2.0/. */

"use client";

import { useEffect, useState } from "react";
import { AlertTriangle, CheckCircle2, ExternalLink, GitPullRequest, Loader2, XCircle } from "lucide-react";
import { Dialog } from "@/components/ui/dialog";
import { Button } from "@/components/ui/button";
import { Checkbox } from "@/components/ui/input";
import Notice from "@/components/ui/notice";
import { checkProposalAction, proposeInstallAction } from "@/lib/github/propose-actions";
import type { ProposalCheckLine, ProposalCheckOutcome, ProposalFinding, ProposeOutcome } from "@/lib/github/outcomes";
import { KIND_LABEL, type ExtensionSummary } from "@/lib/repository/types";
import WithCode from "../pending/with-code";
import FloorNotice from "./floor-notice";

/**
 * "Propose to <owner>/<repo>": on a built deployment with the GitHub App
 * linked, Browse opens a pull request instead of installing.
 *
 * It opens on a check that changes nothing: the release, as the catalogue
 * answers for it, the names the pull request will have, and whether the
 * repository lets it be proposed: its branch rule, the preview checklist, its
 * workflows, render.yaml and vercel.json, and no folder or branch of that name
 * already. Proposing does all of that again, and downloads and verifies the
 * release, before it writes anything (src/lib/github/propose.ts).
 *
 * The parent keys it on the extension, so each choice starts fresh. The
 * check lines, the outcome and the rows are shared with the dialog that
 * proposes an update or a removal (../github/propose-change-dialog.tsx).
 */
export default function ProposeDialog({
  extension,
  repository,
  onClose,
}: {
  extension: ExtensionSummary | null;
  /** `owner/name`, for the button and the title. */
  repository: string;
  onClose: () => void;
}) {
  const [check, setCheck] = useState<ProposalCheckOutcome | null>(null);
  const [busy, setBusy] = useState(false);
  const [outcome, setOutcome] = useState<ProposeOutcome | null>(null);
  const [acceptYanked, setAcceptYanked] = useState(false);

  const kind = extension?.kind ?? null;
  const slug = extension?.slug ?? null;

  useEffect(() => {
    if (!kind || !slug) return;
    let live = true;
    void checkProposalAction({ kind, slug })
      .then((res) => {
        if (live) setCheck(res);
      })
      .catch(() => {
        if (live) setCheck({ ok: false, code: "error", message: "That didn't reach the server. Try again.", tone: "warning" });
      });
    return () => {
      live = false;
    };
  }, [kind, slug]);

  if (!extension || !kind || !slug) return null;

  const propose = async () => {
    if (!check?.ok) return;
    setBusy(true);
    try {
      setOutcome(await proposeInstallAction({ kind, slug, version: check.release.version, allowYanked: acceptYanked }));
    } catch {
      setOutcome({ ok: false, code: "error", message: "That didn't reach the server. Try again.", tone: "warning" });
    } finally {
      setBusy(false);
    }
  };

  const ready = check?.ok === true && check.ready && check.floor.met && (!check.release.yanked || acceptYanked);
  const again = outcome !== null && !outcome.ok && outcome.code === "busy";

  return (
    <Dialog
      open
      onClose={busy ? () => {} : onClose}
      title={outcome?.ok ? "Pull request opened" : `Propose ${extension.name}`}
      icon={<GitPullRequest className="h-5 w-5" aria-hidden />}
      subtitle={`${KIND_LABEL[kind].one} · to ${repository}`}
      size="lg"
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
            <Button variant="primary" onClick={onClose}>
              Done
            </Button>
          </>
        ) : (
          <>
            <Button variant="ghost" onClick={onClose} disabled={busy}>
              Cancel
            </Button>
            <Button
              variant="primary"
              busy={busy}
              busyLabel="Verifying and proposing…"
              disabled={!ready}
              onClick={propose}
            >
              {again ? "Try again" : `Propose to ${repository}`}
            </Button>
          </>
        )
      }
    >
      {outcome ? (
        <OutcomePanel outcome={outcome} page={`Admin > ${KIND_LABEL[kind].many}`} />
      ) : check === null ? (
        <p className="flex items-center gap-2 text-sm text-muted-foreground">
          <Loader2 className="h-4 w-4 animate-spin" aria-hidden />
          Checking {repository}, and asking the catalogue about this release…
        </p>
      ) : !check.ok ? (
        <Notice tone={check.tone}>
          <p className="break-words">{check.message}</p>
        </Notice>
      ) : (
        <div className="space-y-5">
          {check.release.yanked && (
            <Notice tone="warning" icon={<AlertTriangle className="h-4 w-4" aria-hidden />}>
              <p className="font-medium">Version {check.release.version} has been withdrawn by its publisher.</p>
              {check.release.yankedReason && <p className="mt-1 break-words">{check.release.yankedReason}</p>}
              <Checkbox
                className="mt-3"
                label="Propose it anyway."
                checked={acceptYanked}
                onChange={(e) => setAcceptYanked(e.target.checked)}
              />
            </Notice>
          )}

          <section>
            <h3 className="text-sm font-semibold text-foreground">What will be proposed</h3>
            <p className="mt-1 text-sm text-muted-foreground">
              Proposing downloads this release from GitHub at the commit below, checks it against the checksum the
              catalogue published, and opens a pull request into {check.defaultBranch}. Nothing runs on this
              instance. Your repository&apos;s checks run on the pull request, and merging it is the deploy.
            </p>
            <dl className="mt-3 grid grid-cols-1 gap-x-4 gap-y-1 text-sm sm:grid-cols-[8rem_1fr] sm:gap-y-2">
              <Row label="Version">
                {check.release.version}
                {check.release.gitTag && <span className="text-muted-foreground"> ({check.release.gitTag})</span>}
              </Row>
              {check.source && (
                <Row label="Source">
                  <a href={check.source.url} target="_blank" rel="noreferrer noopener" className="underline underline-offset-2">
                    {check.source.owner}/{check.source.name}
                  </a>
                </Row>
              )}
              <Row label="Commit">
                <code className="break-all font-mono text-xs">{check.release.commitSha}</code>
              </Row>
              <Row label="Checksum">
                <code className="break-all font-mono text-xs">{check.release.contentHash}</code>
              </Row>
              <Row label="Adds">
                <code className="break-all font-mono text-xs">{check.names.folder}/</code>
              </Row>
              <Row label="Branch">
                <code className="break-all font-mono text-xs">{check.names.branch}</code>
              </Row>
              <Row label="Title">
                <span className="break-words">{check.names.title}</span>
              </Row>
            </dl>
          </section>

          <CheckLines lines={check.lines} ready={check.ready} />

          <FloorNotice floor={check.floor} installable={false} />

          <section>
            <h3 className="text-sm font-semibold text-foreground">What the publisher says it needs</h3>
            <p className="mt-1 text-sm text-muted-foreground">
              Their claims on the listing. What the instance enforces comes from the manifest in the package.
            </p>
            {check.permissions.length === 0 ? (
              <p className="mt-3 text-sm text-muted-foreground">No permissions declared.</p>
            ) : (
              <ul className="mt-3 space-y-2">
                {check.permissions.map((p) => (
                  <li key={p.scope} className="break-words text-sm">
                    <code className="font-mono text-xs text-foreground">{p.scope}</code>
                    <span className="ml-2 text-muted-foreground">{p.reason}</span>
                  </li>
                ))}
              </ul>
            )}
          </section>
        </div>
      )}
    </Dialog>
  );
}

export function Row({ label, children }: { label: string; children: React.ReactNode }) {
  return (
    <>
      <dt className="text-muted-foreground">{label}</dt>
      <dd className="min-w-0 text-foreground">{children}</dd>
    </>
  );
}

/** "Before it can be proposed": each check, holding or not, and what to do when one doesn't. */
export function CheckLines({ lines, ready }: { lines: ProposalCheckLine[]; ready: boolean }) {
  return (
    <section>
      <h3 className="text-sm font-semibold text-foreground">Before it can be proposed</h3>
      <ul className="mt-3 space-y-3">
        {lines.map((line) => (
          <li key={line.id} className="flex gap-2 text-sm">
            {line.ok ? (
              <CheckCircle2 className="mt-0.5 h-4 w-4 shrink-0 text-success" aria-label="Holds" />
            ) : (
              <XCircle className="mt-0.5 h-4 w-4 shrink-0 text-destructive" aria-label="Doesn't hold" />
            )}
            <div className="min-w-0">
              {line.findings ? (
                <>
                  <p className="font-medium text-foreground">{line.label}.</p>
                  <Findings findings={line.findings} />
                  <p className="mt-1 break-words text-muted-foreground">
                    <WithCode text={line.detail} />
                  </p>
                </>
              ) : (
                <p className="text-foreground">
                  <span className="font-medium">{line.label}.</span>{" "}
                  <span className="break-words">
                    <WithCode text={line.detail} />
                  </span>
                </p>
              )}
            </div>
          </li>
        ))}
      </ul>
      {!ready && (
        <p className="mt-3 text-sm text-muted-foreground">
          Fix what doesn&apos;t hold, then open this again. Admin &gt; GitHub has the branch rule and the checklist.
        </p>
      )}
    </section>
  );
}

function Findings({ findings }: { findings: ProposalFinding[] }) {
  return (
    <ul className="mt-1 space-y-1">
      {findings.map((f, i) => (
        <li key={`${f.file}:${i}`} className="break-words text-sm text-foreground">
          <code className="font-mono text-xs">{f.file}</code> {f.problem}
        </li>
      ))}
    </ul>
  );
}

/** What proposing did: the pull request, or why not. */
export function OutcomePanel({ outcome, page }: { outcome: ProposeOutcome; page: string }) {
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
        </dl>
        <p className="text-sm text-muted-foreground">
          {page} lists it with its checks. If its head commit changes there, someone pushed to the branch after
          the App opened it: read those commits before you merge.
        </p>
      </div>
    );
  }
  // The message names each file a check refused, so they aren't listed twice.
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
