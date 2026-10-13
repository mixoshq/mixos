/* This Source Code Form is subject to the terms of the Mozilla Public
 * License, v. 2.0. If a copy of the MPL was not distributed with this
 * file, You can obtain one at https://mozilla.org/MPL/2.0/. */

"use client";

import { useCallback, useEffect, useRef, useState, type ReactNode } from "react";
import { useRouter } from "next/navigation";
import { GitPullRequest, Loader2 } from "lucide-react";
import { Dialog } from "@/components/ui/dialog";
import { Button } from "@/components/ui/button";
import { Field } from "@/components/ui/field";
import { Input } from "@/components/ui/input";
import type { ProposalTarget } from "@/lib/github/outcomes";
import { describeData, type DataDeleteOutcome } from "@/lib/repository/delete-data-outcomes";
import type { RemovalNote } from "@/lib/repository/remove";
import { previewRemovalAction, removeExtensionAction } from "@/lib/repository/remove-actions";
import {
  KEPT_BEFORE,
  KEPT_DATA,
  type PreviewOutcome,
  type RemovalPreview,
  type RemoveOutcome,
  type Removed,
} from "@/lib/repository/remove-outcomes";
import { KIND_LABEL, KIND_SEGMENT, type ExtensionKind } from "@/lib/repository/types";
import Notice from "@/components/ui/notice";
import { Lines } from "../data/delete-data-dialog";
import ProposeChangeDialog from "../github/propose-change-dialog";
import WithCode from "../pending/with-code";
import RemovalHandBackPanel from "./removal-hand-back";

/** An extension to remove, as a tile names it. */
export interface RemoveTarget {
  kind: ExtensionKind;
  slug: string;
  /** For the title. The preview reads the manifest's own. */
  name: string;
}

/**
 * Remove an extension's code from this checkout, from its tile on Admin >
 * Apps, Connectors or Themes. Mounted while it is open, so each one starts
 * fresh, and it stays open while the page behind re-renders without the
 * extension.
 *
 * It says first what goes and what stays: the folder goes from this checkout,
 * and the data stays in each database. It names whatever depends on the
 * extension, and while anything does, there is no button to press. A built
 * deployment has no checkout, so there it says how removing works instead,
 * and with the GitHub App linked offers "Propose removal", which opens a pull
 * request that deletes the folder (../github/propose-change-dialog.tsx).
 * Removing checks everything again under its locks, and hands back the commit
 * that deletes the folder.
 *
 * Keeping the data is the default, and the primary button does that. Beside
 * it, for an app or a connector, is a second, visibly different button:
 * "Remove code and delete this checkout's data", destructive. It opens a last
 * step that says what goes from the database and asks for the slug typed. The
 * server checks the name before removing anything, then deletes the data with
 * Delete data's checks, which can keep the data while the code still goes.
 */
