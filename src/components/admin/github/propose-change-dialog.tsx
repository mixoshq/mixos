/* This Source Code Form is subject to the terms of the Mozilla Public
 * License, v. 2.0. If a copy of the MPL was not distributed with this
 * file, You can obtain one at https://mozilla.org/MPL/2.0/. */

"use client";

import { useCallback, useEffect, useRef, useState, type ReactNode } from "react";
import { useRouter } from "next/navigation";
import { ExternalLink, GitPullRequest, Loader2 } from "lucide-react";
import { Dialog } from "@/components/ui/dialog";
import { Button } from "@/components/ui/button";
import Notice from "@/components/ui/notice";
import type {
  ChangeAction,
  ChangeProposalCheckOutcome,
  ChangeProposalPreview,
  ProposeOutcome,
  UpdateProposalCompareOutcome,
} from "@/lib/github/outcomes";
import {
  checkChangeProposalAction,
  compareUpdateProposalAction,
  proposeRemovalAction,
  proposeUpdateAction,
} from "@/lib/github/propose-actions";
import type { RemovalNote } from "@/lib/repository/remove";
import { KEPT_DATA } from "@/lib/repository/remove-outcomes";
import { KIND_LABEL, type ExtensionKind } from "@/lib/repository/types";
import type { UpdateOverview } from "@/lib/repository/update-outcomes";
import { CheckLines, OutcomePanel, Row } from "../browse/propose-dialog";
import WithCode from "../pending/with-code";
import { ComparisonView, ReleasePicker } from "../update/update-dialog";
import { FileChanges } from "../update/update-parts";

/** An extension in this build to update or remove, as whatever opens the dialog names it. */
export interface ChangeTarget {
  action: ChangeAction;
  kind: ExtensionKind;
  slug: string;
  /** For the title. The check reads the build's own. */
  name: string;
}

/** The two choices an update's comparison asks for, in this dialog's words. */
const PROPOSE_CHOICES = { older: "Propose an older release.", yanked: "Propose it anyway." };

const UNREACHABLE: Extract<ProposeOutcome, { ok: false }> = {
  ok: false,
  code: "error",
  message: "That didn't reach the server. Try again.",
  tone: "warning",
};

/**
 * "Propose update" and "Propose removal": on a built deployment with the
 * GitHub App linked, a pull request that replaces or deletes the folder of
 * an extension this build runs, where a checkout would update or remove it
 * in place. The notices, the Browse cards of installed extensions and the
 * Remove dialog open it.
 *
 * It opens on a check that changes nothing: what this build runs, whether the
 * default branch holds the same release, the releases to pick from or what
 * depends on it, and the same checks as a proposal. For an update, picking a
 * release downloads it and the one the folder holds, both verified in
 * memory, and shows what changes, as the update dialog does. Proposing does
 * all of that again under the lock before it writes anything
 * (src/lib/github/propose-change.ts).
 */
