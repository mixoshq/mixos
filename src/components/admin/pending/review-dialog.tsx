/* This Source Code Form is subject to the terms of the Mozilla Public
 * License, v. 2.0. If a copy of the MPL was not distributed with this
 * file, You can obtain one at https://mozilla.org/MPL/2.0/. */

"use client";

import { useCallback, useEffect, useRef, useState } from "react";
import { useRouter } from "next/navigation";
import { Loader2 } from "lucide-react";
import { Dialog } from "@/components/ui/dialog";
import { Button } from "@/components/ui/button";
import { Checkbox } from "@/components/ui/input";
import type { PendingKind } from "@/lib/repository/pending";
import {
  registerPendingAction,
  reviewPendingAction,
} from "@/lib/repository/pending-actions";
import type {
  ListingFacts,
  RegisterOutcome,
  ReviewOutcome,
} from "@/lib/repository/pending-outcomes";
import type { PendingReview } from "@/lib/repository/review";
import { KIND_LABEL } from "@/lib/repository/types";
import Notice from "./notice";
import RegisterResult from "./register-result";
import ReviewPanel from "./review-panel";
import WithCode from "./with-code";

/** A pending install to review, as a list or the install result names it. */
export interface PendingTarget {
  kind: PendingKind;
  slug: string;
  /** For the title. The review reads the manifest's own. */
  name: string;
}

/**
 * The review prompt, and the only way Register is started from a page.
 *
 * Registering runs the package's code for the first time, so the dialog
 * repeats what will run before it offers the button, and the button waits
 * for the admin to say they have read it. What they read is pinned: Register
 * is sent the files hash the review showed, and refuses a pending install
 * whose record says otherwise.
 *
 * The parent keys it on the target, so each review starts fresh.
 */
export default function ReviewDialog({
  target,
  onClose,
  onRegistered,
}: {
  target: PendingTarget | null;
  onClose: () => void;
  /** Told once it is registered, with its version, so a list can mark it. */
  onRegistered?: (slug: string, version: string) => void;
}) {
  const router = useRouter();
  const [review, setReview] = useState<ReviewOutcome | null>(null);
  const [read, setRead] = useState(false);
  const [busy, setBusy] = useState(false);
  const [outcome, setOutcome] = useState<RegisterOutcome | null>(null);
  const lockedNotice = useRef<HTMLDivElement>(null);

  const kind = target?.kind ?? null;
  const slug = target?.slug ?? null;
  const locked = outcome?.ok === false && outcome.code === "locked";

  // The review is long and the admin is at its end, by the button: bring the
  // reason it didn't happen into view, each time it doesn't.
  useEffect(() => {
    if (locked) lockedNotice.current?.scrollIntoView({ block: "nearest" });
  }, [locked, outcome]);

  useEffect(() => {
    if (!kind || !slug) return;
    let live = true;
    void reviewPendingAction({ kind, slug }).then((res) => {
      if (live) setReview(res);
    });
    return () => {
      live = false;
    };
  }, [kind, slug]);

  const register = useCallback(async () => {
    if (!kind || !slug || !review?.ok) return;
    setBusy(true);
    try {
      const res = await registerPendingAction({
        kind,
        slug,
        reviewedFilesHash: review.review.release.filesHash,
      });
      setOutcome(res);
      if (res.ok) onRegistered?.(slug, res.result.version);
    } finally {
      setBusy(false);
    }
  }, [kind, slug, review, onRegistered]);

  const close = useCallback(() => {
    // The registry changed: the dev server compiles it on the next request,
    // which this one is, so the page behind shows it.
    if (outcome?.ok) router.refresh();
    onClose();
  }, [outcome, onClose, router]);

  if (!target || !kind) return null;

  const registered = outcome?.ok === true;
  const refused = outcome?.ok === false && !locked;
  const ready = review?.ok === true && review.review.problem === null;

  return (
    <Dialog
      open
      onClose={busy ? () => {} : close}
      title={registered ? `${target.name} registered` : `Review ${target.name}`}
      subtitle={`${KIND_LABEL[kind].one} · ${target.slug}`}
      size="lg"
      footer={
        registered || refused ? (
          <Button variant="primary" onClick={close}>
            {registered ? "Done" : "Close"}
          </Button>
        ) : (
          <>
            <Button variant="ghost" onClick={close} disabled={busy}>
              Cancel
            </Button>
            <Button
              variant="primary"
              busy={busy}
              busyLabel="Registering…"
              disabled={!ready || !read}
              onClick={register}
            >
              {locked ? "Try again" : "Register"}
            </Button>
          </>
        )
      }
    >
      {outcome?.ok ? (
        <RegisterResult result={outcome.result} name={target.name} />
      ) : refused && outcome && !outcome.ok ? (
        <div className="space-y-4">
          <Notice tone={outcome.tone} title="Not registered">
            <WithCode text={outcome.message} />
          </Notice>
          {outcome.detail && (
            <pre className="max-h-64 overflow-auto whitespace-pre-wrap break-words rounded-lg border border-border bg-muted p-3 text-xs text-foreground">
              {outcome.detail}
            </pre>
          )}
        </div>
      ) : review === null ? (
        <p className="flex items-center gap-2 text-sm text-muted-foreground">
          <Loader2 className="h-4 w-4 animate-spin" aria-hidden />
          Reading what will run…
        </p>
      ) : !review.ok ? (
        <Notice tone={review.tone}>
          <WithCode text={review.message} />
        </Notice>
      ) : (
        <div className="space-y-6">
          <ReviewPrompt
            review={review.review}
            listing={review.listing}
            read={read}
            onRead={setRead}
          />
          {/* Beside the button that was pressed, where the admin is looking. */}
          {locked && outcome && !outcome.ok && (
            <div ref={lockedNotice}>
              <Notice tone="neutral" title="Not registered yet">
                <WithCode text={outcome.message} />
              </Notice>
            </div>
          )}
        </div>
      )}
    </Dialog>
  );
}

/**
 * The review, then the admin's confirmation that they have read it, which the
 * Register button waits for. A pending install Register would refuse gets no
 * confirmation to give: the review says why instead.
 */
export function ReviewPrompt({
  review,
  listing,
  read,
  onRead,
}: {
  review: PendingReview;
  listing: ListingFacts;
  read: boolean;
  onRead: (read: boolean) => void;
}) {
  return (
    <div className="space-y-6">
      <ReviewPanel review={review} listing={listing} />
      {review.problem === null && (
        <div className="space-y-2 border-t border-border pt-4">
          <Checkbox
            label="I've read what will run, and I want to run it in this checkout."
            checked={read}
            onChange={(e) => onRead(e.target.checked)}
          />
          <p className="text-xs text-muted-foreground">
            Or register it in a terminal in this checkout:{" "}
            <code className="font-mono">
              npm run register -- {review.kind}/{review.slug}
            </code>
          </p>
        </div>
      )}
    </div>
  );
}