export default function RemoveDialog({
  target,
  propose = null,
  onClose,
}: {
  target: RemoveTarget;
  /** On a built deployment with the GitHub App linked: where a removal can be proposed instead. */
  propose?: ProposalTarget | null;
  onClose: () => void;
}) {
  const router = useRouter();
  const [preview, setPreview] = useState<PreviewOutcome | null>(null);
  /** "Propose removal" was pressed: the proposal's dialog takes this one's place. */
  const [proposing, setProposing] = useState(false);
  const [busy, setBusy] = useState(false);
  const [outcome, setOutcome] = useState<RemoveOutcome | null>(null);
  /** On the last step of "Remove code and delete this checkout's data". */
  const [confirming, setConfirming] = useState(false);
  const [typed, setTyped] = useState("");
  const lockedNotice = useRef<HTMLDivElement>(null);

  const { kind, slug } = target;
  const locked = outcome?.ok === false && outcome.code === "locked";

  useEffect(() => {
    if (locked) lockedNotice.current?.scrollIntoView({ block: "nearest" });
  }, [locked, outcome]);

  useEffect(() => {
    let live = true;
    void previewRemovalAction({ kind, slug }).then((res) => {
      if (live) setPreview(res);
    });
    return () => {
      live = false;
    };
  }, [kind, slug]);

  const confirmed = typed.trim() === slug;

  const remove = useCallback(
    async (deleteData: boolean) => {
      if (busy || (deleteData && !confirmed)) return;
      setBusy(true);
      try {
        setOutcome(
          await removeExtensionAction(
            deleteData ? { kind, slug, deleteData: true, typedSlug: typed.trim() } : { kind, slug },
          ),
        );
      } finally {
        setBusy(false);
      }
    },
    [busy, confirmed, kind, slug, typed],
  );

  const close = useCallback(() => {
    // The registry changed: the dev server compiles it on the next request,
    // which this one is, so the page behind no longer lists it.
    if (outcome?.ok) router.refresh();
    onClose();
  }, [outcome, onClose, router]);

  // The proposal's dialog, in this one's place.
  if (proposing && propose) {
    return (
      <ProposeChangeDialog
        target={{ action: "remove", kind, slug, name: target.name }}
        repository={propose.repository}
        onClose={onClose}
      />
    );
  }

  const removed = outcome?.ok === true;
  const refused = outcome?.ok === false && !locked;
  const ready = preview?.ok === true && preview.preview.blockers.length === 0;
  // The second button: for a kind that keeps data, when this checkout's
  // database can be read. Disabled, with the reason in the body, when it would
  // be refused.
  const data = preview?.ok === true ? preview.preview.data : null;

  return (
    <Dialog
      open
      onClose={busy ? () => {} : close}
      title={removed ? `${target.name} removed` : `Remove ${target.name}?`}
      subtitle={`${KIND_LABEL[kind].one} · ${target.slug}`}
      size="lg"
      footer={
        removed || refused || (preview !== null && !ready) ? (
          <Button variant="primary" onClick={close}>
            {removed ? "Done" : "Close"}
          </Button>
        ) : confirming ? (
          <>
            <Button variant="ghost" onClick={() => setConfirming(false)} disabled={busy}>
              Back
            </Button>
            <Button
              variant="destructive"
              busy={busy}
              busyLabel="Removing…"
              disabled={!confirmed}
              onClick={() => void remove(true)}
            >
              {locked ? "Try again" : "Remove code and delete data"}
            </Button>
          </>
        ) : (
          <>
            <Button variant="ghost" onClick={close} disabled={busy}>
              Cancel
            </Button>
            {data && (
              // Its label is long: on a phone it wraps, and the button grows with it.
              <Button
                variant="destructive"
                disabled={busy || data.refusal !== null}
                onClick={() => setConfirming(true)}
                className="h-auto min-h-10 py-2 text-center"
              >
                Remove code and delete this checkout&apos;s data…
              </Button>
            )}
            <Button variant="primary" busy={busy} busyLabel="Removing…" disabled={!ready} onClick={() => void remove(false)}>
              {locked ? "Try again" : "Remove code, keep data"}
            </Button>
          </>
        )
      }
    >
      {outcome?.ok ? (
        <RemovedResult result={outcome.result} />
      ) : refused && outcome && !outcome.ok ? (
        <div className="space-y-4">
          <Notice tone={outcome.tone} title="Not removed">
            <WithCode text={outcome.message} />
          </Notice>
          {outcome.detail && (
            <pre className="max-h-64 overflow-auto whitespace-pre-wrap break-words rounded-lg border border-border bg-muted p-3 text-xs text-foreground">
              {outcome.detail}
            </pre>
          )}
        </div>
      ) : preview === null ? (
        <p className="flex items-center gap-2 text-sm text-muted-foreground">
          <Loader2 className="h-4 w-4 animate-spin" aria-hidden />
          Checking what depends on it…
        </p>
      ) : !preview.ok ? (
        preview.code === "unsupported-environment" && propose ? (
          <div className="space-y-5">
            <Notice tone={preview.tone}>
              <WithCode text={preview.message} />
            </Notice>
            <Section title="Or propose it">
              <p className="text-sm text-foreground">
                With the GitHub App linked, this deployment can open a pull request on {propose.repository} that
                deletes <code className="font-mono text-xs">{`${KIND_SEGMENT[kind]}/${slug}/`}</code>. It says first what
                depends on it and what stays, and merging it is the deploy.
              </p>
              {propose.off && <p className="mt-2 text-sm text-muted-foreground">{propose.off}</p>}
              <Button
                className="mt-3"
                variant="primary"
                icon={<GitPullRequest className="h-4 w-4" aria-hidden />}
                disabled={propose.off !== null}
                onClick={() => setProposing(true)}
              >
                Propose removal to {propose.repository}
              </Button>
            </Section>
          </div>
        ) : (
          <Notice tone={preview.tone}>
            <WithCode text={preview.message} />
          </Notice>
        )
      ) : (
        <div className="space-y-6">
          {confirming && preview.preview.data ? (
            <ConfirmDelete
              preview={preview.preview}
              typed={typed}
              onType={setTyped}
              onSubmit={() => void remove(true)}
            />
          ) : (
            <Plan preview={preview.preview} />
          )}
          {/* Beside the button that was pressed, where the admin is looking. */}
          {locked && outcome && !outcome.ok && (
            <div ref={lockedNotice}>
              <Notice tone="neutral" title="Not removed yet">
                <WithCode text={outcome.message} />
              </Notice>
            </div>
          )}
        </div>
      )}
    </Dialog>
  );
}