export default function ProposeChangeDialog({
  target,
  repository,
  onClose,
}: {
  target: ChangeTarget;
  /** `owner/name`, for the button and the title. */
  repository: string;
  onClose: () => void;
}) {
  const router = useRouter();
  const [check, setCheck] = useState<ChangeProposalCheckOutcome | null>(null);
  const [version, setVersion] = useState("");
  const [comparison, setComparison] = useState<UpdateProposalCompareOutcome | null>(null);
  const [older, setOlder] = useState(false);
  const [withdrawn, setWithdrawn] = useState(false);
  const [busy, setBusy] = useState(false);
  const [outcome, setOutcome] = useState<ProposeOutcome | null>(null);
  const asked = useRef("");

  const { action, kind, slug } = target;

  /** Compare with `v`, keeping only the answer for the release picked last. */
  const compare = useCallback(
    async (v: string) => {
      asked.current = v;
      let res: UpdateProposalCompareOutcome;
      try {
        res = await compareUpdateProposalAction({ kind, slug, version: v });
      } catch {
        res = UNREACHABLE;
      }
      if (asked.current === v) setComparison(res);
    },
    [kind, slug],
  );

  useEffect(() => {
    let live = true;
    void checkChangeProposalAction({ action, kind, slug })
      .then((res) => {
        if (!live) return;
        setCheck(res);
        if (res.ok && res.action === "update" && res.suggested) {
          setVersion(res.suggested);
          void compare(res.suggested);
        }
      })
      .catch(() => {
        if (live) setCheck(UNREACHABLE);
      });
    return () => {
      live = false;
    };
  }, [action, kind, slug, compare]);

  const pick = (v: string) => {
    setVersion(v);
    setComparison(null);
    setOutcome(null);
    // What was said yes to was about the release picked before.
    setOlder(false);
    setWithdrawn(false);
    if (v) void compare(v);
  };

  const c = comparison?.ok ? comparison : null;

  const propose = async () => {
    if (!check?.ok) return;
    setBusy(true);
    try {
      if (action === "remove") {
        setOutcome(await proposeRemovalAction({ kind, slug }));
      } else if (c) {
        setOutcome(
          await proposeUpdateAction({
            kind,
            slug,
            version: c.to.version,
            allowYanked: c.needs.allowYanked ? withdrawn : undefined,
            allowOlder: c.needs.allowOlder ? older : undefined,
          }),
        );
      }
    } catch {
      setOutcome(UNREACHABLE);
    } finally {
      setBusy(false);
    }
  };

  const close = useCallback(() => {
    // The page behind lists the App's pull requests.
    if (outcome?.ok) router.refresh();
    onClose();
  }, [outcome, onClose, router]);

  const preview = check?.ok ? check : null;
  const ready =
    preview !== null &&
    preview.ready &&
    (action === "remove" ||
      (c !== null && c.blocker === null && c.floor.met && (!c.needs.allowOlder || older) && (!c.needs.allowYanked || withdrawn)));
  const again = outcome !== null && !outcome.ok && outcome.code === "busy";
  const noun = action === "remove" ? "removal" : "update";
  const page = `Admin > ${KIND_LABEL[kind].many}`;

  return (
    <Dialog
      open
      onClose={busy ? () => {} : close}
      title={outcome?.ok ? "Pull request opened" : `Propose ${noun} of ${target.name}`}
      icon={<GitPullRequest className="h-5 w-5" aria-hidden />}
      subtitle={`${KIND_LABEL[kind].one} · ${slug} · to ${repository}`}
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
            <Button variant="primary" onClick={close}>
              Done
            </Button>
          </>
        ) : (
          <>
            <Button variant="ghost" onClick={close} disabled={busy}>
              Cancel
            </Button>
            <Button
              variant={action === "remove" ? "destructive" : "primary"}
              busy={busy}
              busyLabel={action === "remove" ? "Checking and proposing…" : "Verifying and proposing…"}
              disabled={!ready}
              onClick={propose}
            >
              {again ? "Try again" : `Propose ${noun} to ${repository}`}
            </Button>
          </>
        )
      }
    >
      {outcome ? (
        <OutcomePanel outcome={outcome} page={page} />
      ) : check === null ? (
        <Loading>Checking {repository}, and what this build runs…</Loading>
      ) : !check.ok ? (
        <Notice tone={check.tone}>
          <p className="break-words">
            <WithCode text={check.message} />
          </p>
        </Notice>
      ) : action === "update" ? (
        <UpdateBody
          preview={check}
          version={version}
          onPick={pick}
          comparison={comparison}
          older={older}
          onOlder={setOlder}
          withdrawn={withdrawn}
          onWithdrawn={setWithdrawn}
        />
      ) : (
        <RemovalBody preview={check} />
      )}
    </Dialog>
  );
}

/* -------------------------------------------------------------------------- */
/*  An update                                                                   */
/* -------------------------------------------------------------------------- */

function UpdateBody({
  preview,
  version,
  onPick,
  comparison,
  older,
  onOlder,
  withdrawn,
  onWithdrawn,
}: {
  preview: ChangeProposalPreview;
  version: string;
  onPick: (version: string) => void;
  comparison: UpdateProposalCompareOutcome | null;
  older: boolean;
  onOlder: (yes: boolean) => void;
  withdrawn: boolean;
  onWithdrawn: (yes: boolean) => void;
}) {
  // The update dialog's picker, over what this build runs and the catalogue lists.
  const overview: UpdateOverview = {
    kind: preview.kind,
    slug: preview.slug,
    name: preview.name,
    path: preview.folder,
    host: preview.host,
    installed: preview.installed,
    local: { state: "none" },
    releases: preview.releases,
    listingProblem: preview.listingProblem,
    suggested: preview.suggested,
  };
  return (
    <div className="space-y-6">
      <section>
        <h3 className="text-sm font-semibold text-foreground">What will be proposed</h3>
        <p className="mt-1 text-sm text-muted-foreground">
          Proposing downloads the release you pick and the one <Path>{`${preview.folder}/`}</Path> holds on{" "}
          {preview.defaultBranch}, checks both against the checksums the catalogue published, and opens a pull
          request that replaces the folder, deleting what the new release lacks. Nothing runs on this instance.
          Merging it is the deploy, and reverting the merge is the way back.
        </p>
      </section>

      <ReleasePicker overview={overview} version={version} onPick={onPick} />

      {version &&
        (comparison === null ? (
          <Loading>
            Downloading {version} and the release on {preview.defaultBranch}, and checking both, to compare…
          </Loading>
        ) : !comparison.ok ? (
          <Notice tone={comparison.tone} title={`${version} can't be proposed`}>
            <WithCode text={comparison.message} />
          </Notice>
        ) : (
          <>
            <ComparisonView
              comparison={comparison}
              older={older}
              onOlder={onOlder}
              withdrawn={withdrawn}
              onWithdrawn={onWithdrawn}
              choices={PROPOSE_CHOICES}
            />
            <Section title="What the tree changes">
              <p className="text-xs text-muted-foreground">
                In <Path>{`${preview.folder}/`}</Path>, from the release on {preview.defaultBranch} to {comparison.to.version}.
              </p>
              <div className="mt-2">
                <FileChanges changes={comparison.files} />
              </div>
            </Section>
            <Names branch={comparison.names.branch} title={comparison.names.title} />
          </>
        ))}

      <CheckLines lines={preview.lines} ready={preview.lines.every((l) => l.ok)} />
    </div>
  );
}

