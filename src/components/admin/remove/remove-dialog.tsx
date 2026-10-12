/* This Source Code Form is subject to the terms of the Mozilla Public
 * License, v. 2.0. If a copy of the MPL was not distributed with this
 * file, You can obtain one at https://mozilla.org/MPL/2.0/. */

"use client";

import { useCallback, useEffect, useRef, useState, type ReactNode } from "react";
import { useRouter } from "next/navigation";
import { Loader2 } from "lucide-react";
import { Dialog } from "@/components/ui/dialog";
import { Button } from "@/components/ui/button";
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
import { KIND_LABEL, type ExtensionKind } from "@/lib/repository/types";
import Notice from "../pending/notice";
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
 * deployment has no checkout, so there it says how removing works instead.
 * Removing checks everything again under its locks, and hands back the commit
 * that deletes the folder.
 *
 * Keeping the data is the default, and the one button here does that. Deleting
 * this checkout's data as well would be a second, visibly different button
 * beside it, destructive and asking for the slug to be typed.
 */
export default function RemoveDialog({
  target,
  onClose,
}: {
  target: RemoveTarget;
  onClose: () => void;
}) {
  const router = useRouter();
  const [preview, setPreview] = useState<PreviewOutcome | null>(null);
  const [busy, setBusy] = useState(false);
  const [outcome, setOutcome] = useState<RemoveOutcome | null>(null);
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

  const remove = useCallback(async () => {
    setBusy(true);
    try {
      setOutcome(await removeExtensionAction({ kind, slug }));
    } finally {
      setBusy(false);
    }
  }, [kind, slug]);

  const close = useCallback(() => {
    // The registry changed: the dev server compiles it on the next request,
    // which this one is, so the page behind no longer lists it.
    if (outcome?.ok) router.refresh();
    onClose();
  }, [outcome, onClose, router]);

  const removed = outcome?.ok === true;
  const refused = outcome?.ok === false && !locked;
  const ready = preview?.ok === true && preview.preview.blockers.length === 0;

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
        ) : (
          <>
            <Button variant="ghost" onClick={close} disabled={busy}>
              Cancel
            </Button>
            {/* Deleting this checkout's data as well goes beside this, as a
                second, destructive button that asks for the slug typed. */}
            <Button variant="primary" busy={busy} busyLabel="Removing…" disabled={!ready} onClick={remove}>
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
        <Notice tone={preview.tone}>
          <WithCode text={preview.message} />
        </Notice>
      ) : (
        <div className="space-y-6">
          <Plan preview={preview.preview} />
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

/** What removing it did, and what comes next: committing the deletion. */
function RemovedResult({ result }: { result: Removed }) {
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

      {result.warnings.length > 0 && (
        <Notice tone="warning">
          <Notes notes={result.warnings} />
        </Notice>
      )}

      <Section title="What stayed">
        <p className="text-sm text-foreground">
          {result.kind === "app"
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