/** What removing it does and keeps, and what stands in its way. */
function Plan({ preview }: { preview: RemovalPreview }) {
  const { kind, path } = preview;
  return (
    <div className="space-y-5">
      {preview.blockers.length > 0 && (
        <Notice tone="warning" title="It can't be removed yet">
          <Notes notes={preview.blockers} />
        </Notice>
      )}

      <Section title="What goes">
        <ul className="list-disc space-y-1 pl-5 text-sm text-foreground">
          <li>
            Its code: <code className="font-mono text-xs">{`${path}/`}</code> is deleted from this
            checkout, and the registry is regenerated without it.
          </li>
          {preview.installed ? (
            <li>
              It was installed from {preview.installed.host} · {preview.installed.version}. Its
              install record, <code className="font-mono text-xs">{`${path}/.registry.json`}</code>, goes
              with it.
            </li>
          ) : null}
          {preview.pending && (
            <li>
              The install waiting in <code className="font-mono text-xs">{`${preview.pending}/`}</code> is
              discarded with it.
            </li>
          )}
          <li>
            Anything in <code className="font-mono text-xs">{`${path}/`}</code> that isn&apos;t committed is
            lost.
          </li>
        </ul>
      </Section>

      <Section title="What stays">
        <p className="text-sm text-foreground">
          {KEPT_BEFORE[kind]}
          {kind === "app" && " Admin > Apps lists it under Not in this build."}
        </p>
        {preview.data?.refusal && (
          <p className="mt-2 text-sm text-muted-foreground">
            It can&apos;t be deleted from this checkout&apos;s database along with its code:{" "}
            <WithCode text={preview.data.refusal.message} />
          </p>
        )}
      </Section>

      {preview.blockers.length === 0 && preview.warnings.length > 0 && (
        <Notice tone="warning" title="Before you remove it">
          <Notes notes={preview.warnings} />
        </Notice>
      )}

      {preview.blockers.length === 0 && (
        <Section title="Then">
          <p className="text-sm text-foreground">
            Commit the deletion and deploy.{kind !== "theme" && ` ${KEPT_DATA[kind]}`}
          </p>
          <p className="mt-2 text-xs text-muted-foreground">
            Or remove it in a terminal in this checkout:{" "}
            <code className="font-mono">{preview.command}</code>
          </p>
        </Section>
      )}
    </div>
  );
}