/* -------------------------------------------------------------------------- */
/*  A removal                                                                   */
/* -------------------------------------------------------------------------- */

function RemovalBody({ preview }: { preview: ChangeProposalPreview }) {
  const { kind, folder, defaultBranch, installed, onBranch, removal } = preview;
  const blocked = removal !== null && removal.blockers.length > 0;
  return (
    <div className="space-y-6">
      {removal && blocked && (
        <Notice tone="warning" title="It can't be removed yet">
          <Notes notes={removal.blockers} />
        </Notice>
      )}

      <Section title="What goes">
        <ul className="list-disc space-y-1 pl-5 text-sm text-foreground">
          <li>
            Its code: the pull request deletes <Path>{`${folder}/`}</Path> from {defaultBranch}
            {onBranch ? ` (${onBranch.files} ${onBranch.files === 1 ? "file" : "files"})` : ""},{" "}
            <Path>.registry.json</Path> included.
          </li>
          <li>
            It holds {installed.version} from {preview.host}, which this build runs. Its files are checked against that
            release before anything is written.
          </li>
        </ul>
      </Section>

      <Section title="What stays">
        <p className="text-sm text-foreground">
          {KEPT_DATA[kind]}
          {kind !== "theme" &&
            ` Once the merge deploys, ${kind === "app" ? "Admin > Apps" : "Admin > Connectors"} lists it under Not in this build, with Delete data.`}
        </p>
      </Section>

      {removal && !blocked && removal.warnings.length > 0 && (
        <Notice tone="warning" title="Before you propose it">
          <Notes notes={removal.warnings} />
        </Notice>
      )}

      {preview.names.title && <Names branch={preview.names.branch} title={preview.names.title} />}

      <CheckLines lines={preview.lines} ready={preview.lines.every((l) => l.ok)} />

      <Section title="Then">
        <p className="text-sm text-foreground">
          Merging the pull request is the deploy. Rolling back is reverting the merge: nothing is deleted from any
          database, so it is all there when the code returns.
        </p>
      </Section>
    </div>
  );
}

/* -------------------------------------------------------------------------- */
/*  Pieces                                                                      */
/* -------------------------------------------------------------------------- */

function Names({ branch, title }: { branch: string; title: string }) {
  return (
    <dl className="grid grid-cols-1 gap-x-4 gap-y-1 text-sm sm:grid-cols-[8rem_1fr] sm:gap-y-2">
      <Row label="Branch">
        <code className="break-all font-mono text-xs">{branch}</code>
      </Row>
      <Row label="Title">
        <span className="break-words">{title}</span>
      </Row>
    </dl>
  );
}

/** Each note's words, with the apps it names, which are already in them. */
function Notes({ notes }: { notes: RemovalNote[] }) {
  return notes.length === 1 ? (
    <p>
      <WithCode text={notes[0].message} />
    </p>
  ) : (
    <ul className="list-disc space-y-1 pl-5">
      {notes.map((note) => (
        <li key={note.code}>
          <WithCode text={note.message} />
        </li>
      ))}
    </ul>
  );
}

function Loading({ children }: { children: ReactNode }) {
  return (
    <p className="flex items-center gap-2 text-sm text-muted-foreground">
      <Loader2 className="h-4 w-4 shrink-0 animate-spin" aria-hidden />
      <span>{children}</span>
    </p>
  );
}

function Section({ title, children }: { title: string; children: ReactNode }) {
  return (
    <section>
      <h3 className="text-sm font-semibold text-foreground">{title}</h3>
      <div className="mt-2">{children}</div>
    </section>
  );
}

function Path({ children }: { children: ReactNode }) {
  return <code className="break-all font-mono text-xs">{children}</code>;
}
