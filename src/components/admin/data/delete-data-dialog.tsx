/* This Source Code Form is subject to the terms of the Mozilla Public
 * License, v. 2.0. If a copy of the MPL was not distributed with this
 * file, You can obtain one at https://mozilla.org/MPL/2.0/. */

"use client";

import { useCallback, useEffect, useState, type ReactNode } from "react";
import { useRouter } from "next/navigation";
import { Loader2 } from "lucide-react";
import { Button } from "@/components/ui/button";
import { Dialog } from "@/components/ui/dialog";
import { Field } from "@/components/ui/field";
import { Input } from "@/components/ui/input";
import Notice from "@/components/ui/notice";
import { deleteDataAction, previewDataDeletionAction } from "@/lib/repository/delete-data-actions";
import {
  describeData,
  KEPT_AFTER_DELETE,
  type DataDeleteOutcome,
  type DataKind,
  type DataPreview,
  type DataPreviewOutcome,
} from "@/lib/repository/delete-data-outcomes";
import type { Refusal } from "@/lib/repository/pending-outcomes";
import { KIND_LABEL } from "@/lib/repository/types";
import WithCode from "../pending/with-code";

/** An extension whose data this database keeps, as a Not in this build list names it. */
export interface DataTarget {
  kind: DataKind;
  slug: string;
  name: string;
}

/**
 * Delete what this database keeps for an app or a connector that left the
 * build, from its entry under Not in this build. Mounted while it is open, so
 * each one starts fresh.
 *
 * It says first what goes and what stays, and whether it can be deleted now:
 * the server decides from the database, and refuses while this server's build
 * has it, until a release step has run without it, and while another build
 * that uses this database still has it. Deleting can't be undone, so it asks
 * for the name typed, and the server checks that too.
 */
export default function DeleteDataDialog({ target, onClose }: { target: DataTarget; onClose: () => void }) {
  const router = useRouter();
  const [preview, setPreview] = useState<DataPreviewOutcome | null>(null);
  const [typed, setTyped] = useState("");
  const [busy, setBusy] = useState(false);
  const [outcome, setOutcome] = useState<DataDeleteOutcome | null>(null);
  const { kind, slug } = target;

  useEffect(() => {
    let live = true;
    void previewDataDeletionAction({ kind, slug }).then((res) => {
      if (live) setPreview(res);
    });
    return () => {
      live = false;
    };
  }, [kind, slug]);

  const confirmed = typed.trim() === slug;
  const ready = preview?.ok === true && preview.preview.refusal === null;

  const remove = useCallback(async () => {
    if (!ready || !confirmed || busy) return;
    setBusy(true);
    try {
      setOutcome(await deleteDataAction({ kind, slug, typedSlug: typed.trim() }));
    } finally {
      setBusy(false);
    }
  }, [ready, confirmed, busy, kind, slug, typed]);

  const close = useCallback(() => {
    // The list behind no longer has it.
    if (outcome?.ok) router.refresh();
    onClose();
  }, [outcome, onClose, router]);

  const deleted = outcome?.ok === true;
  const refused = outcome !== null && !outcome.ok;
  const retry = refused && outcome.code === "busy";

  return (
    <Dialog
      open
      onClose={busy ? () => {} : close}
      title={deleted ? `${target.name}'s data deleted` : `Delete ${target.name}'s data?`}
      subtitle={`${KIND_LABEL[kind].one} · ${slug}`}
      size="md"
      footer={
        deleted || (refused && !retry) || (preview !== null && !ready) ? (
          <Button variant="primary" onClick={close}>
            {deleted ? "Done" : "Close"}
          </Button>
        ) : (
          <>
            <Button variant="ghost" onClick={close} disabled={busy}>
              Cancel
            </Button>
            <Button
              variant="destructive"
              busy={busy}
              busyLabel="Deleting…"
              disabled={!ready || !confirmed}
              onClick={remove}
            >
              {retry ? "Try again" : "Delete data"}
            </Button>
          </>
        )
      }
    >
      {deleted && outcome.ok ? (
        <div className="space-y-5">
          <Notice tone="success" title="Deleted from this database">
            <p>Nothing under {slug} is left here for a later extension with the same name to inherit.</p>
          </Notice>
          <Section title="What went">
            <Lines lines={describeData(kind, outcome.result.counts, outcome.result)} />
          </Section>
          <Section title="What stays">
            <p className="text-sm text-foreground">{KEPT_AFTER_DELETE}</p>
          </Section>
        </div>
      ) : preview === null ? (
        <p className="flex items-center gap-2 text-sm text-muted-foreground">
          <Loader2 className="h-4 w-4 animate-spin" aria-hidden />
          Checking what this database keeps…
        </p>
      ) : !preview.ok ? (
        <Notice tone={preview.tone}>
          <WithCode text={preview.message} />
        </Notice>
      ) : (
        <Plan
          preview={preview.preview}
          typed={typed}
          onType={setTyped}
          onSubmit={remove}
          asking={!refused || retry}
          refused={outcome !== null && !outcome.ok ? outcome : null}
        />
      )}
    </Dialog>
  );
}

function Plan({
  preview,
  typed,
  onType,
  onSubmit,
  asking,
  refused,
}: {
  preview: DataPreview;
  typed: string;
  onType: (value: string) => void;
  onSubmit: () => void;
  /** Whether it still asks for the name: not once a deletion was refused, unless to try again. */
  asking: boolean;
  refused: Refusal | null;
}) {
  return (
    <div className="space-y-5">
      {preview.refusal ? (
        <Notice tone={preview.refusal.tone} title="It can't be deleted now">
          <WithCode text={preview.refusal.message} />
        </Notice>
      ) : (
        <Notice tone="danger" title="This can't be undone">
          Its data goes from this database for good. Other databases keep their own copy.
        </Notice>
      )}

      <Section title="What goes">
        <Lines lines={describeData(preview.kind, preview.counts, preview)} />
      </Section>

      <Section title="What stays">
        <p className="text-sm text-foreground">{KEPT_AFTER_DELETE}</p>
      </Section>

      {!preview.refusal && asking && (
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
      )}

      {refused && (
        <Notice tone={refused.tone} title="Not deleted">
          <WithCode text={refused.message} />
        </Notice>
      )}
    </div>
  );
}

/** Each line of what goes or went, with its names as code. */
export function Lines({ lines }: { lines: string[] }) {
  return (
    <ul className="list-disc space-y-1 pl-5 text-sm text-foreground">
      {lines.map((line) => (
        <li key={line}>
          <WithCode text={line} />
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
