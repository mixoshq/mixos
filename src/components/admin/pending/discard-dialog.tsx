/* This Source Code Form is subject to the terms of the Mozilla Public
 * License, v. 2.0. If a copy of the MPL was not distributed with this
 * file, You can obtain one at https://mozilla.org/MPL/2.0/. */

"use client";

import { useState } from "react";
import { Dialog } from "@/components/ui/dialog";
import { Button } from "@/components/ui/button";
import { discardPendingAction } from "@/lib/repository/pending-actions";
import type { DiscardOutcome } from "@/lib/repository/pending-outcomes";
import { KIND_LABEL } from "@/lib/repository/types";
import Notice from "@/components/ui/notice";
import type { PendingTarget } from "./review-dialog";
import WithCode from "./with-code";

/**
 * Discard a pending install: its folder and its record are deleted, under
 * both locks, and the audit log records it. None of its code has run, so
 * there is nothing else to undo. Asks first.
 */
export default function DiscardDialog({
  target,
  onClose,
}: {
  /** With its folder, repo-relative, to name what is deleted. */
  target: (PendingTarget & { path: string }) | null;
  onClose: () => void;
}) {
  const [busy, setBusy] = useState(false);
  const [outcome, setOutcome] = useState<DiscardOutcome | null>(null);

  if (!target) return null;
  const locked = outcome?.ok === false && outcome.code === "locked";
  const done = outcome !== null && !locked;

  return (
    <Dialog
      open
      onClose={busy ? () => {} : onClose}
      title={outcome?.ok ? `${target.name} discarded` : `Discard ${target.name}?`}
      subtitle={`${KIND_LABEL[target.kind].one} · ${target.slug}`}
      footer={
        done ? (
          <Button variant="primary" onClick={onClose}>
            {outcome?.ok ? "Done" : "Close"}
          </Button>
        ) : (
          <>
            <Button variant="ghost" onClick={onClose} disabled={busy}>
              Cancel
            </Button>
            <Button
              variant="destructive"
              busy={busy}
              busyLabel="Discarding…"
              onClick={async () => {
                setBusy(true);
                try {
                  setOutcome(await discardPendingAction({ kind: target.kind, slug: target.slug }));
                } finally {
                  setBusy(false);
                }
              }}
            >
              {locked ? "Try again" : "Discard"}
            </Button>
          </>
        )
      }
    >
      {outcome?.ok ? (
        <Notice tone="success">
          Deleted <code className="font-mono text-xs">{outcome.pendingPath}/</code> and its
          record. Install it again from Browse to use it.
        </Notice>
      ) : outcome && !outcome.ok ? (
        <Notice tone={outcome.tone} title={locked ? "Not discarded yet" : "Not discarded"}>
          <WithCode text={outcome.message} />
        </Notice>
      ) : (
        <p className="text-sm text-foreground">
          This deletes <code className="font-mono text-xs">{target.path}/</code> and
          its record of what install verified. None of its code has run. Install it
          again from Browse to use it later.
        </p>
      )}
    </Dialog>
  );
}