/** The last step of "Remove code and delete this checkout's data": what goes from where, and the name typed. */
function ConfirmDelete({
  preview,
  typed,
  onType,
  onSubmit,
}: {
  preview: RemovalPreview;
  typed: string;
  onType: (value: string) => void;
  onSubmit: () => void;
}) {
  const data = preview.data!;
  return (
    <div className="space-y-5">
      <Notice tone="danger" title="This can't be undone">
        Its code goes from this checkout, and its data from this checkout&apos;s database. Each other
        database keeps its own copy until an admin deletes it there.
      </Notice>

      <Section title="From this checkout">
        <ul className="list-disc space-y-1 pl-5 text-sm text-foreground">
          <li>
            <code className="font-mono text-xs">{`${preview.path}/`}</code>, and anything in it that isn&apos;t
            committed
          </li>
        </ul>
      </Section>

      <Section title="From this checkout's database">
        <Lines lines={describeData(data.kind, data.counts, data)} />
      </Section>

      <form
        onSubmit={(e) => {
          e.preventDefault();
          onSubmit();
        }}
      >
        <Field label={`Type ${preview.slug} to confirm`}>
          {(field) => (
            <Input
              {...field}
              value={typed}
              onChange={(e) => onType(e.target.value)}
              autoComplete="off"
              autoCapitalize="none"
              spellCheck={false}
              className="font-mono"
            />
          )}
        </Field>
      </form>
    </div>
  );
}

/** What removing it did, and what comes next: committing the deletion. */
function RemovedResult({ result }: { result: Removed }) {
  const dataDeleted = result.data?.ok === true;
  return (
    <div className="space-y-5">
      <Notice tone="success" title={`Removed ${result.path}`}>
        <p>
          The registry no longer has it.{" "}
          {result.servesNow ? (
            "The dev server stops serving it now."
          ) : (
            <>
              This server runs a production build of this checkout, so it serves it until{" "}
              <code className="font-mono text-xs">npm run build</code> and a restart.
            </>
          )}
          {result.discardedPending && (
            <>
              {" "}
              The install waiting in{" "}
              <code className="font-mono text-xs">{`${result.discardedPending}/`}</code> was discarded
              with it.
            </>
          )}
        </p>
      </Notice>

      {result.data && <DataResult data={result.data} kind={result.kind} />}

      {result.warnings.length > 0 && (
        <Notice tone="warning">
          <Notes notes={result.warnings} />
        </Notice>
      )}

      <Section title="What stayed">
        <p className="text-sm text-foreground">
          {dataDeleted
            ? "The audit log, which records the deletion. Each other database keeps its own copy until an admin deletes it there."
            : result.kind === "app"
              ? "Its data is still in this checkout's database, and Admin > Apps lists it under Not in this build."
              : result.kind === "connector"
                ? "Its credentials, and its users' connections, are still in this checkout's database."
                : "A theme holds no data."}
        </p>
      </Section>

      <Section title="Ship it">
        <RemovalHandBackPanel handBack={result.handBack} kind={result.kind} />
      </Section>
    </div>
  );
}

/** What deleting its data, after its code, did: what went, or why it was kept. */
function DataResult({ data, kind }: { data: DataDeleteOutcome; kind: ExtensionKind }) {
  if (data.ok) {
    return (
      <Notice tone="success" title="Its data is deleted from this checkout's database">
        <Lines lines={describeData(data.result.kind, data.result.counts, data.result)} />
      </Notice>
    );
  }
  // These two already say what to do next.
  const saysWhatNext = data.code === "shared-database" || data.code === "still-served";
  return (
    <Notice tone={data.tone === "danger" ? "danger" : "warning"} title="Its data was kept">
      <p>
        <WithCode text={data.message} />
      </p>
      {!saysWhatNext && (
        <p className="mt-2">
          Delete it later with Delete data, under Not in this build on{" "}
          {kind === "app" ? "Admin > Apps" : "Admin > Connectors"}.
        </p>
      )}
    </Notice>
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

function Section({ title, children }: { title: string; children: ReactNode }) {
  return (
    <section>
      <h3 className="text-sm font-semibold text-foreground">{title}</h3>
      <div className="mt-2">{children}</div>
    </section>
  );
}
